# @nolit/dsh-a2ui-plus — 살아 있는 A2UI 워크스페이스

**Language:** [English](README.md) · **한국어**

<!-- skeleton:
version: 1.0
kind: readme
status: active
updated: 2026-11-27
summary: Korean product documentation for @nolit/dsh-a2ui-plus — a bidirectional A2UI 1.0 workspace plugin whose inline summary card and right-sidebar tab stay live off one Surface Store, with STATE_DELTA sync, single-dispatch action dedupe and cross-session isolation.
-->

> **한 번의 호출로 끝나는 스냅샷이 아니라, 대화와 사이드바가 같은 화면을 계속 공유합니다.**
> 대화 안의 요약 카드와 오른쪽 사이드바 탭이 하나의 `Surface Store`를 구독하고,
> `STATE_DELTA`가 도착할 때마다 양쪽이 함께 갱신됩니다.

[![Version](https://img.shields.io/badge/version-0.0.1--rc.2-blue.svg)](./CHANGELOG.md)
[![Protocol](https://img.shields.io/badge/A2UI-1.0-teal.svg)](https://google.github.io/a2ui/)
[![Tests](https://img.shields.io/badge/tests-369%20passed-brightgreen.svg)](./docs/TEST-REPORT.md)

[변경 이력](./CHANGELOG.md) | [아키텍처](./docs/ARCHITECTURE.md) | [이중 뷰 설계](./docs/DUAL-VIEW.md) | [E2E](./docs/E2E.md)

`@nolit/dsh-a2ui-plus`는 Google [A2UI 1.0](https://google.github.io/a2ui/)을 구현한 DeepSeek Harness(DSH) 플러그인입니다.
에이전트가 대화 중에 표·차트·폼·타임라인을 선언하면, 렌더러가 그것을 실제 인터페이스로 그립니다.
차이점은 **그 인터페이스가 계속 살아 있다**는 것입니다:
호출이 끝난 뒤에도 에이전트는 상태를 갱신할 수 있고, 사용자의 조작은 같은 세션의 메시지로 되돌아갑니다.

---

## 1. 정체성 — `dsh-a2ui`와 무엇이 다른가

이 패키지는 [ChimeSky/dsh-a2ui](https://github.com/ChimeSky/dsh-a2ui) `v0.4.0`에서 포크했습니다.
렌더러·카탈로그·검증기는 그대로 물려받았고, **호출 이후의 수명 주기가 다릅니다.**

| | `dsh-a2ui` (업스트림) | `@nolit/dsh-a2ui-plus` (이 패키지) |
| :-- | :-- | :-- |
| 렌더 단위 | 호출 1회 = 독립 스냅샷 | 호출 1회 = **지속되는 surface**, 이후 갱신 가능 |
| 이전 카드 수정 | 의도적으로 미지원 | `STATE_DELTA`로 **지원** |
| 상태 전달 | 도구 결과에 고정 | WebSocket `/a2ui/ws` 다운링크 상시 구독 |
| 사이드바 | 없음 | `dsh-better-sidebar` 탭으로 상시 표시 |
| 대화 카드 | 전체 그래프 | `inline`: 전체 / `sidebar`: **요약 카드** + 탭 |
| 조작 왕복 | 호출 시점 1회 | 클릭 → 사용자 메시지 → 에이전트 턴 → 새 `STATE_DELTA` |

업스트림의 단일 스냅샷 모델은 당시 설계 의도였고, 이 포크는 그 제약을 없앤 것이 아니라 **다른 제품**입니다.
업스트림 문서의 "跨调用修改历史卡片是有意不支持的"는 이 패키지에는 해당하지 않습니다.

### 실시간 동기화의 경로

```text
에이전트 툴 호출 (a2ui)
        │  Host SurfaceStore: revision + epoch 부여
        ├──→ 도구 결과 meta        (지연 없는 첫 렌더, 재생 가능)
        └──→ /a2ui/ws 다운링크      (WebSocket, subprotocol `a2ui-plus.v1`)
                    │
                    ▼
            ClientSurfaceStore  ── ACTIVITY_SNAPSHOT: 교체
             (세션별 1개)         ── STATE_DELTA: RFC 6902 패치
                    │             ── CUSTOM surfaceDeleted: 제거
                    ▼
             ViewAdapter  (뷰 하나뿐인 구독 지점)
                ├──→ inlineModel(surfaceId)  대화 요약 카드
                └──→ fullModel(surfaceId)    사이드바 탭
```

경로 상수는 `src/shared/wire.ts`에 있습니다: `WS_PATH = '/a2ui/ws'`(`:16`),
`WS_PROTOCOL = 'a2ui-plus.v1'`(`:19`), `RPC_CHANNEL = '/a2ui-plus'`(`:10`).
스토어는 스냅샷을 **교체**하고 델타를 **패치**하며(`src/client/surface-store.ts:275`, `:319`),
패치가 3회 연속 실패하면 스스로 resync를 요청합니다(`src/client/socket.ts:30`, 사용 지점 `:151`).

**revision 가드**: 더 새로운 revision만 반영합니다. **epoch 가드**: Host가 재시작해 store 수명이 바뀌면
이전 epoch의 델타는 버리고 스냅샷을 새 기준으로 삼습니다(`src/client/surface-store.ts:287-288`, `:328`).
순서가 뒤바뀌거나 중복된 프레임이 화면을 망칠 수 없는 이유입니다.

---

## 2. 이중 뷰 — `placement`에 따라 카드와 탭이 동시에

`placement: "inline"`(기본)이면 대화 카드가 그래프 전체를 그립니다.
`placement: "sidebar"`이면 **둘 다** 뜹니다:
오른쪽에는 완전한 인터랙티브 탭, 대화에는 제목·핵심 행·컴포넌트 수·`[사이드바에서 열기]`를 담은 **요약 카드**입니다.

### 왜 ViewAdapter를 따로 두는가

뷰가 스토어를 직접 구독하면 두 뷰가 각자 해석하고 각자 전송합니다.
그 구조에서 실제로 났던 결함은 세 가지입니다:
사이드바 표면이 대화에서 빈 안내문으로 대체되던 것, 한 번의 클릭이 두 번 전송될 수 있던 것,
세션 전환을 각 뷰가 알아서 눈치채야 했던 것입니다.

`ViewAdapter`(`src/client/view-adapter.ts:239`)가 그 셋을 한 곳으로 모읍니다.

| 역할 | 구현 |
| :-- | :-- |
| surfaceId 단위 구독 | `subscribeSurface`(`surface-store.ts:246`) + `subscribeInline`/`subscribeFull` |
| 대화용 요약 모델 | `inlineModel(surfaceId)`(`view-adapter.ts:311`) |
| 탭용 전체 모델 | `fullModel(surfaceId)`(`view-adapter.ts:318`) |
| 액션 단일 출구 | `dispatch(request)`(`view-adapter.ts:360`) |
| 탭 열기/포커스 | `openInSidebar(surfaceId)`(`view-adapter.ts:388`) |
| 세션 전환 | `onMountedSessionChanged(next)`(`view-adapter.ts:290`) |

요약 모델은 **전체 그래프를 담지 않습니다.** `placement`가 `sidebar`로 해석되면
`inlineModel`은 `full`을 아예 비웁니다(`view-adapter.ts:311-315`).
같은 대시보드를 두 번 그리는 사고가 타입 수준에서 막혀 있습니다.

### `[사이드바에서 열기]` — 단일 탭 보장

버튼은 `runtime.openSurfaceTab`(`tool-view.tsx:870`) → `adapter.openInSidebar` →
`TabRouter.open`(`tabs.ts:281`) 순으로 이어지고, 시드는 `a2ui:{surfaceId}`입니다(`tabs.ts:43`).

중복 탭을 막는 주체를 정확히 적습니다. better-sidebar의 `openTab`은 **자체적으로 중복을 합치지 않습니다** —
descriptor에 `dedupeKey`/`single`이 있고 시드에 `meta`가 있어야 기존 탭을 재사용합니다
(`dsh-better-sidebar@0.33.0/lib/client.js:1886-1901`).
이 플러그인은 그 셋을 등록하지 않습니다(`tabs.ts:238-246`).
그래서 방어선은 두 개입니다:

1. **플러그인 가드** — `tabIdFor(surfaceId)`가 이미 매핑을 알면 `open` 대신 `update`를 호출합니다(`tabs.ts:262`, 호출 지점 `index.ts:291`, `:413`).
2. **호스트의 seed id 채택** — 같은 `id`로 두 번 열면 한 탭에 착지합니다.

> 2번은 **측정으로 확인했지만 테스트로 고정할 수 없습니다.**
> 격리 홈에서 플러그인 가드를 우회해 `tabs.open()`을 연속 2회 호출한 결과 탭은 **1개**였습니다.
> 다만 그 관측은 브라우저에서만 재현되며, 이 저장소의 단위 스위트에는 호스트 탭 스토어가 없습니다.
> 이 저장소가 소유한 절반 — *모든 open이 `tabIdOf(surfaceId)`를 그대로 전달하고, 시드 빌더가 하나뿐임* — 은
> `tests/tabs.test.mjs`가 고정하고, 뮤테이션으로 검증했습니다.
> **회귀 감지**: `[사이드바에서 열기]`를 두 번 눌렀을 때 탭이 2개면 호스트 쪽 회귀입니다.

### 액션 중복 방지 — 클릭 1회, 전송 1회

두 뷰는 서로 다른 React 트리이므로 각자 클릭 핸들러를 가집니다.
React가 둘째 클릭을 막아 주지 않습니다.
막는 것은 `dispatch`의 멱등 창 하나입니다:

```text
카드 버튼 ─┐
           ├─→ adapter.dispatch({ surfaceId, sourceComponentId, actionId, … })
탭 버튼  ─┘        ├─ 세션이 다르면        → cross-session (전송 안 함)
                   ├─ 같은 삼중키 200ms 내 → duplicate     (전송 안 함)
                   └─ 그 외               → send
```

`ACTION_DEDUPE_MS = 200`(`view-adapter.ts:29`). 키는 `surfaceId + sourceComponentId + actionId` 전체입니다.
전송이 **실패**하면 멱등 항목을 지워, 재시도가 창에 삼켜지지 않습니다(`view-adapter.ts:374`).
중복은 실패가 아니므로 첫 클릭과 같은 `sent` 상태로 표시합니다 — 세 번째 클릭을 유도하지 않기 위해서입니다.

---

## 3. 세션 격리와 보안 가드레일

### 단일 리졸버

사이드바 탭 본문은 `sessionId` **없이** 마운트됩니다.
그래서 "어느 세션인가"를 판단하는 지점이 필요하고, 그 지점은 **하나뿐**입니다:
`sessionFor(sessionId)`(`index.ts:263`).
뷰도, 스토어 접근자도 스스로 해석하지 않습니다.
과거에는 두 곳에서 해석해, 한쪽을 지워도 다른 쪽이 조용히 가려 주는 구조였습니다.

### 교차 세션 누출 차단

| 경로 | 가드 |
| :-- | :-- |
| 탭 열기 | 화면 세션과 다르면 열지 않음 — `index.ts:277` |
| 스토어 읽기 | 화면 세션과 다르면 넘겨주지 않음 — `index.ts:393` |
| 거절된 읽기 | 공유 `EMPTY_STORE`(`index.ts:155`)를 돌려줌 — 표면을 위조하지 않음(`index.ts:444`) |
| 세션 전환 | 구독 전량 해제 → 이전 세션 소유 목록 삭제 → 새 세션 추적(`view-adapter.ts:290-306`) |

전환 순서가 계약입니다: **해제가 추적보다 먼저**입니다.
그래서 이전 세션의 늦은 프레임이 도착해도 구독이 없어 아무것도 다시 그리지 못합니다.
테스트는 구독 수를 실제로 세어 이전 세션이 0임을 확인합니다.

### A2UI 1.0 검증과 쿼터

payload는 렌더 전에 스키마로 검증합니다(`src/shared/validate.ts`).
위반은 화면을 비우지 않고 읽을 수 있는 오류로 낮춥니다.
주요 상한(`src/shared/limits.ts`): 메시지 32 · 메시지당 컴포넌트 300 · surface당 400 ·
호출당 surface 16 · payload 384,000자 · 깊이 64 · 확장 노드 4,000 · 문자열 16,384자 · 표 500행 · 계열점 500.
Host와 렌더러가 **같은** 검증기를 씁니다.

### 미디어·URL

- 스킴은 패턴 매칭이 아니라 **파싱**으로 판정합니다. `https:` 외에는 거부합니다(`src/client/executor.ts:149`).
- `Image`는 `http(s)`와 `data:image/*`만 허용하고, 그 밖의 소스는 표시하지 않습니다(`src/shared/url.ts`).
- `openUrl`·`copyToClipboard`·`downloadFile`·`requestFilePicker`는 **gesture 바인딩**입니다.
  실제 사용자 활성화(`navigator.userActivation.isActive`)와 명시적 확인 **둘 다** 필요합니다(`executor.ts:17-18`).
  모델이 붙인 `gesture: true` 플래그는 근거로 인정되지 않습니다.

### 실행 코드 없음

이 패키지의 `src/`에는 `eval`도 `dangerouslySetInnerHTML`도 **없습니다**.
텍스트는 React 텍스트 노드로만 렌더되며, 마크다운도 DOM 노드를 직접 만들어 조립합니다(`src/client/markdown.tsx:6`).
표현식은 닫힌 문법만 평가합니다(`src/shared/expression.ts`).

---

## 4. 컴포넌트 카탈로그와 바인딩

카탈로그 ID는 `dsh-a2ui/catalog/v1`입니다. 총 **31개** 컴포넌트 — A2UI 1.0 기본 18개 + 확장 13개.

**기본 18개** (`src/shared/catalog.ts`, `origin: 'basic'`)

`Text` `Image` `Icon` `Video` `AudioPlayer` `Row` `Column` `List` `Card` `Tabs`
`Modal` `Divider` `Button` `TextField` `CheckBox` `ChoicePicker` `Slider` `DateTimeInput`

**확장 13개** (`origin: 'extension'`)

| 컴포넌트 | 용도 |
| :-- | :-- |
| `Table` | 정렬 가능한 표, 행 수 상한 500 |
| `BarChart` / `LineChart` / `PieChart` | 막대·선·원 그래프, 범례 토글 |
| `ParetoChart` | 누적 비율을 함께 보는 파레토 차트 |
| `RadarChart` | 다축 프로파일 비교 |
| `Heatmap` | 2축 행렬, 결측 셀 유지 |
| `Plot` | 함수식·산점도, 선형 적합 |
| `Stat` | KPI 타일(라벨·값·단위·증감) |
| `Progress` | 목표 대비 진행률 |
| `FramePlayer` | 단계·알고리즘 재생 |
| `Timeline` | 사건의 시간순 나열 |
| `Section` | 짧은 내용 묶음 |

**함수 6개**: `openUrl` `scrollTo` `copyToClipboard` `downloadFile` `validateForm` `requestFilePicker`.
전체 레퍼런스는 `a2ui_catalog` 도구가 런타임에 반환합니다.

### 데이터 바인딩

| 표기 | 의미 |
| :-- | :-- |
| `{"@path": "/user/name"}` | surface 데이터모델의 JSON Pointer 참조 |
| `{"@call": "formatNumber", "args": {…}}` | 닫힌 함수 표에서 하나를 선택 |
| `"itemLabel"` (템플릿 내부) | 반복 항목 기준 상대 경로 |

바인딩은 문자열을 **실행하지 않습니다**. `@call`은 등록된 함수 이름만 고를 수 있습니다.

---

## 5. 설치와 사용

```bash
# DSH UI — 플러그인 → 추가 → 패키지 이름 입력
# 또는 CLI
dsh plugin --profile web add @nolit/dsh-a2ui-plus
```

프로필을 재시작한 뒤 평소처럼 질문하면 됩니다.
에이전트가 답을 인터페이스로 전달하는 편이 낫다고 판단하면 `a2ui` 도구를 호출합니다.

`placement` 인자로 위치를 고릅니다:

- `inline`(기본) — 대화 안에 그립니다.
- `sidebar` — 오른쪽 탭에 전체를, 대화에는 요약 카드를 그립니다.
  `dsh-better-sidebar`가 없으면 요약 카드만 남고 탭은 열리지 않습니다(기능은 유지).
  폭 768px 미만에서는 탭을 열지 않고 `inline`으로 낮춥니다(`surface-store.ts:86`).

---

## 6. 개발과 게이트

```bash
npm run typecheck   # tsc --noEmit
npm run build       # src/ → lib/ + client.js (번들러 없이 인프로세스)
npm run check:wires # 죽은 배선 게이트: 계약의 모든 멤버에 리더가 있는가
npm test            # check:wires + 전체 스위트
npm run verify      # 번들 불변식
npm run render      # React 렌더 케이스
npm run test:e2e    # 실제 브라우저 (E2E_URL 필요, docs/E2E.md)
```

측정된 현재 값: `check:wires` 11개 멤버 전부 리더 있음 · `npm test` **369 pass** · `verify` 32 불변식 · `render` 19 케이스.

### 죽은 배선 게이트가 존재하는 이유

이 트랙에는 같은 모양의 결함이 세 번 있었습니다: 선언되고, 할당되고, **아무도 읽지 않은** 함수.
`registerTab`은 한 번 찔러보고 포기했고, `openSurfaceTab`과 `connectDownlink`은 호출자가 없었습니다.
단위 테스트는 전부 통과했습니다 — 테스트는 무엇이든 호출할 수 있으니까요.
그래서 `scripts/check-dead-wires.mjs`가 `ClientRuntime`의 모든 멤버에 **할당 줄 밖의 리더**가 있는지 검사하고,
없으면 `npm test`가 먼저 실패합니다.

---

## 7. 알려진 한계 (검증 상태를 숨기지 않습니다)

| 항목 | 상태 | 반증 방법 |
| :-- | :-- | :-- |
| 이중 뷰 동시 렌더 | 브라우저 E2E 12케이스 통과 | `placement:"sidebar"` 호출 후 대화 카드가 비면 `view-adapter.ts`의 `inlineModel` |
| 클릭 1회 = 전송 1회 | 단위 + DOM + 뮤테이션 검증 | 카드와 탭의 같은 버튼을 200ms 안에 두 번 → 메시지 2개면 `dispatch` 멱등 창 |
| seed id 단일 탭 | **측정만** (테스트 불가) | `[사이드바에서 열기]` 두 번 → 탭 2개면 호스트 회귀 |
| 호스트 주도 세션 전환 | **미검증** — E2E는 콜백을 직접 호출 | A에 surface를 띄우고 B로 전환 → A가 B에 보이면 `index.ts` `followMountedSession` |
| 실제 모델 턴의 sidebar 표면 | **미검증** — 픽스처로만 확인 | 실제 호출 후 카드가 비면 `view-adapter.ts` |

`docs/DUAL-VIEW.md`는 각 주장을 **[MEASURED] / [TYPE-COMMENT] / [CODE]** 로 구분해 표기합니다.
타입 주석(`.d.ts`)은 **의도**이지 동작이 아니므로, 이 문서는 둘을 섞지 않습니다.

---

## 8. 라이선스와 출처

| 대상 | 라이선스 |
| :-- | :-- |
| 이 저장소 (`@nolit/dsh-a2ui-plus`) | **MIT** — [LICENSE](./LICENSE) |
| 업스트림 [ChimeSky/dsh-a2ui](https://github.com/ChimeSky/dsh-a2ui) `v0.4.0` | 원 저작자 고지 유지 — [NOTICE](./NOTICE) |
| Google [A2UI 1.0](https://google.github.io/a2ui/) 스펙·스키마 | **Apache-2.0** |

포크 이래의 변경은 [CHANGELOG.md](./CHANGELOG.md)에 단계별로 기록되어 있습니다.
업스트림 0.4.0 노트는 상속된 기준선으로 그 아래에 보존했습니다.


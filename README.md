# @nolit/dsh-a2ui-plus — a live A2UI workspace

**Language:** **English** · [한국어](README.ko.md)

<!-- skeleton:
version: 1.0
kind: readme
status: active
updated: 2026-11-27
summary: English product documentation for @nolit/dsh-a2ui-plus — a bidirectional A2UI 1.0 workspace plugin whose inline summary card and right-sidebar tab stay live off one Surface Store, with STATE_DELTA sync, single-dispatch action dedupe and cross-session isolation.
-->

> **Not a snapshot that ends with its call.** The summary card in the conversation
> and the tab in the right sidebar subscribe to one `Surface Store`, and every
> `STATE_DELTA` that arrives repaints both.

[![Version](https://img.shields.io/badge/version-0.0.1--rc.2-blue.svg)](./CHANGELOG.md)
[![Protocol](https://img.shields.io/badge/A2UI-1.0-teal.svg)](https://google.github.io/a2ui/)
[![Tests](https://img.shields.io/badge/tests-369%20passed-brightgreen.svg)](./docs/TEST-REPORT.md)

[Changelog](./CHANGELOG.md) | [Architecture](./docs/ARCHITECTURE.md) | [Dual-view design](./docs/DUAL-VIEW.md) | [E2E](./docs/E2E.md)

`@nolit/dsh-a2ui-plus` is a DeepSeek Harness (DSH) plugin implementing Google
[A2UI 1.0](https://google.github.io/a2ui/). The agent declares tables, charts, forms and
timelines mid-conversation, and the renderer draws them as real interfaces. The difference
is that **the interface stays alive**: after the call settles the agent can keep updating
its state, and a user's interaction returns to the same session as an ordinary message.

---

## 1. Identity — how this differs from `dsh-a2ui`

This package is forked from [ChimeSky/dsh-a2ui](https://github.com/ChimeSky/dsh-a2ui) `v0.4.0`.
The renderer, catalog and validator are inherited unchanged; **the life cycle after the call
is different.**

| | `dsh-a2ui` (upstream) | `@nolit/dsh-a2ui-plus` (this package) |
| :-- | :-- | :-- |
| Render unit | one call = one standalone snapshot | one call = a **persistent surface**, updatable afterwards |
| Updating an earlier card | deliberately unsupported | **supported** through `STATE_DELTA` |
| State delivery | fixed in the tool result | a standing subscription to the `/a2ui/ws` downlink |
| Sidebar | none | a persistent `dsh-better-sidebar` tab |
| Conversation card | the full graph | `inline`: full · `sidebar`: a **summary card** beside the tab |
| Interaction round trip | once, at call time | click → user message → agent turn → a new `STATE_DELTA` |

The upstream single-snapshot model was that generation's design decision. This fork is not
the same product with a limitation removed — it is **a different product**. Upstream's
"跨调用修改历史卡片是有意不支持的" does not apply here.

### The real-time path

```text
agent tool call (a2ui)
        │  Host SurfaceStore: assigns revision + epoch
        ├──→ tool result meta        (first paint without delay, replayable)
        └──→ /a2ui/ws downlink       (WebSocket, subprotocol `a2ui-plus.v1`)
                    │
                    ▼
            ClientSurfaceStore  ── ACTIVITY_SNAPSHOT: replace
             (one per session)    ── STATE_DELTA: RFC 6902 patch
                    │             ── CUSTOM surfaceDeleted: remove
                    ▼
             ViewAdapter  (the only subscription point a view has)
                ├──→ inlineModel(surfaceId)  conversation summary card
                └──→ fullModel(surfaceId)    sidebar tab
```

The path constants live in `src/shared/wire.ts`: `WS_PATH = '/a2ui/ws'` (`:16`),
`WS_PROTOCOL = 'a2ui-plus.v1'` (`:19`), `RPC_CHANNEL = '/a2ui-plus'` (`:10`).
The store **replaces** on a snapshot and **patches** on a delta
(`src/client/surface-store.ts:275`, `:319`), and asks for a resync itself after three
consecutive unapplicable patches (`src/client/socket.ts:30`, used at `:151`).

**Revision guard**: only a newer revision is applied. **Epoch guard**: when the Host restarts
and its store lifetime changes, deltas from the old epoch are dropped and the snapshot becomes
the new baseline (`src/client/surface-store.ts:287-288`, `:328`). That is why a re-ordered or
duplicated frame cannot corrupt the screen.

---

## 2. Dual view — a card and a tab at the same time

With `placement: "inline"` (the default) the conversation card draws the whole graph.
With `placement: "sidebar"` **both** appear: a fully interactive tab on the right, and in the
conversation a **summary card** carrying the title, a few key rows, the component count and
`[Open in sidebar]`.

### Why there is a ViewAdapter layer

When each view subscribes to the store itself, two views interpret independently and send
independently. Three defects came from exactly that shape: a sidebar surface replaced by an
empty notice in the conversation, one click that could be sent twice, and a session switch
that each view had to notice on its own.

`ViewAdapter` (`src/client/view-adapter.ts:239`) collects all three into one place.

| Role | Implementation |
| :-- | :-- |
| Per-surface subscription | `subscribeSurface` (`surface-store.ts:246`) + `subscribeInline`/`subscribeFull` |
| Conversation summary model | `inlineModel(surfaceId)` (`view-adapter.ts:311`) |
| Tab full model | `fullModel(surfaceId)` (`view-adapter.ts:318`) |
| Single action exit | `dispatch(request)` (`view-adapter.ts:360`) |
| Open / focus the tab | `openInSidebar(surfaceId)` (`view-adapter.ts:388`) |
| Session switch | `onMountedSessionChanged(next)` (`view-adapter.ts:290`) |

The summary model **does not carry the full graph.** When `placement` resolves to `sidebar`,
`inlineModel` leaves `full` unset altogether (`view-adapter.ts:311-315`). Drawing the same
dashboard twice is prevented at the type level.

### `[Open in sidebar]` — one tab per surface

The button goes `runtime.openSurfaceTab` (`tool-view.tsx:870`) → `adapter.openInSidebar` →
`TabRouter.open` (`tabs.ts:281`), and the seed id is `a2ui:{surfaceId}` (`tabs.ts:43`).

State precisely who prevents duplicates. better-sidebar's `openTab` does **not** collapse
duplicates itself: it reuses an open tab only when the descriptor supplies `dedupeKey`/`single`
**and** the seed carries `meta` (`dsh-better-sidebar@0.33.0/lib/client.js:1886-1901`).
This plugin registers none of those (`tabs.ts:238-246`). So there are two guards:

1. **The plugin guard** — `tabIdFor(surfaceId)` calls `update` instead of `open` when the
   mapping already exists (`tabs.ts:262`; call sites `index.ts:291`, `:413`).
2. **The host honouring the seed id** — two opens with the same `id` land on one tab.

> Guard 2 is **measured but not testable here.** Bypassing the plugin guard in an isolated
> home and calling `tabs.open()` twice in a row produced **one** tab, not two. That observation
> is reproducible only in a browser: the unit suite has no host tab store.
> The half this repository owns — *every open forwards `tabIdOf(surfaceId)` untouched, and
> there is exactly one seed builder* — is pinned by `tests/tabs.test.mjs` and
> mutation-checked. **Regression signal**: two tabs after pressing `[Open in sidebar]` twice.

### Action dedupe — one click, one send

The two views are separate React trees, so each has its own click handler. React does not
stop the second one. One idempotency window in `dispatch` does:

```text
card button ─┐
             ├─→ adapter.dispatch({ surfaceId, sourceComponentId, actionId, … })
tab button  ─┘        ├─ session differs        → cross-session (not sent)
                      ├─ same triple within 200ms → duplicate    (not sent)
                      └─ otherwise              → send
```

`ACTION_DEDUPE_MS = 200` (`view-adapter.ts:29`). The key is the whole triple
`surfaceId + sourceComponentId + actionId`. A **failed** send clears its entry, so a retry is
never swallowed by the window (`view-adapter.ts:374`). A duplicate is not a failure, so it
shows the same `sent` state as the first click — rather than inviting a third.

---

## 3. Session isolation and security guardrails

### One resolver

A sidebar tab body is mounted **without** a `sessionId`. So something has to decide "which
session is this", and that something is **exactly one** function: `sessionFor(sessionId)`
(`index.ts:263`). Neither the view nor the store accessor resolves on its own. It used to be
resolved in two places, so removing either one left the other silently covering for it.

### Cross-session leakage is blocked on every path

| Path | Guard |
| :-- | :-- |
| Opening a tab | refuses a session that is not on screen — `index.ts:277` |
| Reading a store | refuses to hand one out — `index.ts:393` |
| A refused read | returns the shared `EMPTY_STORE` (`index.ts:155`) — never fabricates a surface (`index.ts:444`) |
| A session switch | release every subscription → drop the old session's owned set → track the new one (`view-adapter.ts:290-306`) |

The order is the contract: **release before track.** That is why a late frame for the previous
session repaints nothing — there is no subscription left to deliver it to. The test counts the
real subscriptions and asserts the old session holds zero.

### A2UI 1.0 validation and quotas

Payloads are schema-validated before rendering (`src/shared/validate.ts`). A violation
degrades to readable errors rather than a blank screen. Main caps (`src/shared/limits.ts`):
32 messages · 300 components per message · 400 per surface · 16 surfaces per call ·
384,000 payload characters · depth 64 · 4,000 expanded nodes · 16,384 characters per string ·
500 table rows · 500 series points. The Host and the renderer run **the same** validator.

### Media and URLs

- A scheme is decided by **parsing**, not pattern matching. Anything but `https:` is refused
  (`src/client/executor.ts:149`).
- `Image` accepts only `http(s)` and `data:image/*`; every other source is not displayed
  (`src/shared/url.ts`).
- `openUrl`, `copyToClipboard`, `downloadFile` and `requestFilePicker` are **gesture-bound**.
  They require *both* a live user activation (`navigator.userActivation.isActive`) *and* an
  explicit confirmation (`executor.ts:17-18`). A `gesture: true` flag attached by the model is
  not accepted as proof.

### No executing code

This package's `src/` contains **no** `eval` and **no** `dangerouslySetInnerHTML`. Text renders
only as React text nodes, and markdown is assembled from DOM nodes it builds itself
(`src/client/markdown.tsx:6`). Expressions evaluate a closed grammar only
(`src/shared/expression.ts`).

---

## 4. Component catalog and bindings

The catalog id is `dsh-a2ui/catalog/v1`. **31** components — 18 A2UI 1.0 basic plus 13 extended.

**Basic 18** (`src/shared/catalog.ts`, `origin: 'basic'`)

`Text` `Image` `Icon` `Video` `AudioPlayer` `Row` `Column` `List` `Card` `Tabs`
`Modal` `Divider` `Button` `TextField` `CheckBox` `ChoicePicker` `Slider` `DateTimeInput`

**Extended 13** (`origin: 'extension'`)

| Component | Purpose |
| :-- | :-- |
| `Table` | sortable table, 500-row cap |
| `BarChart` / `LineChart` / `PieChart` | bar, line and pie charts with legend toggling |
| `ParetoChart` | ranked shares with a cumulative line |
| `RadarChart` | multi-axis profile comparison |
| `Heatmap` | two-axis matrix, missing cells preserved |
| `Plot` | function and scatter plots, linear fit |
| `Stat` | KPI tile (label, value, unit, delta) |
| `Progress` | progress against a target |
| `FramePlayer` | step or algorithm playback |
| `Timeline` | events in time order |
| `Section` | a short content group |

**Six functions**: `openUrl` `scrollTo` `copyToClipboard` `downloadFile` `validateForm`
`requestFilePicker`. The `a2ui_catalog` tool returns the full reference at runtime.

### Data binding

| Form | Meaning |
| :-- | :-- |
| `{"@path": "/user/name"}` | a JSON Pointer into the surface's data model |
| `{"@call": "formatNumber", "args": {…}}` | selects one entry of the closed function table |
| `"itemLabel"` (inside a template) | a relative path against the repeated item |

A binding **never executes a string**. `@call` can only name a registered function.

---

## 5. Install and use

```bash
# DSH UI — Plugins → Add → enter the package name
# or the CLI
dsh plugin --profile web add @nolit/dsh-a2ui-plus
```

Restart the profile, then ask as usual. The agent calls the `a2ui` tool when it judges that
an interface conveys the answer better than prose.

`placement` chooses where:

- `inline` (default) — draws inside the conversation.
- `sidebar` — the full interface in a right-hand tab, a summary card in the conversation.
  Without `dsh-better-sidebar` only the summary card remains and no tab opens; the feature
  still works. Below 768px the tab is not opened and the placement degrades to `inline`
  (`surface-store.ts:86`).

---

## 6. Development and gates

```bash
npm run typecheck   # tsc --noEmit
npm run build       # src/ → lib/ + client.js (in-process, no bundler)
npm run check:wires # dead-wire gate: does every contract member have a reader?
npm test            # check:wires + the whole suite
npm run verify      # bundle invariants
npm run render      # React render cases
npm run test:e2e    # real browser (needs E2E_URL, see docs/E2E.md)
```

Measured current values: `check:wires` 11 members, every one has a reader · `npm test`
**369 pass** · `verify` 32 invariants · `render` 19 cases.

### Why the dead-wire gate exists

This track had the same defect shape three times: a function declared, assigned, and **read
by nobody**. `registerTab` probed once and gave up; `openSurfaceTab` and `connectDownlink` had
no callers at all. Every unit test passed — a test can call anything.
So `scripts/check-dead-wires.mjs` checks that every `ClientRuntime` member has a reader
**outside its own assignment line**, and `npm test` fails first when one does not.

---

## 7. Known limits (verification state is not hidden)

| Item | State | Falsify by |
| :-- | :-- | :-- |
| Dual view rendered together | 12 browser E2E cases pass | after a `placement:"sidebar"` call, an empty conversation card means `inlineModel` in `view-adapter.ts` |
| One click = one send | unit + DOM + mutation checked | click the same button in card and tab within 200ms → two messages means the `dispatch` window |
| One tab per seed id | **measured only** (not testable here) | press `[Open in sidebar]` twice → two tabs means a host regression |
| Host-driven session switch | **unverified** — E2E invokes the callback directly | raise a surface in A, switch to B → A visible in B means `followMountedSession` in `index.ts` |
| A real model turn's sidebar surface | **unverified** — confirmed with fixtures only | after a real call, an empty card means `view-adapter.ts` |

`docs/DUAL-VIEW.md` labels every claim **[MEASURED] / [TYPE-COMMENT] / [CODE]**. A `.d.ts`
comment states **intent**, not behaviour, and that document does not blur the two.

---

## 8. Licence and attribution

| Subject | Licence |
| :-- | :-- |
| This repository (`@nolit/dsh-a2ui-plus`) | **MIT** — [LICENSE](./LICENSE) |
| Upstream [ChimeSky/dsh-a2ui](https://github.com/ChimeSky/dsh-a2ui) `v0.4.0` | original notices retained — [NOTICE](./NOTICE) |
| Google [A2UI 1.0](https://google.github.io/a2ui/) spec and schema | **Apache-2.0** |

Changes since the fork are recorded step by step in [CHANGELOG.md](./CHANGELOG.md).
The upstream 0.4.0 notes are kept below them as the inherited baseline.

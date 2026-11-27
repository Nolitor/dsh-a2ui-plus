# Changelog

<!-- skeleton:
version: 0.9.0
kind: report
status: active
updated: 2026-11-27
summary: Version history for @nolit/dsh-a2ui-plus, forked from dsh-a2ui 0.4.0: locale and preset scoping, the out-of-turn transport, the Host Surface Store with STATE_DELTA, sidebar tab routing and the renderer-function allowlist.
-->

All notable changes to this plugin. Version numbers follow [SemVer](https://semver.org/); the
`engines.dsh` range states which DeepSeek Harness releases a version was verified against.

## Unreleased — fork from `dsh-a2ui` 0.4.0

Forked as `@nolit/dsh-a2ui-plus` `0.0.1-rc.1`. Upstream 0.4.0 notes below are retained as the
inherited baseline; every entry above them is this fork's own history.

### Step 17 — the two views are two models, and the README now says so

"Dual view" was imprecise enough to be wrong. It read as *two panes showing the same thing*, when
the actual design is **one surface with two different representations**: a condensed card in the
conversation and the full interactive graph in the sidebar tab. The distinction matters because it
is the reason the package exists, and the README described the mechanism without the point.

- **Both READMEs rewritten at §2.** New title ("Two views of one surface — and they are not the
  same view" / "하나의 surface, 두 개의 뷰 — 그리고 그 둘은 같은 뷰가 아닙니다"), a layer diagram
  showing `ViewAdapter` fanning out to `inlineModel` and `fullModel`, and a table comparing what
  each model carries.
- **The `placement` role table is new.** It states the part that was missing entirely:
  `placement` decides the card's *role*, not merely its location. `inline` → the card holds the
  graph (`condensed: false`); `sidebar` → the card is the summary and the tab holds the graph
  (`condensed: true`); `sidebar` below 768px → the card holds the graph again and no tab opens.
- **The opening claim was corrected.** "every `STATE_DELTA` repaints both" is true but misleading;
  it now says the two views render the surface *differently*, which is what a reader needs.
- **Citations verified by printing each line**: `view-adapter.ts:202` (`condensed:`),
  `:220-221` (the `full` omission), `:311` (`inlineModel`), `tool-view.tsx:265` (`InlineSummary`),
  `surface-store.ts:86` (`effectivePlacement`).

`docs/DUAL-VIEW.md` already stated this correctly at "The two models" — the README was the outlier,
so that document is unchanged.
### Step 16 — packaging: publish access, engine window, shipped docs

Publication preparation, measured before any push. Two of the three defects below would have
failed the release, and one of them silently.

- **`publishConfig.access: "public"` was missing.** A scoped package (`@nolit/…`) publishes
  *restricted* without it — the publish succeeds and the market then cannot resolve the package.
  That is `docs/NPM-PUBLISHING.md` §2.2, and this track had the same gap. Added.
- **`engines.dsh` was unsatisfiable by the running Host.** It declared `>=0.2.2-rc.1 <0.3.0-0`,
  and `semver.satisfies('0.2.3-alpha.2', …)` returned **false**, so a consumer on the current
  release would have been told the package does not support it. Now
  `>=0.2.2-alpha.2 <0.3.0 || >=0.2.3-alpha.2 <0.3.0` — the same window the published
  `@nolit/dsh-notify` uses. Verified true for `0.2.2-alpha.2`, `0.2.2-rc.1` and `0.2.3-alpha.2`.
- **The tarball shipped no documentation.** `docs/**` was absent from `files[]`, so every relative
  link in `README.md` and `README.ko.md` pointed at nothing inside the package — 11 broken links,
  measured on a real `npm pack` + extract. The six product documents are now shipped and all
  **43** relative links resolve inside the tarball.

Verified on the extracted tarball, not the source tree (`docs/NPM-PUBLISHING.md` §2.3): the host
entry `import()`s cleanly (`apply` is a function, `inject` is
`["tools","systemPrompt","webServer","connection"]`), and every relative `import` inside
`lib/` resolves. 42 files, 265.9 kB packed.

Gates: typecheck clean · build 558 KiB · `check:wires` 11/11 · `npm test` 369/369 · `verify` 32 ·
`render` 19/19 · `verify:fresh-home` all scenarios · `docs:check` 1,495 links · `lib/host`,
`src/` and `tests/` untouched by this step.
### Step 15 — documentation hierarchy flipped: English primary, Korean companion

Step 14 wrote the authoritative documentation in Korean inside `README.md`, which left the plugin
detail page showing Korean to every English reader and kept the stale upstream English text in
`README.en.md`. Distribution convention is the other way round.

- **`README.ko.md` created** from the verified Korean text (302 lines). One addition: the language
  switcher at the very top. The docs nav line lost its now-wrong `English` entry.
- **`README.md` rewritten in English** (312 lines). Every citation was carried across and then
  diffed against the Korean file: both contain the same 29 `file:line` references, by name and
  number, so the translation did not drop or invent one. The 18 basic + 13 extended = 31
  component breakdown, the dual-view table, the security row table and the known-limits table
  all survive intact.
- **Both files open with the switcher**: `**Language:** **English** · [한국어](README.ko.md)` and
  `**Language:** [English](README.md) · **한국어**`.
- **`README.en.md` deleted.** It was the inherited upstream English page, and it contradicted every
  section of the new documentation. Three references had to move with it:
  `package.json` `files` (now `README.md`, `README.ko.md` — verified by `npm pack --dry-run`,
  which lists both and total 36 files), `docs/INDEX.md` (regenerated), and
  `docs/measurements/dsh-a2ui-mount-and-block.md`, whose citation of `README.en.md:203` pointed
  into the deleted file. That note now cites the upstream statement's content and records why the
  path is gone.
- **The upstream Chinese sentence stays quoted** in both READMEs (§1): 16 Hanzi characters each,
  measured. It is quoted evidence of what upstream decided, not leftover text.

Gates at this step: typecheck clean · build 558 KiB · `check:wires` 11/11 · `npm test` 369/369 ·
`verify` 32 invariants · `render` 19/19 · `verify:fresh-home` all scenarios · `docs:check` 1,493
links OK · `lib/host` untouched · no service restart.
### Step 14 — README states what this package is

The DSH Plugin Detail page rendered the inherited upstream Chinese README, which documents the
**single-shot snapshot** model (`一次调用，一个独立快照`) and the deliberate non-support of
cross-call updates. Every one of those statements is false for this fork. The README was the one
surface still describing a product that no longer exists.

- **`README.md` rewritten in Korean**, 299 lines, zero Hanzi (measured: `grep -c '[一-龥]' README.md`
  → 0). Structure: identity vs upstream (with the exact behavioural delta in a table), the
  `STATE_DELTA` path, the dual-view `ViewAdapter` layer, session isolation and the security
  guardrails, the catalog (31 components + 6 functions), install/usage, development gates, a
  known-limits table, and licensing/attribution.
- **Every architectural claim carries a `file:line` citation**, and each was verified by printing
  the cited line: 29 citations checked, one was wrong (`surface-store.ts:301-306` for the epoch
  guard — the real sites are `:287-288` and `:328`) and was corrected rather than dropped.
- **The known-limits table does not claim verification it does not have.** Three rows are marked
  **unverified** or **measured only**, with the falsifier named, matching `docs/DUAL-VIEW.md`.
- **`README.en.md` now points at the Korean page** as authoritative and says plainly that it still
  carries the inherited upstream text. Its `简体中文` link labelled `README.md` as Chinese, which
  the rewrite made false.
- **K1** — `docs/BOOTCARD-POLICY.md` gains "Who may run the generator": `~/.dsh/AGENTS.md` §7
  quoted verbatim (lines 70–81) and the verdict that `scripts/new-bootcard.mjs` is **restricted**,
  because it writes a boot card and edits `AGENTS.md`, both owner-owned.
- **K2** — `tests/tabs.test.mjs` names the four client modules the structural gate scans, with
  the role of each, so its scope is auditable instead of implied.

Gates at this step: typecheck clean · build 558 KiB · `check:wires` 11/11 · `npm test` 369/369 ·
`docs:check` 1,497 links OK · `lib/host` untouched · no service restart.
### Step 13 — the seed-id invariant is protected on the half this repo owns

`npm test` 367 → 369. `lib/host` diff empty; `dsh-web.service` untouched.

- **Two new tests pin seed-id forwarding.** `tests/tabs.test.mjs`: "every open forwards the same
  seed id the mapping records" and "the seed id is written in exactly one place in the client
  source". The second reads the four client sources and asserts `service.openTab(` appears once,
  in `TabRouter.open`, so a second builder cannot slip in.
  **Mutation-checked**, each with the bundle rebuilt and a hit confirmed in both `src/` and
  `build/shared.mjs`: dropping `seed.id` (3 failures), forwarding a literal id (2 failures),
  adding a second builder (5 failures, including the count assertion).
- **The invariant is documented as measured, not tested.** `src/client/tabs.ts` and
  `docs/DUAL-VIEW.md` now state it, with the detection procedure: press `[사이드바에서 열기]`
  twice; N > 1 tabs means the host regressed; re-verify better-sidebar's `openTab` dedup
  semantics before assuming the plugin guard is sufficient.
- **`docs/DUAL-VIEW.md` separates evidence types.** Every row is labelled **[MEASURED]**,
  **[TYPE-COMMENT]** or **[CODE]**, with a legend giving the falsifier for each. The
  `service.d.ts:128-132` row is **[TYPE-COMMENT]** — a `.d.ts` comment, not behaviour, and not
  relied on by this plugin.
- **A brittle assertion was replaced.** The seed-builder test first pinned the literal line
  `tabs.ts:289`; adding a comment moved it to `:306` and the test failed on an edit that changed
  nothing. It now asserts the count and names the sites it found.
### Step 12 — the dedup guarantee, attributed to the right layer

Eight of the previous round's claims were true but attributed to the wrong layer, and one test that
claimed to prove the Step C scenario proved something else.

- **Who prevents a duplicate tab is measured, not assumed.** better-sidebar reuses an open tab only
  when the descriptor supplies `dedupeKey` or `single` **and** the seed carries `meta`
  (`dsh-better-sidebar@0.33.0/lib/client.js:1886-1901`). This plugin registers neither
  (`src/client/tabs.ts:238-246`). Two other guards do hold: the plugin's own `tabIdFor` branch
  (`src/client/index.ts:291-301`, `:413-419`) and the host's use of the seed id. Both were measured
  by calling `tabs.open()` twice with the guard bypassed: **one** tab, not two.
- **The two-view dispatch test was measuring the wrong thing.** Its first version mounted two
  copies with the *same* `callId`; the shared form lock (`model-store.ts` keys on
  `session + callId + surfaceId`) disabled the second button, so the dedupe never ran and the
  mutation removing it still passed. The card and the tab body do **not** share a `callId` —
  `makeTabBody` mounts with a surface and no call — so the test now mounts `call_card` beside
  `call_tab`, asserts the second button stays enabled, and only then that one action was sent.
  With the dedupe line deleted and the bundle rebuilt, it fails with `got 2`.
- **The E2E dismissal looked for a control that does not exist.** `Preview Notice` has a primary
  **Continue** and no `aria-label="Close"`; the earlier locator matched nothing and left the app
  `inert` for the whole run, so click-based cases failed on host chrome. The loop now dismisses
  whatever modal is present through its first enabled control, and the difference is recorded in
  `docs/E2E.md`.
- **`docs/DUAL-VIEW.md` now carries the citations** instead of the earlier sentence that credited
  the framework with a guarantee it does not provide.
### Step 11 — the inline card and the tab, alive at the same time

A `placement: "sidebar"` surface painted its tab correctly and rendered the empty notice in
the conversation. The card had no model of its own: its only source was the call's durable
copy, and the placement check deliberately redirected it to nothing.

- **`src/client/view-adapter.ts` — one mediator instead of two readers.** The store is
  subscribed here, once per surface (`ClientSurfaceStore.subscribeSurface`, new) and per
  session, and each view receives a *derived model*: `fullModel(surfaceId)` for the tab,
  `inlineModel(surfaceId)` for the card. Views no longer touch the store and no longer send
  anything themselves, so the two cannot disagree about a payload or about a click.
- **The card summarises a tab-owned surface instead of erasing it.** Title, up to four
  resolved rows, the component count and an "open in sidebar" control. The full graph is
  painted once, in the tab; `inlineModel` omits `full` whenever the placement is `sidebar`,
  so the card cannot paint it twice even by accident.
- **One dispatch exit.** `adapter.dispatch` refuses an action whose session is not the
  modelled one and drops a repeat of the same `surfaceId + sourceComponentId + actionId`
  inside 200ms. Both views call it, which is what makes a click repeated in the card and in
  the tab reach the agent once. A failed send clears its dedupe entry, so a retry is never
  swallowed by the window that was meant to stop double clicks.
- **A session switch tears down before it builds up.** `onMountedSessionChanged` releases
  every subscription, drops the previous session's `surfaceOwners` entry and clears the dedupe
  map before the new session's surfaces are tracked. A late frame for the old session wakes
  nothing, and the model for its surfaces is `undefined` from that moment.
- **Preserved, not rebuilt.** `sessionFor` is still the only mounted-session resolver,
  `EMPTY_STORE` still answers a refused read, `syncTabs`/`storeFor` still compare the store key
  with the session on screen, and `openSurfaceTab` still goes through `TabRouter.openTab` with
  the `a2ui:{surfaceId}` seed — a second open updates the existing tab instead of minting one.

### Verified by breaking it

Each gate below was measured with the mutation **rebuilt** before the test ran. The first
attempt at this was itself a defect: `npm test` reads `build/shared.mjs`, so mutating `src/`
without rebuilding left every mutation green. Without the rebuild, three of four gates looked
like they could not fail.

| Mutation | Gate that caught it |
| :-- | :-- |
| the 200ms dedupe removed | `one click repeated across both views sends once` |
| `releaseAll()` removed from the session switch | `a session switch releases every subscription it held` |
| the cross-session guard dropped | `an action for a session that is not on screen is refused` |
| condensing made unconditional (`condensed: false`) | `a sidebar surface yields a non-empty inline model` |
| the condensed card branch disabled in the view | the DOM case `a sidebar surface renders a non-empty inline card` |

The subscription-release gate needed a second pass: behaviour alone did not notice the missing
`releaseAll()`, because the model read is guarded by session identity anyway. The test now
counts the adapter's real `subscribeSurface` calls and asserts the previous session holds
zero when the switch returns.

### Gates

| Gate | Result |
| :-- | :-- |
| `npm run typecheck` | clean |
| `npm run build` | client.js 558 KiB, 23 host modules |
| `npm run check:wires` | 11 members, every one has a reader |
| `npm test` | 366 pass, 0 fail (12 new adapter cases, 1 new DOM case) |
| `npm run verify` | 32 invariants, 0 failures |
| `npm run render` | 19 cases matched |
| browser E2E (isolated home, port 3099) | see `docs/E2E.md`; 12 cases including the two new ones |

**Restart required:** none for the plugin itself — the profile links the source tree, so a
page reload picks up this build. `dsh-web.service` was not touched.

### Step 10 — verified on the live profile

Installed and observed on `~/.dsh/profiles/web` (no restart needed: the profile
links the source tree, and the service had already loaded the 09:34 build).

- **A real `a2ui` tool call opens the sidebar tab.** The agent's own call, not an
  injected snapshot: `placement: "sidebar"` reached the store, `syncTabs` fired,
  and the right Sidebar showed a `System Status` tab with three component nodes
  and live values.
- **The seed path is what carries it.** Observed before cleanup: `phase: "result"`,
  `metaKind: "a2ui"`, `hasMessages: true` — the durable `meta` copy is what makes a
  sidebar surface reachable when the downlink has not delivered a frame.
- **Two measurement traps worth recording.** The live GUI opens on whichever
  session was last active, so a check must click the session it expects; and the
  tailnet certificate is rejected by Chromium until `ignoreHTTPSErrors` is set,
  while the loopback port answers with a pairing screen unless the launch token is
  used.

### Step 9 — one resolver, and the invariant made permanent

- **The double fallback is gone.** `sessionFor` is now the only place that falls
  back from a view's own `sessionId` to the session the Sidebar shows. It had been
  resolved twice — in the view and again inside the `surfaceStore` accessor — and
  removing either one alone still passed every test, because the other silently
  covered for it. That is now impossible by construction, and a unit test pins it.
- **The read path is guarded too.** `syncTabs` refused to *open* a tab for a
  foreign session; `storeFor` now refuses to *hand out* its store, so a mismatch
  cannot reach the DOM by either route. A refusal returns a shared empty store, so
  a view can never paint data it was refused.
- **The signature is quoted where it is relied on.** `ClientRuntime` documents
  `readonly mounted: ObservableSnapshot<SessionId | undefined>` from the installed
  `dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:182`.
- **`tests/session-invariant.test.mjs`** makes the shape a gate: one resolver, no
  self-resolving accessor, no re-implementation in the view, both refusal paths
  present, and no fabricated surface on refusal.

Verified by breaking it: disabling `sessionFor` alone drops the tab body to zero
component nodes and fails the browser suite. The unification is real, not
cosmetic.

### Step 8 — dead-wire gate and the two-word reporting rule

Owner instruction after four rounds of "tests green" against a tab that never opened.

- **`scripts/check-dead-wires.mjs`** — every member reachable through `ClientRuntime` must have a
  reader outside its own assignment line. Runs as the first half of `npm test`, so a build cannot
  report green while a hook is unreachable.
- **Four redundant hooks deleted** rather than wired: `placementFor`, `openSurfaceTab`,
  `updateSurfaceTab`, `forgetSurfaceTab` were assigned in the entry and read nowhere, because
  `syncTabs` already drives `tabRouter` directly. Adding callers would have duplicated the rule.
- **The gate was verified by breaking it.** Two shapes are proven to fail: an assigned-but-unread
  hook, and one assigned without a contract declaration. The first version of the script missed
  both — `\s` inside a template literal reads as the letter `s`, so the assignment regex never
  matched. A gate that cannot fail is worse than no gate.
- **`docs/COMPLETION-CONTRACT.md`** fixes the vocabulary: code complete with green gates is
  **"코드 완료, 통합 미검증"**; only a real browser showing the result is **complete**.

### Step 7.3 — the tab had no content, and the store had no source

Three more links that were declared and never driven:

1. **The downlink was never opened.** `runtime.connectDownlink` had no caller, so the socket that
   delivers surfaces never started. The tool view now connects on mount — the first point where
   a session is real in the browser.
2. **The store had no seed.** It was filled only by socket frames, so a reloaded transcript, a
   profile without the transport, or the moment before the socket opens left it empty. A tool
   result now seeds its surfaces from the durable `meta` copy, and `placement` rides that copy so
   the inline view can defer without waiting for a frame.
3. **The tab body rendered nothing.** `surfacePayload` rebuilt a `createSurface` from the data
   model alone — no components — so even a successfully opened tab showed an empty card. It now
   folds the surface's own messages, and shows the skeleton only when there are none.

Also: a shell without `WebSocket` (a DOM test, a worker) no longer starts a socket at all, which
is what put `setTimeout is not defined` into 31 DOM tests when the connect hook landed.

### Step 7.2 — the tab open hook was missing entirely

Reported from a live screen: the right Sidebar was open showing only the generic
`Generative UI` tab, while the dashboard rendered as an inline card.

`runtime.openSurfaceTab` was defined and never called. `registry.registerTab` had been fixed in
Step 7 (deferred until `betterSidebar` arrives), but nothing turned "the store now holds a
`sidebar` surface" into an `openTab` — so no instance was ever created. Three connected defects:

1. **No subscriber.** The store learned about the surface and stopped there. It is now
   subscribed in `storeOf()`: any change syncs the session's tabs, so a surface works whether it
   arrives over the socket or is folded from the transcript.
2. **The title was dropped.** `ClientSurface` had no `title` field, and `SurfaceState` never
   received the call's title, so a tab could only ever be named after the plugin. The title now
   travels tool argument → `SurfaceState` → baseline frame → `ClientSurface`.
3. **The inline card duplicated the tab.** A `sidebar` surface rendered in both places. The
   inline view now defers: it renders no card and the surface lives only in its tab.

The narrow rule still wins: `syncTabs` asks `resolvePlacement` before opening, so below 768px no
tab is created and the card stays in the conversation.

### Step 7.1 — `placement` reaches the model

Found by asking for a sidebar card in a live session: the Host read `placement` from the tool
arguments, but the tool's own parameter schema declared only `messages`, `title` and
`presentation`, and the validator's root allowlist matched. Every sidebar request was therefore
rejected as `has unsupported properties: placement` before it could be stored, so the sidebar
path was unreachable no matter what the guidance said.

- `a2ui` parameters now declare `placement` (`enum: ["inline", "sidebar"]`) with the downgrade
  behaviour in its description.
- `validateToolArguments` admits `placement` at the root and rejects any value outside the enum.
- The integration test pins the property set and the enum.

### Step 7 — ship readiness and a real browser

**Consistency.**

- **`resync` enforces surface ownership.** `sessionId` travels in the request body and a Peer
  carries no session identity, so the enforceable check is ownership: a frame is only returned
  to the session that published that surface. Applied to `action` and `resync` alike.
- **Epoch-aware tab mapping.** `dsh-a2ui-plus:epoch` records the store lifetime the persisted
  surface → tab map belongs to. A changed epoch clears the whole map, because every entry then
  names a surface the new store never had.
- **Credentialed URLs** (`https://user:pass@…`) were already refused in `admitHttpsUrl`; this is
  now covered by an explicit assertion.
- **Unused `test` patch operation removed.** The Host emits `add`/`replace`/`remove` only, and a
  branch nothing can reach misrepresents what the store accepts.
- **The 5-second activation window is documented with its measured trace**, including why it
  cannot be sampled across protocol round trips.

**Fixed by the browser, invisible to a stub.**

1. **The tab type never registered on a live host.** `apply()` probed `betterSidebar` once; the
   sidebar loads after this plugin, so the probe failed and the plugin gave up silently. It now
   waits through `ctx.inject(['betterSidebar'], …)`.
2. **The tab body never found its surface.** `dsh-better-sidebar` re-mints tab ids (`tab3`), so
   the seeded `a2ui:{surfaceId}` id is advisory. The surface now rides `tab.meta.surfaceId`,
   which the record persists, with `path` and `id` as fallbacks.
3. **A missing `ctx.inject` threw during apply** on any context without it; the call is guarded.

**Playwright suite** (`tests/e2e/`, see `docs/E2E.md`): nine cases in a real Chromium against a
real host, including a trusted click that sets `userActivation.isActive`, an accepted
`confirm()`, a clipboard read-back, a declined dialog that performs nothing, four rejected URL
schemes that never reach `window.open`, and the real sidebar listing and opening the tab type.

### Step 6 — security, recovery and live mount

**Security (the reason this step exists).** The gesture rule was enforced on the wrong
side: the Host accepted the agent's own `gesture: true` field as proof of a user action, so
a model could authorize its own browser call. And no executor existed at all — the channel
validated, pushed, and timed out without running anything.

- **The flag is ignored.** `admitRequest` no longer reads `request.gesture`; it returns
  `gestureRequired` and the Host never vouches for it.
- **A real executor exists** (`src/client/executor.ts`): the six functions, and nothing else.
  A gesture-bound call needs **both** `navigator.userActivation.isActive` **and** an explicit
  confirmation dialog. Missing activation is treated as absent, never as permission; a page
  with no confirmation surface fails closed.
- **https only.** `openUrl` and `downloadFile` parse the URL rather than matching it, refuse
  any scheme but `https:`, refuse credentials, refuse surrounding whitespace, and refuse any
  control character. A parse that reinterprets the string (`https://a\nhttps://b` becoming one
  host) is refused. `http:`, `javascript:`, `data:` and `file:` are all rejected at
  execution time, after the gesture gate — measured.
- **Download filenames** cannot contain a path separator, a traversal segment, or a control
  character.

**Recovery.**

- **Epoch**: every snapshot and delta carries `surfaceEpoch`, minted per store instance. A
  snapshot from a new epoch is adopted regardless of revision, so a Host restart no longer
  leaves a browser frozen at the old process's revision.
- **Resync**: three consecutive unapplicable patches make the client call the `resync`
  endpoint on `/a2ui-plus`; the Host answers with snapshots synthesized from the store and
  the client adopts them unconditionally.

**Polish.** `capabilities.rendererFunctions` prints requirements (`openUrl (scheme=https,
gesture-required)`) instead of repeating the kind. A `surfaceOnly` tab with no snapshot yet
shows a shimmering skeleton instead of the "nothing to show" notice.

**Live mount found three real defects** that a stubbed context could not:

1. `webServer` and `connection` were read without being declared in `inject`, so Cordis threw
   `cannot get property "webServer" without inject` and the plugin never activated.
2. A socket refusal destroyed the socket without writing an HTTP status, so a client could
   not tell a rejection from a crash.
3. The client wrapped its RPC payload in `{ args }`, but Connection hands the Host
   `message.payload` verbatim — every call came back `malformed-request`.

### Step 5 — renderer functions and catalog advertisement

- **The blanket refusal is gone.** `callRendererFunction` and `agentFunctionResponse` are
  valid A2UI 1.0 messages and now validate: envelope, ids, and a function name that must be on
  the allowlist. The one table lives in `shared/catalog.ts` and both halves read it, so the
  model is told exactly what the Host accepts.
- **Six functions, no dispatch by arbitrary string**: `openUrl`, `scrollTo`, `copyToClipboard`,
  `downloadFile`, `validateForm`, `requestFilePicker`.
- **Gesture guard**: `openUrl`, `copyToClipboard`, `downloadFile` and `requestFilePicker` refuse
  with `gesture-required` unless the request carries `gesture: true`. `validateForm` is pure and
  answers immediately; `scrollTo` is local and needs no gesture.
- **Catalog advertisement**: `a2ui_catalog` now prints `capabilities.rendererFunctions` with each
  name's kind (`pure` / `gesture` / `local`) at both detail levels.

### Step 4 — sidebar tabs and in-place cards

- **One tab type** (`a2ui-generic`) registered once through `betterSidebar.registerTab`, with
  per-surface instances opened as `a2ui:{surfaceId}` so a repeat open focuses rather than
  duplicates.
- **In-place updates**: a `STATE_DELTA` calls `updateTab` with the surface revision instead of
  opening another tab — the sidebar cannot accumulate one tab per revision.
- **Narrow downgrade**: below 768px a `sidebar` placement resolves to `inline` and the downgrade
  is recorded, matching `NARROW_MAX_WIDTH` in both the Host plugin and DSH's own right column.
- **Refresh restore**: the surface → tab mapping is persisted (`dsh-a2ui-plus:tabs`) and
  reconciled against the surfaces the Host reports, so a stale entry is dropped instead of
  resurrecting a tab whose surface is gone.
- **Conversation cards follow the socket**: the tool view reads its surface from the client store
  when one exists, so a repeat call updates the card in place rather than stacking a second copy.

### Step 3 — Surface Store and STATE_DELTA

- **The Host decides what a change is** (`src/host/store.ts`): a per-session store holds each
  surface's `dataModel`, `components` and `revision`. A `createSurface` becomes an
  `ACTIVITY_SNAPSHOT`; an `updateDataModel` becomes one RFC 6902 operation — `replace` when the
  pointer resolves, `add` when it does not; an `updateComponents` becomes one operation per
  component; a `deleteSurface` becomes a `remove`.
- **`/surfaces/{surfaceId}/…` namespacing** for every patch path, with the data model at
  `/surfaces/{id}/dataModel` so a root write addresses the model rather than the surface object.
- **Revision guard**: one monotonic revision per session, stamped on every frame. A client drops
  a frame that is not newer, which makes a re-ordered or duplicated frame harmless.
- **The client patches too** (`src/client/surface-store.ts`), because the renderer has to reach
  the same result as the Host: `add`, `replace`, `remove`, `test`, copy-on-write, and an
  unapplicable patch leaves the surface intact for the next snapshot to repair.

### Step 2 hardening — subprotocol and keepalive

- `/a2ui/ws` negotiates `a2ui-plus.v1`; a client offering only other protocols is refused at the
  handshake rather than downgraded.
- Host → client `ping` on an interval, client `ping` answered with `pong`, and a socket silent
  past the timeout is reaped. Masked client frames are decoded.
- The reconnect baseline is **synthesized from the store at attach time**, not replayed from a
  remembered frame, and carries the store's own revision.

### Step 2 — out-of-turn transport

- **Uplink** `ctx.connection.rpc.handle('/a2ui-plus', …)` with endpoint `action`. The channel name
  cannot contain `/` (Connection validates `/^\/[A-Za-z0-9._~-]+$/u`), which is why the pair is
  split rather than a single `a2ui-plus/action` string.
- **Downlink** `ctx.webServer.registerUpgrade({ path: '/a2ui/ws' })`, a raw RFC 6455 text channel
  with no added dependency. The session rides the query string; a socket without `sessionId` is
  refused rather than routed by "whatever is open".
- **Reconnect baseline**: the newest `ACTIVITY_SNAPSHOT` per session is retained and replayed once
  to a late attachment, so a refresh does not need a client-side replay.
- **Revision stamping**: every pushed frame carries a monotonic `surfaceRevision` the renderer can
  use to drop stale frames.
- **Surface publishing**: the `a2ui` tool now reports what it rendered. A new surface pushes
  `ACTIVITY_SNAPSHOT`; a repeat call for the same surface pushes `STATE_DELTA`; a deleted surface
  pushes a `surfaceDeleted` `CUSTOM` frame. Publishing is best-effort — the tool result stays valid
  with no browser attached.
- **Renderer-function channel**: `callRendererFunction` requests are correlated through a pending
  map with timeout, cancellation, supersede and cross-answer rejection (a reply naming a different
  function is refused, not delivered).

### Step 1 — fork, locale, preset scoping

- Forked from `dsh-a2ui` 0.4.0 as `@nolit/dsh-a2ui-plus`, a drop-in replacement: tool names stay
  `a2ui` and `a2ui_catalog`, and the extension catalog id `dsh-a2ui/catalog/v1` is unchanged so
  existing payloads still validate. The two plugins cannot coexist — the tool registry rejects a
  duplicate name.
- **Korean locale**: `locale/ko.json` and a full `ko` dictionary (88/88 keys, same key set as `en`).
  Number, percent, currency and date formatting already flow through `Intl` with the active locale.
- **Agent-preset scoping**: tools register with `ToolRegistrationOptions.when`, so `minimal` cannot
  call them while `standard`, `ptc` and `cordis` can. The condition is configurable through
  `presets`; an empty list removes the gate. A Host without the preset registry admits, because
  refusing on missing data would silently disable the plugin.
- **Preset-aware guidance**: the prompt section resolves per assembly, so a Session that switches
  preset gets the current guidance. `cordis` additionally receives the creator lines (sidebar
  placement and the renderer-function channel); `standard` and `ptc` do not claim what they cannot do.
- **Config** gains `presets` and `transport`.

## 0.4.0 — 2026-11-24

### Added

- Compact presentation for individual charts and short content blocks, plus the lightweight `Section` component.
- `Heatmap` with sequential and diverging scales and `Timeline` with event statuses.
- Scatter series with data binding, legend toggles and keyboard inspection in `Plot`, with optional bubble sizes and per-series linear regression.
- `ParetoChart`, optional error bars on vertical non-stacked `BarChart` series, and `RadarChart` with a shared score scale.

### Fixed

- Scatter plots show valid endpoints, and chart focus outlines are reserved for keyboard navigation. Fixed axes support steady slider-driven redraws.
- Heatmap tooltips follow the pointer and clear as it leaves a cell. The scrollable cells fade at the horizontal and vertical header boundaries.
- Refined plot segments at domain boundaries, small-value tick labels, line-chart tooltip wrapping, and long radar labels in narrow layouts.
- The local installer validates its archive before invoking DSH and checks every packaged runtime file against the build.

## 0.3.1 — 2026-11-18

### Fixed

- Streaming previews now wait for a complete `updateDataModel` message before applying writes, preventing brief empty content when paths or container values are still arriving.
- Line charts preserve category alignment for missing values and real zeros, breaking line and area segments at gaps instead of shifting or bridging values.
- Calls without a title now return lossless presentation metadata.
- FramePlayer gives bars a definite plot height, caps their width, and uses a theme-tinted default color.
- Plot reports an invalid x-axis range when `xMin` is greater than or equal to `xMax`.
- Tables disclose when the display limit omits rows from the supplied data.
- Bar charts leave gaps for missing values while preserving category alignment and real zeros.
- Failed calls appear once in the process row with expandable diagnostics. The turn tail still shows successful cards and omits an empty container.
- `Row` and `Column` accept the CSS spellings of `justify`. Using `Text.usageHint` now produces guidance to use the A2UI 1.0 `variant` field.

### Documentation

- `a2ui_catalog` explains layout weights, table display limits, and chart value alignment, with minimal Table, Text, and weighted Row examples.

## 0.3.0 — 2026-11-15

Progressive streaming release. The card is now drawn **while** the model is still writing the tool
arguments, instead of appearing all at once when the arguments finish.

### Added

- **Progressive streaming render.** A call in the `preparing` stage is drawn from the argument
  fragments that have already *closed*: finished messages and finished components are folded with
  the same `applyMessageBatch` the settled snapshot uses, so a surface grows instead of being
  rebuilt. Components that are referenced but have not arrived render as skeleton placeholders
  rather than "missing child" errors, and nothing is drawn before `root` exists (no empty card
  flash).
- **Session-scoped fragment observation.** A preparing card reads its own tool
  fragments from the event window of the already-open Session. It responds to
  window replacement and cancellation even when no tool result follows.
- **`src/shared/partial-json.ts`** — a recovery scanner that only ever returns values whose own
  slice `JSON.parse` accepts, with a nesting bound (128), a scan cap (512 KiB) and an explicit
  `invalid` answer for a prefix it cannot follow.
- **`src/shared/stream.ts`** — the streaming fold: per-component structural checks, the same render
  budget as the settled path, and a `stopped` flag for a prefix that must not be drawn.

### Behaviour

- The preview is **not interactive**: the card is `pointer-events: none` with `aria-busy`, and
  submit/write paths are disabled until the call settles and its payload passes Host validation.
- Nothing about authority changed: `validateToolArguments` still decides what may render and
  reports the precise error. A preview that hits malformed syntax or the render budget stops and
  falls back to the skeleton.
- Bounds: 262,144 UTF-16 code units per preview and 32 cache entries totaling
  up to 1,048,576 UTF-16 code units. The recovery scanner remains bounded.

### Tests

- 26 cases in `tests/streaming.test.mjs` cover partial recovery, component and
  message validation, the official incremental payload, per-Surface and per-call
  budgets, window replacement, cancellation, cache bounds, and Session isolation.
- 6 real-React render cases cover preparing and final results, including previewing
  all four rows of the official incremental sample.
- A DOM case delivers two nonempty fragments through the Session binding, verifies
  cancellation and replacement, then checks the same mounted card as it becomes
  interactive.
- 3 bundle invariants cover transient withdrawal, fragment reading, and the
  recovery bound.

### Fixed (review pass)

- **Cancelled or replaced windows kept stale previews.** A Session's event
  window now drives its preview. Equal event sequence numbers are ignored,
  replaced windows rebuild the prefix, and attempt settlement clears it.
- **Different Sessions could overwrite the same call ID.** Each preview follows
  its own Session binding and call. Foreign tools' fragments are skipped.
- **Incremental Surfaces lost their initial data.** A valid create is retained
  even if the root arrives later. Confirmed unsupported message versions are
  skipped during preview.
- **A closed component was not validated.** `{"id":"root","component":"Tabs",
  "tabs":[null]}` was accepted by the preview and threw while rendering. Closed
  components now go through the settled path's own property validation
  (`checkComponentAlone`), so an illegal component is dropped, an illegal root
  falls back to the skeleton, and the same payload still produces the original
  validation error once settled.
- **The aggregate budget was not enforced.** Two surfaces of 3,501 nodes each
  passed the preview (7,002 in total) while the settled path rejects the call at
  6,000. The preview now accumulates expanded nodes and data units across the
  call against the same `LIMITS`, keeps the surfaces that already fit, and skips
  a surface over its own budget; message, surface and component counts are
  enforced too.
- **The preview was reachable from the keyboard.** `pointer-events: none` stops
  the mouse only, so Tab still entered a preview's tab strip. The preview body is
  `inert` now (set through the DOM, so it works on React 18 and 19), and a DOM
  test asserts the attribute is present while generating and gone once settled.
- **Preview failures could blank the slot.** A preview-only error boundary shows
  the skeleton instead; it is deliberately scoped to the preview so a settled
  card still surfaces its own errors.

## 0.2.1 — 2026-11-13

### Fixed

- **Bar chart tooltip placement.** The hover tooltip is now an HTML overlay anchored to the hovered
  bar and clamped to the plot area, so long labels and narrow cards no longer push it outside the
  chart or into the axis labels; it also clears when a series is hidden from the legend. Grouped,
  stacked and horizontal bars are covered by DOM tests that mock the layout geometry.

## 0.2.0 — 2026-11-13

Correctness and safety release. It aligns the renderer and the validator with the published A2UI
1.0 specification (all 43 official catalog examples now pass), removes every file deletion from the
build, and replaces the unbounded regex path with a bounded evaluator.

### Fixed

- **Same-call message folding.** `createSurface → updateComponents → updateDataModel` inside one
  tool call now composes; previously each message was folded against the state from *before* the
  call, so in-call updates and data writes were silently dropped. Deleting and re-creating a
  surface in one call now reports `deleted: false` and leaves no stale components behind.
- **Template scope.** Components nested inside a repeated template row resolve relative paths
  against that row (the official `00_incremental` example rendered empty labels with four
  "Book now" buttons); a row's button carries its own row values in the action `context`.
- **Official field aliases.** `@checks`, `@catalogId`, `@accessibility` and `@metadata` normalize to
  their plain names; an alias and the plain name must agree, and a conflict is reported at the alias.
- **Refused data-model writes.** A write that cannot be applied (`{arr:[]}` + `/arr/500`) is reported
  at `/messages/<i>/updateDataModel/path` instead of being reported as a successful update.
- **Pure date fields.** A `date` control no longer shifts through the local time zone: `2026-11-13`
  stays the 13th in every zone, and stored values use UTC midnight so the round trip is stable.
- **Failed sends lock the form.** Only `sending`/`sent` disable inputs; after a rejected send
  (`QUEUE_FULL`) the user can fix the value and retry, and a double click queues one message.
- **Edits survive the card hand-over.** The process row and the turn tail now share one edit model
  and action state per `sessionId + callId + surfaceId`, so an edit made in the row is still there
  when the tail takes over.
- **Turn tail visibility and renamed tools.** Hidden calls no longer appear at the turn tail, and a
  custom `toolName` still renders there through `meta.kind === 'a2ui'`.
- **Bar charts.** The baseline is always visible (positive-only starts at 0, negative-only ends at 0,
  mixed contains 0), explicit `yMin`/`yMax` clip instead of overflowing, stacked positives and
  negatives accumulate separately, and the horizontal variant grows from the baseline both ways.
- **Plots.** `variables` accepts one binding for the whole coefficient object, and a curve that
  leaves the plotted domain breaks instead of drawing a line through a discontinuity (`1/x`).
- **Pie charts.** Slices beyond the visible cap are grouped into one "Other (N)" slice whose value
  is the sum of the remainder, so percentages still add up; the legend reports further entries.

### Security

- **Regex.** The `regex` function now implements the specification's dialect and static safety
  check (>256 code points, a bounded-above-1 quantifier over a subexpression with an unbounded one,
  an unbounded quantifier over alternatives that share a first character, adjacent unbounded
  quantifiers with overlapping character sets; lookbehind, backreferences, named groups,
  `\p{...}`, `\cX` and inline flags are rejected) and evaluates accepted patterns with a bounded
  work-list (100,000 steps per match) instead of handing the whole pattern to a backtracking engine.
  Lookahead is allowed again; `(?:ab){2}` and `([A-Z]){2}` match again.
- **Render budget.** Before any element is created the validator and the renderer estimate the
  expanded node count (templates multiply by data length) and data units (table rows + chart points
  + animation items + plot scatter points): one surface above 4000 nodes or 5000 units, or one call
  above 6000 nodes / 6000 units in total, is rejected.
- **Deep JSON.** `isJsonValue` is iterative and bounded at 128 levels and runs before serialization,
  so an 11,000-level array is rejected instead of overflowing the stack.
- **JSON Pointer limits.** Path ≤ 1024 characters, ≤ 64 segments, array index ≤ 10000; prototype
  segments and sparse writes are refused, `-` append is supported, and `~0`/`~1` still decode.

### Changed

- **Cross-call updates are separate cards.** One tool call renders one self-contained card; the
  system prompt and both READMEs now say so and point at a complete `createSurface` payload when a
  changed interface must be shown. Incremental messages are still accepted.
- **`catalogTool: false`** also removes the `a2ui_catalog` reference from the tool parameter
  description, not only from the prompt section.
- **Documentation.** Known limitations, the security table and the test report were rewritten with
  the measured numbers, and the pinned official examples live in `tests/fixtures/examples`.

### Build and tests

- **The build deletes nothing.** TypeScript now emits into memory; linking, the `lib/**` copy and the
  test harness are driven by that emit manifest, so a stale `lib/` file is reported by its full path
  instead of being removed (or silently reused).
- 130 automated cases (was 70), including 10 jsdom DOM cases that dispatch real clicks, typing and
  keyboard events, and all 43 official catalog examples; 11 real-React render cases.
- `react`, `react-dom` and `jsdom` are dev dependencies; CI runs `npm run render` as well.

### Known limitations

- A pattern that hits the match work limit returns `valid: false` with a message; a long input can
  therefore be reported as non-matching. Common shapes are unaffected (greedy-first evaluation).
- `sendDataModel` is accepted and validated but no full model is echoed back.
- `callRendererFunction` / `agentFunctionResponse` are rejected with an explanatory error.
- Media URLs make a network request when rendered (`referrerPolicy="no-referrer"` only affects the
  referrer).
- Relative bindings inside template items are read-only for edits.
- A custom `toolName` renders at the turn tail but not as a dedicated process row.

## 0.1.0 — 2026-11-12

First installable release: Host tools (`a2ui`, `a2ui_catalog`), the A2UI 1.0 validator, the inline
renderer for the 18 basic-catalog components plus 8 extensions (Table, BarChart, LineChart,
PieChart, Stat, Progress, Plot, FramePlayer), the local interaction loop and the action round trip.

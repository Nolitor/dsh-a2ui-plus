# dsh-a2ui — Architecture

<!-- skeleton:
version: 0.4.0
kind: spec
status: active
updated: 2026-11-27
summary: How the fork turns a tool call into a card or a sidebar tab, how the Host Surface Store builds STATE_DELTA frames, how the out-of-turn transport and renderer functions work, and which limits apply.
-->

This document holds the implementation details behind the README's product overview: how a tool call becomes a card, how the streaming preview is recovered, and which limits apply. User-facing behaviour and install instructions live in [README.md](../README.md).

## Layers

```text
DeepSeek Agent
   │  a2ui({ messages, title?, presentation? })
   ▼
Host  ──  A2UI 1.0 schema validation (surface / component / property / binding / depth / quota)
   │      tool result { ok, surfaces, warnings }; a replay copy is kept in result meta
   ▼
Session log (tool/call + tool/result.meta)   ← single source of truth
   │
   ▼
Client ── tool.call.toolview(key="a2ui")
   │      1. read args (or meta)
   │      2. validate again + applyMessageBatch → SurfaceState
   │      3. render the component tree against a local data model
   ▼
Chat UI (multiple surfaces per card)
   │  click / submit
   ▼
conversation.send("[A2UI action] …")  →  current session → agent
```

- **Host** — registers `a2ui` and `a2ui_catalog`, injects the guidance section, validates the payload with the shared validator, and stores a replay copy in the tool result meta.
- **Session log** — the only source of truth. A card is derived from its own tool call; there is no plugin-private store.
- **Client** — registers a `tool.call.toolview` view and a turn-tail view, folds the call's messages with `applyMessageBatch`, and renders the component tree against a local (copy-on-write) data model.

## Validation pipeline

`src/shared/validate.ts` is imported by both halves, so the Host and the browser accept exactly the same payloads:

1. Message envelope: version `1.0`, known message type, surface ids.
2. Component graph: known component, catalog membership, property schema, duplicate ids, cycles, depth.
3. Bindings and calls: JSON Pointer syntax, function names, argument shapes.
4. Resource limits: message count, components per message/surface, payload size, series points, frames.
5. Expanded budget: estimated rendered nodes and data units (templates multiply by data length) are counted before any element is created.
6. Safety: no HTML, no `eval`, URL admission, regex static safety check, iterative deep-JSON check.

A validation failure is reported with a JSON path. The renderer additionally degrades unknown or invalid content to a readable placeholder rather than throwing.

## Surface folding

`applyMessageBatch` folds `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface` in order. The settled card and the streaming preview use the same folding function; the difference is only which prefix of messages is passed in.

Within one call the folds compose (including delete-then-create). Across calls they do not: each card is a snapshot of its own call.

## Progressive streaming

During the `preparing` stage the model is still writing the tool arguments, so the complete JSON does not exist yet. Since v0.3.0 the card grows from the fragments that have already closed:

1. **Read each Session's event window.** A preparing card subscribes to the already-open Session binding and reads its own `tool-call-delta` fragments. Each Session has its own event window, so two calls with the same ID in different Sessions stay separate.
2. **Collect only calls the host names `a2ui`.** The first fragment of a call carries its tool name; anything else is ignored outright, and a name-less fragment is only appended to a call that is already identified, so another tool's arguments never enter the cache.
3. **Recover only what closed.** The recovery scanner (`src/shared/partial-json.ts`) walks the prefix and returns only values whose own slice `JSON.parse` accepts: finished messages, finished components. A half-written component is dropped, so the preview never shows half a component or invents data.
4. **Keep the Surface and its data until the root arrives.** The preview and settled result share `applyMessageBatch`. A `createSurface` can be followed by data and component updates; the preview draws the accumulated data as soon as the root is ready. Messages with an explicit unsupported version are skipped.
5. **Validate closed components.** The preview uses the settled validator's component type, catalog, property and alias checks. It skips invalid components and shows the skeleton when the remaining Surface cannot be drawn.
6. **Absence is a placeholder.** A child that is referenced but has not arrived renders as a skeleton, never as a "missing child" error.
7. **The preview body is `inert`.** Keyboard, pointer, submit and write interactions are disabled while the card is preparing. The normal card restores its usual focus and interaction behaviour.
8. **Release withdrawn fragments.** A window replacement recomputes the prefix. Settling or cancelling a call clears its prefix, and unmounting the card releases its subscription.

Bounds and stop conditions:

| Limit | Value / behaviour |
|---|---|
| Retained argument text per preview | 262,144 UTF-16 code units, truncated beyond that |
| Cache entries / total size | 32 / 1,048,576 UTF-16 code units, oldest evicted first |
| Characters scanned per frame | 512 KiB |
| Recovered JSON nesting depth | 128 |
| Components per message / per surface | 300 / 400 (an over-limit intermediate is not drawn; the settled result decides) |
| Expanded nodes / data units per call | 6,000 / 6,000 (the same limits as the settled path); beyond that the surfaces that already fit are kept |
| Malformed prefix | Preview stops and falls back to the skeleton; the Host still reports the precise error |
| One surface over its own budget | That surface is skipped; the others keep previewing |

The preview changes no authority: whether a payload may render, and what is wrong with it, is still decided by `validateToolArguments` on the Host. Streaming only replaces *waiting* with *appearing*. Because `assistant/live-chunk` is a transient event, reopening a session always renders the validated cards.

## Card hosting and copy claims

The card has two hosts:

- **Turn tail** (`conversation.chat.turnTail`), rendered after the turn's answer in the main flow and never folded with the process area.
- **Process row** (`tool.call.toolview`), used while the tool is still running and as the fallback.

They coordinate through **copy claims**: while the tail copy is mounted it claims the call and the process row collapses to a one-line pointer; the moment the tail copy unmounts for any reason (paging, a new turn, an aborted turn) the claim is released and the process row restores the full card. The interface therefore degrades to an expandable row instead of vanishing.

A custom `toolName` still renders at the turn tail (matched through `meta.kind === 'a2ui'`), but the process row falls back to a generic tool row.

The optional tool argument `presentation: "compact"` shows the surface without its outer card chrome. An explicit title is still shown. Put `presentation` before `messages` so the preview can use the chosen style as soon as the first component arrives. The Host saves the style in result meta alongside the messages so history uses the same presentation. An omitted style uses the regular card.

`Section` belongs to the extension catalog and uses the existing child-list shape. A scatter-only `Plot` can infer both X bounds from the input points. Scatter series can supply a point array or bind one with `@path`; the fold checks resolved arrays against the same point shape and size limit as literal arrays.

`Heatmap` validates the resolved row labels, column labels and matrix together. Each cell counts toward the render budget, including missing cells. `Timeline` checks the resolved event list, counts each entry and renders its original date or stage text in input order. Both can wait for an unresolved binding during the progressive preview. A settled payload must supply the data.

## Out-of-turn channels

The inline card is derived from its own tool call, which makes it immutable after the turn
settles. Two channels carry what the transcript cannot:

```text
Agent ── a2ui({messages, placement?}) ──► Host
                                           │ SurfaceStore (per session)
                                           │   createSurface   → ACTIVITY_SNAPSHOT
                                           │   updateDataModel → STATE_DELTA (add|replace)
                                           │   updateComponents→ STATE_DELTA (per component)
                                           │   deleteSurface   → STATE_DELTA (remove)
                                           ▼
                            ctx.webServer.registerUpgrade('/a2ui/ws')
                                           │  subprotocol a2ui-plus.v1, ping/pong,
                                           │  baseline synthesized at attach
                                           ▼
                                       Browser
                                           │  ClientSurfaceStore (revision-guarded)
                                           ├─ inline card  (tool.call.toolview / turnTail)
                                           └─ sidebar tab  (a2ui:{surfaceId})

Browser ── ctx.connection.rpc '/a2ui-plus' ──► Host ── pending/ ──► renderer answer
           endpoint 'action'                        (correlated, timeout, gesture-gated)
```

**Why the channel name is split.** Connection validates a channel as
`/^\/[A-Za-z0-9._~-]+$/u`, so `a2ui-plus/action` is not a legal channel. The pair is
`/a2ui-plus` + `action`.

**Why the Host builds the delta.** Only the store knows whether a pointer resolves, and that is
the entire difference between `add` and `replace`. A renderer that guessed would drift from the
Host on the first form field it created.

**Why the baseline is synthesized.** A reconnect needs the present, not the last frame a previous
socket happened to receive. `baselineFrames()` reads the store at attach time and stamps the
store's revision, so a client that already holds a newer revision drops it correctly.

**Revision guard.** One monotonic counter per session. `surfaceRevision` on a frame is compared
with the held revision; an equal or lower value is dropped. That is what makes a re-ordered,
duplicated, or post-reconnect frame harmless.

## Placement

| Requested | Viewport | Result |
| :-- | :-- | :-- |
| `inline` | any | conversation card |
| `sidebar` | ≥ 768px | `betterSidebar` tab `a2ui:{surfaceId}` |
| `sidebar` | < 768px | inline card, downgrade recorded |

`NARROW_MAX_WIDTH = 768` matches `dsh-better-sidebar` and DSH's own right column.

## Renderer functions

Six names, no dispatch by arbitrary string. `RENDERER_FUNCTION_CAPABILITIES` in
`shared/catalog.ts` is the single declaration: the catalog tool prints it and `host/actions.ts`
derives its allowlist from it.

| Function | Kind | Gesture |
| :-- | :-- | :-- |
| `openUrl` | gesture | yes |
| `copyToClipboard` | gesture | yes |
| `downloadFile` | gesture | yes |
| `requestFilePicker` | gesture | yes |
| `validateForm` | pure | no |
| `scrollTo` | local | no |

A gesture-bound call without `gesture: true` is answered `gesture-required`, not performed.

## Security boundaries

| Boundary | Enforced where | Rule |
| :-- | :-- | :-- |
| Function name | Host + browser | Six names, no dispatch by string. |
| Argument shape | Host + browser | Re-checked at execution, not only admission. |
| User gesture | **Browser only** | `navigator.userActivation.isActive` **and** an explicit confirmation. The agent's `gesture` field is ignored. |
| URL scheme | Browser | `https:` only, parsed; credentials, whitespace, control characters and any reinterpretation refused. |
| Download name | Browser | No separator, no traversal, no control character. |
| Surface ownership | Host | Only the session that published a surface answers for it — applied on `action` **and** on `resync`. |

The Host validates and relays; it never vouches for a user action. That split is the point:
the process that can see a user is the process that decides whether one acted.

### The user-activation window

`navigator.userActivation.isActive` is **transient**: measured in Chromium 1255, it stays true
for about **5 seconds** after a real gesture (a click, a key press, a tap) and then clears,
with no event to observe the change.

```text
   0ms -> true   ...   4003ms -> true
5004ms -> false  ...   9008ms -> false
```

The measurement matters: a test that samples from outside the page with an await between
samples never sees the lapse, because each DevTools protocol round trip counts as activity.
Sampling from a timer inside the page is what reveals the window. Two consequences shape the
executor:

- A request that arrives long after the click that produced it sees `isActive === false` and
  is refused with `gesture-required`. That is correct: the activation belonged to whatever the
  user did then, not to a model call later. The recovery is for the agent to ask the user to
  click again — the refusal message says so.
- The activation is **page-wide**, not per-element, so `isActive` alone would let a click on
  an unrelated control authorize a browser action elsewhere. That is why the confirmation
  dialog is a second, independent gate rather than a formality: activation proves "a user
  acted recently", the confirmation proves "a user agreed to this".

An absent `navigator.userActivation` (an old browser, a test environment) is read as
`false` — never as permission. A page that supplies no confirmation surface fails closed.

## Recovery

| Failure | Signal | Recovery |
| :-- | :-- | :-- |
| Host restart (store rebuilt) | `surfaceEpoch` changed | The new-epoch snapshot is adopted regardless of revision. |
| Client copy drifted | 3 consecutive unapplicable patches | `resync` RPC; the Host answers with snapshots built from its store. |
| Socket lost | close / error / idle | Bounded-backoff reconnect; the Host synthesizes a fresh baseline. |

## Agent presets

The tools register with `ToolRegistrationOptions.when`, so admission is per step: `minimal` cannot
call them, `standard` / `ptc` / `cordis` can. The guidance section resolves per assembly and adds
the creator lines (sidebar placement, renderer functions) only for `cordis`. A Host without the
preset registry admits, because refusing on missing data would silently disable the plugin.

## Configuration

| Config | Default | Meaning |
|---|---|---|
| `autoRender` | `true` | `false` switches to "only when requested or clearly needed", tightening both the prompt and the tool description |
| `catalogTool` | `true` | register the `a2ui_catalog` reference tool |
| `sectionOrder` | `120` | order of the prompt section |
| `muteSection` | `false` | drop the prompt section entirely (tools stay) |
| `toolName` | `a2ui` | not recommended: the inline process row registers under this name |

## Build and test pipeline

- `tools/build.mjs` compiles `src/**` with the TypeScript compiler API in-process (no esbuild: its native service needs pipes the Windows sandbox refuses), links the browser half into one `client.js`, and copies the Host ESM files into `lib/**`. It never deletes files; stale files are reported by path.
- `tools/run-tests.mjs` loads the test files into one process (no per-file child process). The suite includes protocol, unit, integration, acceptance, DOM (jsdom), streaming and limit cases.
- `tools/render-check.mjs` renders the shipped bundle with real React against the pinned official examples and synthetic cases.
- `tools/verify-bundle.mjs` checks the installable bundle invariants; `tools/verify-fresh-home.mjs` installs it into a throwaway DSH home and checks layout, bundle toggle and version skew.

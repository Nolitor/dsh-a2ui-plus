# The inline card and the sidebar tab, side by side

<!-- skeleton:
version: 1.0
kind: spec
status: active
updated: 2026-11-27
summary: How one SurfaceStore feeds two live views through a single ViewAdapter: the derived inline and full models, the one action dispatch with its 200ms idempotency window, and the session-switch teardown.
-->

> Owner instruction, 2026-11-27. This document states the shape the two-view renderer must keep.

## The defect this replaces

A `placement: "sidebar"` surface rendered its tab correctly and rendered the empty notice in the
conversation: *"this call produced no interface to display"*. The cause was structural, not
cosmetic. The card's only source was the tool call's durable `meta` copy, and a placement check
redirected every `sidebar` call to `{ messages: [] }` because painting the graph twice looked
worse than painting it once. Nothing re-derived the card from the live store, so once the tab
existed the conversation had no way to say so.

## The layers

| Layer | Owns | Must not |
| :-- | :-- | :-- |
| `ClientSurfaceStore` | frames, revisions, epochs, per-surface listener sets | know about views |
| `ViewAdapter` | subscriptions, derived models, the action exit, session identity | render, or talk to the Sidebar directly |
| `A2UIToolView` | React, the surface renderer, local edit state | read the store, or send a message |
| `TabRouter` | one registered tab type, one instance per surface | mint a second tab for one surface |

Views read *models*, never the store. That is the rule the earlier design broke: with two readers
there were two chances to disagree, and the disagreement was invisible because neither reader
was wrong on its own.

## The two models

`inlineModel(surfaceId)` — the conversation card. Title, up to four resolved `label`/`value` rows,
the component count and an "open in sidebar" control. When the placement resolves to `sidebar`,
`condensed` is true and `full` is **absent**: the card cannot paint the graph it is summarising,
even by accident.

`fullModel(surfaceId)` — the tab body. The stored surface, ready for the ordinary validator, plus
the title the tab shows. One surface, one full paint.

Both derive from the same stored surface, and the inline model folds the surface's own messages
through the same `validateToolArguments` the Host uses. A payload the Host accepted cannot render
as an empty card, and a payload it rejected cannot render as a full one.

## The action exit

```text
card button ─┐
             ├─→ adapter.dispatch({ surfaceId, sourceComponentId, actionId, text, sessionId })
tab button  ─┘        │
                      ├─ sessionId ≠ modelled session → { kind: 'cross-session' }, nothing sent
                      ├─ same triple inside 200ms     → { kind: 'duplicate' }, nothing sent
                      └─ otherwise                    → host.send(sessionId, text)
```

A duplicate resolves to the same visible state as a send (`sent`), because the first click already
delivered it; inviting a third click would be a lie. A **failure** clears the dedupe entry, so the
window that exists to stop double clicks can never swallow a legitimate retry.

`ACTION_DEDUPE_MS = 200`. The key is the whole triple: the same component with a different action
name, or the same action from a different component, is a different intent.

## The session switch

`onMountedSessionChanged(next)` runs in this order, and the order is the contract:

1. release every per-surface subscription held for the previous session;
2. drop the previous session's `surfaceOwners` entry;
3. clear the dedupe map;
4. track the new session's existing surfaces;
5. wake every listener once, so each view repaints — to nothing, if nothing is there.

Step 1 before step 4 is what makes a late frame for the old session harmless: there is no
subscription left to deliver it, and the per-listener identity check (`this.sessionId !== owner`)
is the second lock on the same door.

## Preserved invariants

The change added a layer; it did not move any of these:

| Invariant | Where it still lives |
| :-- | :-- |
| one mounted-session resolver | `sessionFor` in `src/client/index.ts` |
| a refused read fabricates nothing | `EMPTY_STORE` |
| no tab for a session that is not on screen | `syncTabs` |
| no paint from a session that is not on screen | `storeFor` |
| dead-wire gate | `npm run check:wires`, now 11 members |
| revision and epoch guards | `ClientSurfaceStore.apply` |
| gesture and URL-scheme guards | `RendererExecutor` |
| tab identity and focus | `TabRouter.open` with the `a2ui:{surfaceId}` seed |

## Who prevents duplicates

### Evidence types used below

| Label | Means | How to falsify |
| :-- | :-- | :-- |
| **[MEASURED]** | an observed value in this repo: a browser run, a test result, or a command's output | re-run the cited probe; a different value disproves it |
| **[TYPE-COMMENT]** | quoted from a `.d.ts` comment. It states intent, **not** behaviour | call the API and watch what it does |
| **[CODE]** | read from source; behaviour in the host version named in the row | change the host version, or call the path directly |

The three are not interchangeable, and the table keeps them apart on purpose. A comment can be
stale, code can be unreachable, and only a measurement settles what a given host actually does.

| Layer | What it actually does | Evidence | Cite |
| :-- | :-- | :-- | :-- |
| better-sidebar `openTab` | reuses an existing tab **only** when the descriptor has `dedupeKey`/`single` **and** the seed carries `meta` | **[CODE]** | `dsh-better-sidebar@0.33.0/lib/client.js:1886-1901` |
| better-sidebar seed `id` | honoured as the tab identity, so two opens with the same `id` land on one tab | **[MEASURED]** — two direct `tabs.open()` calls, plugin guard bypassed, produced `duplicates: 1` | `lib/client.js:1897-1909` (code) + isolated-home browser probe, 2026-11-27 |
| this plugin's descriptor | registers `id`, `title`, `icon`, `order`, `component` — **no** `dedupeKey`, **no** `single`, **no** `multiple` | **[CODE]** | `src/client/tabs.ts:238-246` |
| this plugin's guard | `tabIdFor(surfaceId)` decides open vs update | **[CODE]** + **[MEASURED]** (the guard-bypass probe above shows what happens without it) | `src/client/index.ts:291-301`, `:413-419`, `src/client/tabs.ts:262` |
| native right Sidebar | `revealIfOpened` deduplicates **resources**; "Pages always deduplicate within the target pane" | **[TYPE-COMMENT]** — not behaviour, and not relied on by this plugin | `dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:128-132` |
| seed-id forwarding | every open sends `tabIdOf(surfaceId)`, from one builder | **[MEASURED]** — two tests, each mutation-checked with a rebuilt bundle | `tests/tabs.test.mjs`: "every open forwards the same seed id…", "the seed id is written in exactly one place…" |

**Conclusion.** No framework-level `dedupeKey` protects this plugin ([CODE]). Two independent
guards do: the plugin's own `tabIdFor` branch ([CODE]) and the host's use of the seed id
([MEASURED]). The second was measured by bypassing the first: two direct `tabs.open()` calls
still produced **one** tab (`duplicates: 1`).

**The seed-id invariant is measured, not tested.** The host's tab store is absent from the unit
suite, so no test in this repo can replay that observation. What *is* tested is the half this repo
owns: that every open forwards `tabIdOf(surfaceId)` untouched, from exactly one builder.

> If the host stops honouring `seed.id`, the symptom is **N > 1 tabs for one surfaceId**.
> Detection: press `[사이드바에서 열기]` twice — a second tab means the host regressed.
> Fix: re-verify `dsh-better-sidebar`'s `openTab` dedup semantics before assuming the plugin
> guard is sufficient; do not add `dedupeKey` blindly, because the plugin's own branch is what
> keeps one tab per surface when the descriptor has none.

A future reader must not assume the framework collapses duplicates for this plugin. If the
descriptor were ever given `single: true`, that would add a third guard — it would not replace the
two that exist.
## What is not claimed

`openTab` deduplication is documented above ("Who prevents duplicates") with citations. The
residual risk is narrow and named: if a future host stopped honouring seeded ids **and** the
`tabIdFor` branch were removed, a second tab would appear. Neither has happened on the measured
host, and the mutation that removes the branch is caught by the two-view test in
`tests/dom.test.mjs` only for *dispatch*; the tab case is covered by the E2E bypass measurement.

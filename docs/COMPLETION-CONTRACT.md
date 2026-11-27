# Completion contract

<!-- skeleton:
version: 1.0
kind: policy
status: active
updated: 2026-11-27
summary: Two mandatory rules for this plugin: a dead-wire static gate before any "done" claim, and a reporting vocabulary that reserves "complete" for a verified browser.
-->

> Owner instruction, 2026-11-27. This document is the authority for what may be called done.

## Rule 1 — the dead-wire gate is mandatory

A hook declared on a runtime contract and never read is not a feature. It is a
promise the plugin never keeps.

Three defects in this track had exactly that shape, and every unit test passed
through all of them:

| Defect | Shape |
| :-- | :-- |
| `registerTab` probed once and gave up | declared, called once, silently failed |
| `openSurfaceTab` never called | assigned in the entry, zero readers |
| `connectDownlink` never called | assigned in the entry, zero readers |

`npm test` now runs `scripts/check-dead-wires.mjs` before the suite, and fails
when any member of `ClientRuntime` has no reader. A reader is a use outside the
assignment line — `runtime.foo = (…) => …` does not count as a call, which is the
rule a hand-written grep gets wrong.

```bash
npm run check:wires      # report
npm test                 # gate + suite
```

Deleting a redundant hook is a valid fix. Adding a caller is the other. Leaving
it and hoping is not.

## Rule 2 — two different words for two different states

| State | Meaning | Allowed wording |
| :-- | :-- | :-- |
| **Code complete, integration unverified** | Files built, gates green, the wire traced statically or in a unit test. No browser has rendered it. | "코드 완료, 통합 미검증" |
| **Complete** | A real browser, on the real host, showed the result on screen. | "Complete" |

Never "complete", "working", "done" or "finished" before the second state. This is
not pessimism: in this track "tests green" coexisted with a tab type that never
registered and a socket that never opened. The words have to carry that
distinction or the report is worthless.

When reporting an unverified integration, state **what would falsify it** — the
specific thing to look at on screen, and which component to suspect if it is
absent.

## The check that produced this rule

```text
measured, browser:  right Sidebar open, only the generic tab, dashboard inline
claimed before:     "rendered, sidebar placement"
missing wire:       openSurfaceTab had no caller at all
```

The measurement was one sentence from the owner. It invalidated three rounds of
green test output. A static gate would have caught it in the first round.

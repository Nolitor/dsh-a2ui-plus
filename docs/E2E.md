# Running the browser end-to-end suite

<!-- skeleton:
version: 1.0
kind: reference
status: active
updated: 2026-11-27
summary: How to stand up an isolated DSH host with better-sidebar and run the Playwright suite, plus what each case proves and what it cannot.
-->

> The suite in `tests/e2e/` drives a real Chromium against a real DSH host. It is not part of
> `npm test`: it needs a running server, and it is slow by nature (about 30 seconds).

## Prerequisites

- A Chromium from the Playwright cache (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`).
- An **isolated** `DSH_HOME`, so the live profile is never touched.
- Both plugins installed in that home: this package and `dsh-better-sidebar`.

## Stand it up

```bash
export DSH_HOME=/tmp/a2ui-plus-verify
rm -rf "$DSH_HOME" && mkdir -p "$DSH_HOME"

dsh plugin --profile web add /home/minami/Workspace/projects/dsh-workspace/dsh-plugins/dsh-a2ui-plus
dsh plugin --profile web add dsh-better-sidebar@0.33.0

setsid nohup dsh --profile web --port 3099 --host 127.0.0.1 --no-open \
  > /tmp/a2ui-e2e-server.log 2>&1 < /dev/null &

# The launch URL carries the token; the browser exchanges it for a cookie.
grep -o 'http://127.0.0.1:3099/?token=[A-Za-z0-9_-]*' /tmp/a2ui-e2e-server.log
```

A profile that failed to activate prints `N entry did not activate` and the reason. Zero such
lines is the precondition for the suite.

## Run it

```bash
cd dsh-a2ui-plus
E2E_URL='<the printed URL>' \
E2E_CHROMIUM="$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" \
node --test tests/e2e/
```

Without `E2E_URL` the suite reports itself skipped rather than failing.

## What each case proves

| Case | What it establishes |
| :-- | :-- |
| bundle loads | The served bundle links and its `apply()` ran (its stylesheet is in the document). |
| subprotocol | A real `WebSocket` negotiates `a2ui-plus.v1`. |
| activation window | A real click sets `userActivation.isActive`, and the window lapses in about 5s. |
| positive path | A trusted click plus an accepted dialog writes the clipboard — verified by reading it back. |
| declined dialog | Activation alone does not authorize: dismissing the dialog performs nothing. |
| URL schemes | `javascript:`, `data:`, `http:` and `file:` never reach `window.open`, even after a click. |
| sidebar tab | The real sidebar lists the plugin's tab type and opens it from its guide. |
| foreign surface | A surface keyed to a session that is not on screen opens no tab and paints nothing. |
| inline card | A `sidebar` surface also paints a condensation in the conversation: `componentCount >= 1`, at least one row, and the tab still open — both views alive off one store. |
| session switch | After `onMountedSessionChanged`, the previous surface has no inline and no full model, and the new session's store does not hold it. |
| narrow downgrade | At 767px a `sidebar` placement resolves to `inline`. |
| wide viewport | At 1280px it stays `sidebar`. |

## Host chrome the suite must dismiss

A fresh `DSH_HOME` raises its own modals before the app is usable, and each one sets `inert` on the
app root, so a real click never lands. Measured 2026-11-27:

| Prompt | Controls | Where the dismissal goes |
| :-- | :-- | :-- |
| `Preview Notice` (0.2) | one primary **Continue**, **no** `aria-label="Close"` | the dialog's own button |
| `Get started` (account) | X with `aria-label="Close"` | that control |

`openPage` therefore clicks "the modal's first enabled control", not "Close" specifically. The
narrower locator was the first version of this loop and it silently matched nothing, leaving the
notice up and the app inert for the whole run — every click-based case then failed on a host
dialog rather than on the renderer. This is host chrome, not a plugin defect, and must not be
worked around by weakening an assertion.

## What it cannot prove, and why

- **A surface rendered inside the sidebar tab.** Publishing a surface needs a model turn, and
  DSH 0.2.3-alpha.2 has no headless prompt entry. The tab opens and the plugin owns its body
  slot; the surface body itself is covered by the DOM suite (`tests/dom.test.mjs`) instead.
- **The upgrade ladder end to end.** `STATE_DELTA` handling is measured against the compiled
  Host modules (`tests/store.test.mjs`, `tests/surface-store.test.mjs`), which is a stronger
  check of the wire contract than pixels would be, but it is not a browser.
- **Non-Chromium engines.** Only Chromium is exercised.

## The measurement trap

`userActivation.isActive` cannot be sampled across two `evaluate` calls: each protocol round
trip counts as activity and refreshes the window, so the lapse never appears. Sample from a
timer **inside** one evaluate. The same trap applies to any test that reuses one click for
several gated calls — give each call its own gesture.

/**
 * The cross-session invariant, pinned as a unit test.
 *
 * Two rules, both enforced in `src/client/index.ts`:
 *
 * 1. **One resolver.** `sessionFor` is the only place that falls back from a
 *    view's own `sessionId` to the session the Sidebar shows. An earlier version
 *    resolved in both the view and the store accessor, so removing either one
 *    alone still passed every test — the other silently covered for it.
 * 2. **No foreign surface.** `syncTabs` refuses to open a tab for a session that
 *    is not on screen, and `storeFor` refuses to hand out its store. A mismatch
 *    cannot reach the DOM by either route.
 *
 * The browser suite proves the behaviour; this file proves the shape, so a
 * regression fails fast instead of only in a Chromium run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../src/client/index.ts', import.meta.url)
const VIEW = new URL('../src/client/tool-view.tsx', import.meta.url)

/** The client entry's source. */
async function clientSource() {
  return await readFile(CLIENT, 'utf8')
}

test('exactly one resolver owns the mounted-session fallback', async () => {
  const source = await clientSource()
  // The fallback chain: a service snapshot, then the DOM attribute. It lives in
  // one function and nowhere else.
  const snapshotReads = source.match(/right\?\.mounted\?\.getSnapshot\?\.\(\)/gu) ?? []
  assert.equal(snapshotReads.length, 1, 'the service snapshot is read in exactly one place')
  const domReads = source.match(/querySelector\('\[data-sidebar-right-session\]'\)/gu) ?? []
  assert.equal(domReads.length, 1, 'the DOM fallback is read in exactly one place')
  assert.match(source, /const sessionFor = \(sessionId: string \| undefined\)/, 'the resolver exists under its name')
})

test('the store accessor does not resolve on its own', async () => {
  const source = await clientSource()
  // `runtime.surfaceStore` must not call `mountedSession()`: that was the second
  // fallback, and it made a missing first one invisible.
  const accessor = /runtime\.surfaceStore = \(sessionId: string\) => ([^\n]+)/u.exec(source)
  assert.ok(accessor !== null, 'the accessor is assigned')
  assert.ok(!/mountedSession/u.test(accessor[1]), `the accessor must not resolve: ${accessor[1]}`)
  assert.match(accessor[1], /storeFor\(/, 'the accessor goes through the guarded read')
})

test('the view delegates resolution instead of re-implementing it', async () => {
  const view = await readFile(VIEW, 'utf8')
  assert.match(view, /runtime\.sessionFor\?\.\(sessionId\)/, 'the view asks the resolver')
  assert.ok(
    !/runtime\.mountedSession/u.test(view),
    'the view must not read the raw mounted session and build its own chain',
  )
})

test('a session that is not on screen is refused on both paths', async () => {
  const source = await clientSource()
  // Write path.
  assert.match(
    source,
    /onScreen !== undefined && onScreen !== sessionId[\s\S]{0,200}refusing to open tabs/u,
    'syncTabs refuses to open a tab for a foreign session',
  )
  // Read path.
  assert.match(
    source,
    /onScreen !== sessionId[\s\S]{0,200}refusing to read a store/u,
    'storeFor refuses to hand out a foreign store',
  )
})

test('a refusal never fabricates a surface', async () => {
  const source = await clientSource()
  // A denied read returns an empty store, not a populated one: the view must not
  // be able to paint data it was refused.
  assert.match(source, /EMPTY_STORE = new ClientSurfaceStore\(\)/u, 'the shared empty store exists')
  assert.match(source, /runtime\.surfaceStore = \(sessionId: string\) => storeFor\(sessionId\) \?\? EMPTY_STORE/u)
})

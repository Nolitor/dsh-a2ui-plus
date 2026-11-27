/**
 * The sidebar tab router: one registered type, one instance per surface, in-place
 * updates, narrow downgrade and refresh reconciliation.
 *
 * The `betterSidebar` service is stubbed here, because the contract under test is
 * how this plugin *uses* it — which id it seeds, when it updates instead of
 * opening, and what it persists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  ClientSurfaceStore,
  TAB_EPOCH_KEY,
  TAB_ID,
  TAB_ID_PREFIX,
  TAB_MAP_KEY,
  TabRouter,
  isSurfaceTabId,
  makeTabBody,
  surfaceIdOf,
  tabIdOf,
  tabMapStorage,
} from '../build/shared.mjs'

/** An in-memory `Storage`. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    get length() {
      return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    clear: () => data.clear(),
    data_() {
      return Object.fromEntries(data)
    },
  }
}

/** A `betterSidebar` stand-in recording every call. */
function sidebarStub({ withUpdateTab = true } = {}) {
  const calls = { registerTab: [], openTab: [], updateTab: [] }
  let registered
  const service = {
    registerTab(descriptor) {
      calls.registerTab.push(descriptor)
      registered = descriptor
      return () => {
        registered = undefined
      }
    },
    openTab(seed, scope) {
      calls.openTab.push({ seed, scope })
    },
    getTabs() {
      return registered === undefined ? [] : [registered]
    },
  }
  if (withUpdateTab) {
    service.updateTab = (tabId, patch, sessionId) => {
      calls.updateTab.push({ tabId, patch, sessionId })
    }
  }
  return { service, calls }
}

/** A client context whose `get` resolves one service, recording effects. */
function clientContext(services = {}) {
  const effects = []
  return {
    get: (name) => services[name],
    effect(factory, label) {
      const cleanup = factory()
      effects.push({ label, cleanup })
      return cleanup
    },
    logger: { warn() {} },
    effects_() {
      return effects
    },
  }
}

test('the generic type is registered once, with a locale-aware title', () => {
  const { service, calls } = sidebarStub()
  const ctx = clientContext({ betterSidebar: service })
  const router = new TabRouter(ctx, undefined, memoryStorage())

  let localeTitle = 'Generative UI'
  assert.equal(router.register(() => null, () => localeTitle), true)
  assert.equal(calls.registerTab.length, 1)
  assert.equal(calls.registerTab[0].id, TAB_ID)
  assert.equal(calls.registerTab[0].title(), 'Generative UI')
  localeTitle = '생성형 UI'
  assert.equal(calls.registerTab[0].title(), '생성형 UI', 'the thunk follows the locale')

  assert.equal(router.register(() => null, () => 'again'), false, 'a second mount registers nothing')
  assert.equal(calls.registerTab.length, 1)
  assert.deepEqual(ctx.effects_().map((effect) => effect.label), ['a2ui-plus: sidebar tab type'])
})

test('a profile without betterSidebar registers nothing and degrades quietly', () => {
  const ctx = clientContext()
  const router = new TabRouter(ctx, undefined, memoryStorage())
  assert.equal(router.register(() => null, () => 'x'), false)
  assert.deepEqual(router.open('card', 'Card', { sessionId: 's1' }), { rendered: 'inline', reason: 'unavailable' })
})

test('each surface opens its own instance id', () => {
  const { service, calls } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, memoryStorage())

  const first = router.open('card', 'Revenue', { sessionId: 's1' })
  assert.deepEqual(first, { rendered: 'tab', tabId: 'a2ui:card' })
  router.open('form', 'Approval', { sessionId: 's1' })

  assert.equal(calls.openTab.length, 2)
  assert.deepEqual(calls.openTab[0].seed, { type: TAB_ID, id: 'a2ui:card', title: 'Revenue', meta: { surfaceId: 'card' } })
  assert.deepEqual(calls.openTab[1].seed, { type: TAB_ID, id: 'a2ui:form', title: 'Approval', meta: { surfaceId: 'form' } })
  assert.deepEqual(calls.openTab[0].scope, { sessionId: 's1' }, 'the scope targets the owning session')
})

test('opening the same surface twice reuses its id instead of minting a new one', () => {
  const { service, calls } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, memoryStorage())
  router.open('card', 'Revenue', { sessionId: 's1' })
  router.open('card', 'Revenue v2', { sessionId: 's1' })
  assert.deepEqual(calls.openTab.map((call) => call.seed.id), ['a2ui:card', 'a2ui:card'])
})

test('a STATE_DELTA updates the tab in place rather than opening another', () => {
  const store = new ClientSurfaceStore()
  store.apply({
    type: 'ACTIVITY_SNAPSHOT',
    surfaceId: 'card',
    surfaceRevision: 4,
    content: { surfaceId: 'card', placement: 'sidebar', messages: [], dataModel: { v: 1 }, components: [] },
    replace: true,
  })
  const { service, calls } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), store, memoryStorage())
  router.open('card', 'Revenue', { sessionId: 's1' })

  assert.equal(router.update('card', 'Revenue (2)', { sessionId: 's1' }), true)
  assert.equal(calls.updateTab.length, 1)
  assert.equal(calls.updateTab[0].tabId, 'a2ui:card')
  assert.equal(calls.updateTab[0].patch.title, 'Revenue (2)')
  assert.equal(calls.updateTab[0].patch.meta.surfaceId, 'card')
  assert.equal(calls.updateTab[0].patch.meta.revision, 4, 'the tab carries the surface revision')
  assert.equal(calls.updateTab[0].sessionId, 's1')
  assert.equal(calls.openTab.length, 1, 'no second tab was opened')
})

test('an update without a title still publishes the revision', () => {
  const store = new ClientSurfaceStore()
  store.apply({
    type: 'ACTIVITY_SNAPSHOT',
    surfaceId: 'card',
    surfaceRevision: 2,
    content: { surfaceId: 'card', placement: 'sidebar', messages: [], dataModel: {}, components: [] },
    replace: true,
  })
  const { service, calls } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), store, memoryStorage())
  router.open('card', 'Card', { sessionId: 's1' })
  router.update('card', undefined, { sessionId: 's1' })
  assert.equal(calls.updateTab[0].patch.title, undefined)
  assert.equal(calls.updateTab[0].patch.meta.revision, 2)
})

test('a service without updateTab is tolerated', () => {
  const { service } = sidebarStub({ withUpdateTab: false })
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, memoryStorage())
  assert.equal(router.update('card', 'x'), false)
})

test('the surface to tab mapping is persisted and reloaded', () => {
  const storage = memoryStorage()
  const { service } = sidebarStub()
  const first = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  first.open('card', 'Revenue', { sessionId: 's1' })
  assert.deepEqual(JSON.parse(storage.getItem(TAB_MAP_KEY)), { card: 'a2ui:card' })

  // A fresh page reads the same mapping back before any frame arrives.
  const second = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  assert.equal(second.tabIdFor('card'), 'a2ui:card')
  assert.deepEqual(second.mapped(), { card: 'a2ui:card' })
})


/**
 * The seed-id invariant, pinned at the layer that owns it.
 *
 * Measured 2026-11-27 (isolated home, host 3098): better-sidebar reuses an open tab
 * only when the descriptor supplies `dedupeKey`/`single` AND the seed carries `meta`
 * (`dsh-better-sidebar@0.33.0/lib/client.js:1886-1901`). This plugin registers neither
 * (`src/client/tabs.ts:238-246`), so the framework does NOT stop a duplicate. What does
 * is the seed id: the host honours `seed.id` as the tab identity, and two opens with
 * `a2ui:{surfaceId}` land on one tab. That was OBSERVED (`duplicates: 1`) with the
 * plugin guard bypassed — it is not something this test can prove, and the test says so.
 *
 * What this test does prove, which is the half this repo owns: every open forwards
 * `tabIdOf(surfaceId)` untouched, and the router's mapping records the same value it
 * sent. If either drifts, two opens name two different tabs and the host will gladly
 * make two.
 */
test('every open forwards the same seed id the mapping records', () => {
  const { service, calls } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, memoryStorage())

  router.open('card', 'Revenue', { sessionId: 's1' })
  router.open('card', 'Revenue again', { sessionId: 's1' })
  router.open('other', 'Other', { sessionId: 's1' })

  const ids = calls.openTab.map(({ seed }) => seed.id)
  assert.deepEqual(ids, ['a2ui:card', 'a2ui:card', 'a2ui:other'], 'the seed id is tabIdOf(surfaceId), never re-minted')
  // The mapping must record exactly what was sent: a mismatch is what would make the
  // second open name a different tab than the first.
  for (const { seed } of calls.openTab) {
    const surfaceId = seed.meta.surfaceId
    assert.equal(router.tabIdFor(surfaceId), seed.id, 'the recorded id is the forwarded id')
    assert.equal(seed.id, tabIdOf(surfaceId), 'and it is the shared tabIdOf function')
    assert.equal(seed.type, TAB_ID)
  }
})

test('the seed id is written in exactly one place in the client source', async () => {
  // A call site cannot bypass `tabIdOf` by passing an id of its own: `TabRouter.open`
  // is the only function that builds a seed, and it builds the id from tabIdOf. This
  // asserts that shape rather than trusting it, because a second call site is exactly
  // how the two-view change could have introduced a bypass.
  //
  // The scanned set is every client module that can reach a sidebar open, named so the
  // scope of this gate is auditable rather than implied:
  //   tabs.ts         — owns TabRouter.open, the one seed builder
  //   index.ts        — constructs the adapter, wires runtime.openSurfaceTab, syncTabs
  //   view-adapter.ts — openInSidebar, which forwards to the host's openTab callback
  //   tool-view.tsx   — the card's [사이드바에서 열기] button
  // A fifth module would have to be added here deliberately; that is the point.
  const files = ['tabs.ts', 'index.ts', 'view-adapter.ts', 'tool-view.tsx']
  const builders = []
  for (const file of files) {
    const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/service\.openTab\s*\(/gu)) {
      const line = source.slice(0, match.index).split('\n').length
      builders.push(`${file}:${line}`)
    }
  }
  // Count, not a line number: pinning line 289 made this fail on a comment-only edit,
  // which is a brittle assertion that punishes refactoring without catching anything.
  assert.equal(builders.length, 1, `exactly one seed builder, in TabRouter.open; got ${JSON.stringify(builders)}`)
})

test('reconciling drops entries whose surface is gone', () => {
  const storage = memoryStorage({
    [TAB_MAP_KEY]: JSON.stringify({ card: 'a2ui:card', stale: 'a2ui:stale' }),
  })
  const { service } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)

  assert.deepEqual(router.reconcile(['card']), ['stale'])
  assert.equal(router.tabIdFor('stale'), undefined)
  assert.deepEqual(JSON.parse(storage.getItem(TAB_MAP_KEY)), { card: 'a2ui:card' })
  assert.deepEqual(router.reconcile(['card']), [], 'a second reconcile finds nothing to drop')
})

test('a changed epoch clears the entire mapping', () => {
  const storage = memoryStorage()
  const { service } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  router.open('a', 'A', { sessionId: 's1' })
  router.open('b', 'B', { sessionId: 's1' })
  router.reconcile(['a', 'b'], 'epoch-A')
  assert.equal(storage.getItem(TAB_EPOCH_KEY), 'epoch-A', 'the first reconcile records the epoch')

  // The Host restarted: its store is new, so every mapped tab describes a
  // surface that no longer exists.
  const dropped = router.reconcile(['a', 'b'], 'epoch-B')
  assert.deepEqual(dropped.sort(), ['a', 'b'])
  assert.deepEqual(router.mapped(), {})
  assert.equal(storage.getItem(TAB_EPOCH_KEY), 'epoch-B')
})

test('the same epoch keeps membership reconciliation', () => {
  const storage = memoryStorage()
  const { service } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  router.open('a', 'A', { sessionId: 's1' })
  router.reconcile(['a'], 'epoch-A')
  assert.deepEqual(router.reconcile(['a'], 'epoch-A'), [], 'nothing to drop inside one epoch')
  assert.deepEqual(router.reconcile([], 'epoch-A'), ['a'], 'a vanished surface is dropped')
})

test('an unknown epoch is recorded without dropping anything', () => {
  const storage = memoryStorage()
  const { service } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  router.open('a', 'A', { sessionId: 's1' })
  assert.deepEqual(router.reconcile(['a'], 'epoch-A'), [], 'a first sighting is not a restart')
  assert.deepEqual(router.mapped(), { a: 'a2ui:a' })
})

test('a mapping written under a different epoch is discarded on reload', () => {
  const storage = memoryStorage({
    [TAB_MAP_KEY]: JSON.stringify({ stale: 'a2ui:stale' }),
    [TAB_EPOCH_KEY]: 'epoch-old',
  })
  const { service } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  assert.deepEqual(router.reconcile([], 'epoch-new'), ['stale'])
  assert.deepEqual(router.mapped(), {})
})

test('forgetting a surface removes only its entry', () => {
  const storage = memoryStorage()
  const { service } = sidebarStub()
  const router = new TabRouter(clientContext({ betterSidebar: service }), undefined, storage)
  router.open('a', 'A', { sessionId: 's1' })
  router.open('b', 'B', { sessionId: 's1' })
  router.forget('a')
  assert.deepEqual(router.mapped(), { b: 'a2ui:b' })
})

test('a corrupt mapping is ignored rather than thrown', () => {
  for (const raw of ['not json', '[]', 'null', '{"a":42}']) {
    const storage = memoryStorage({ [TAB_MAP_KEY]: raw })
    const router = new TabRouter(clientContext({ betterSidebar: sidebarStub().service }), undefined, storage)
    assert.deepEqual(router.mapped(), {}, `"${raw}" must not become a mapping`)
  }
})

test('the tab id grammar round-trips and excludes the generic type', () => {
  assert.equal(tabIdOf('card'), 'a2ui:card')
  assert.equal(isSurfaceTabId('a2ui:card'), true)
  assert.equal(isSurfaceTabId(TAB_ID), false, 'the generic type is not a surface instance')
  assert.equal(isSurfaceTabId(undefined), false)
  assert.equal(surfaceIdOf(`${TAB_ID_PREFIX}my:surface`), 'my:surface')
})

test('the tab body resolves the surface from the tab id', () => {
  const seen = []
  const body = makeTabBody(undefined, (surfaceId) => {
    seen.push(surfaceId)
    return null
  })
  body({ tab: { id: 'a2ui:card' } })
  body({ tab: { id: TAB_ID } })
  assert.deepEqual(seen, ['card'], 'the generic tab renders nothing of its own')
})

test('a storage that throws is survivable', () => {
  const hostile = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
  }
  const storage = tabMapStorage(hostile)
  assert.deepEqual(storage.read(), {})
  storage.write({ a: 'b' })
})

/**
 * The view mediator: one surface subscription per view, one dispatch exit, one
 * session-switch teardown.
 *
 * These are the four behaviours the two-view design depends on, pinned as units so
 * a regression fails in a second instead of only in a Chromium run:
 *
 * 1. an inline model exists for a `sidebar` surface (the empty-card defect),
 * 2. a store subscription is per surface, not per store,
 * 3. the same click from both views sends once,
 * 4. a session switch leaves nothing behind.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ClientSurfaceStore, ViewAdapter, inlineModelOf, ACTION_DEDUPE_MS, INLINE_ROW_LIMIT } from '../build/shared.mjs'

/** A snapshot frame for one surface, in the shape the Host emits. */
function snapshot(surfaceId, { placement = 'inline', title, components, dataModel = {}, revision = 1 } = {}) {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId,
        catalogId: 'dsh-a2ui/catalog/v1',
        components: components ?? [
          { id: 'root', component: 'Column', children: ['k1', 'k2'] },
          { id: 'k1', component: 'Stat', label: 'CPU', value: '0.55' },
          { id: 'k2', component: 'Stat', label: 'Memory', value: '8 GB' },
        ],
        dataModel,
      },
    },
  ]
  return {
    type: 'ACTIVITY_SNAPSHOT',
    surfaceId,
    surfaceRevision: revision,
    surfaceEpoch: 'test',
    activityType: 'a2ui.surface',
    messageId: surfaceId,
    content: { surfaceId, placement, ...(title === undefined ? {} : { title }), messages, dataModel, components: [] },
    replace: true,
  }
}

/** An adapter wired to one store, recording what it sent and opened. */
function harness({ sessionId = 'session-a', width = 1280, send } = {}) {
  const stores = new Map()
  const storeOf = (id) => {
    let store = stores.get(id)
    if (store === undefined) {
      store = new ClientSurfaceStore()
      stores.set(id, store)
    }
    return store
  }
  const sent = []
  const opened = []
  let clock = 1_000
  const adapter = new ViewAdapter({
    storeFor: (id) => (id === undefined ? undefined : storeOf(id)),
    mountedSession: () => sessionId,
    send: send ?? (async (id, text) => {
      sent.push({ sessionId: id, text })
    }),
    openTab: (surfaceId, title, id) => {
      opened.push({ surfaceId, title, sessionId: id })
      return true;
    },
    now: () => clock,
  })
  adapter.onMountedSessionChanged(sessionId)
  return {
    adapter,
    storeOf,
    sent,
    opened,
    advance: (ms) => {
      clock += ms;
    },
    setWidth: (next) => {
      globalThis.window = { innerWidth: next };
    },
    width,
  };
}

test('a sidebar surface yields a non-empty inline model', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', { placement: 'sidebar', title: 'System Status' }));
  const model = inlineModelOf(store.get('card'), 1280, 'Generative UI')
  assert.equal(model.surfaceId, 'card')
  assert.equal(model.title, 'System Status')
  assert.equal(model.placement, 'sidebar')
  assert.equal(model.condensed, true, 'a tab-owned surface summarises in the conversation')
  assert.ok(model.componentCount >= 1, `the model counts the components: ${model.componentCount}`)
  assert.ok(model.rows.length >= 1, 'the summary carries resolved rows, not an empty body')
  assert.deepEqual(model.rows[0], { id: 'k1', label: 'CPU', value: '0.55' })
  assert.equal(model.full, undefined, 'a condensed card must not carry the full graph')
})

test('an inline surface keeps its full graph for the card', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('inline-card', { placement: 'inline' }))
  const model = inlineModelOf(store.get('inline-card'), 1280, 'Generative UI')
  assert.equal(model.condensed, false)
  assert.ok(model.full !== undefined, 'the card may paint the graph when the placement is inline')
  assert.equal(model.full.components.size, 3)
  assert.equal(model.title, 'Generative UI', 'an untitled surface falls back to the plugin name')
})

test('a narrow viewport condenses a sidebar surface all the same', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('narrow', { placement: 'sidebar', title: 'Narrow' }))
  const model = inlineModelOf(store.get('narrow'), 767, 'Generative UI')
  assert.equal(model.placement, 'inline', 'a downgrade is what the resolver says it is')
  assert.equal(model.condensed, false, 'and the card may then paint it in full')
})

test('the summary bounds its rows and says how many it dropped', () => {
  const components = [{ id: 'root', component: 'Column', children: ['a', 'b', 'c', 'd', 'e', 'f'] }]
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) components.push({ id, component: 'Stat', label: id.toUpperCase(), value: String(components.length) })
  const store = new ClientSurfaceStore()
  store.apply(snapshot('many', { placement: 'sidebar', components }))
  const model = inlineModelOf(store.get('many'), 1280, 'Generative UI')
  assert.equal(model.rows.length, INLINE_ROW_LIMIT)
  assert.equal(model.hiddenRows, 6 - INLINE_ROW_LIMIT)
})

test('a subscription wakes only the views of its own surface', () => {
  const { adapter, storeOf } = harness()
  const store = storeOf('session-a')
  store.apply(snapshot('one', { placement: 'sidebar' }))
  store.apply(snapshot('two', { placement: 'sidebar' }))
  let one = 0
  let two = 0
  const offOne = adapter.subscribeInline('one', () => {
    one += 1;
  })
  const offTwo = adapter.subscribeInline('two', () => {
    two += 1;
  })
  store.apply({ ...snapshot('one', { placement: 'sidebar', revision: 2 }) })
  assert.equal(one, 1, 'the surface that changed woke its view')
  assert.equal(two, 0, 'the surface that did not change woke nothing')
  offOne()
  offTwo()
  store.apply({ ...snapshot('one', { placement: 'sidebar', revision: 3 }) })
  assert.equal(one, 1, 'an unsubscribed view is not woken')
})

test('one click repeated across both views sends once', async () => {
  const { adapter, storeOf, sent, advance } = harness()
  storeOf('session-a').apply(snapshot('form', { placement: 'sidebar' }))
  const request = { surfaceId: 'form', sourceComponentId: 'submit', actionId: 'save', text: '[A2UI action] save', sessionId: 'session-a' }
  const first = await adapter.dispatch(request)
  // The second view's click lands inside the window, unadvanced.
  const second = await adapter.dispatch(request)
  assert.equal(first.kind, 'sent')
  assert.equal(second.kind, 'duplicate', 'the same action inside 200ms is a double click')
  assert.equal(sent.length, 1, 'the agent receives it once')
  advance(ACTION_DEDUPE_MS + 1)
  const third = await adapter.dispatch(request)
  assert.equal(third.kind, 'sent', 'a deliberate second click after the window still sends')
  assert.equal(sent.length, 2)
})

test('a different component or action is not a duplicate', async () => {
  const { adapter, storeOf, sent } = harness()
  storeOf('session-a').apply(snapshot('form', { placement: 'sidebar' }))
  const base = { surfaceId: 'form', sourceComponentId: 'submit', actionId: 'save', text: 'x', sessionId: 'session-a' }
  await adapter.dispatch(base)
  await adapter.dispatch({ ...base, sourceComponentId: 'other' })
  await adapter.dispatch({ ...base, actionId: 'cancel' })
  assert.equal(sent.length, 3, 'the dedupe key is the whole triple')
})

test('an action for a session that is not on screen is refused', async () => {
  const { adapter, sent } = harness()
  const outcome = await adapter.dispatch({
    surfaceId: 'card',
    sourceComponentId: 'submit',
    actionId: 'save',
    text: 'x',
    sessionId: 'session-b',
  })
  assert.equal(outcome.kind, 'cross-session')
  assert.equal(sent.length, 0, 'nothing left the renderer')
})

test('a failed send leaves the button retryable', async () => {
  let attempts = 0
  const { adapter, storeOf } = harness({
    send: async () => {
      attempts += 1;
      throw new Error('no session open');
    },
  })
  storeOf('session-a').apply(snapshot('card', { placement: 'sidebar' }))
  const request = { surfaceId: 'card', sourceComponentId: 'submit', actionId: 'save', text: 'x', sessionId: 'session-a' }
  const first = await adapter.dispatch(request)
  assert.equal(first.kind, 'failed')
  assert.equal(first.message, 'no session open')
  // The dedupe entry was cleared, so an immediate retry is not swallowed.
  const retry = await adapter.dispatch(request)
  assert.equal(retry.kind, 'failed')
  assert.equal(attempts, 2, 'a failure must not burn the dedupe window')
})

test('a session switch releases every subscription it held', () => {
  const stores = new Map()
  /** Per session, the number of per-surface subscriptions currently attached. */
  const live = new Map()
  const storeOf = (id) => {
    let store = stores.get(id)
    if (store === undefined) {
      store = new ClientSurfaceStore()
      // Count the real subscription the adapter takes, so "released" is measured
      // rather than inferred from behaviour a second guard happens to cover.
      const subscribe = store.subscribeSurface.bind(store)
      store.subscribeSurface = (surfaceId, listener) => {
        live.set(id, (live.get(id) ?? 0) + 1)
        let released = false
        const off = subscribe(surfaceId, listener)
        return () => {
          if (released) return
          released = true
          live.set(id, (live.get(id) ?? 1) - 1)
          off()
        }
      }
      stores.set(id, store)
    }
    return store;
  }
  const adapter = new ViewAdapter({
    storeFor: (id) => (id === undefined ? undefined : storeOf(id)),
    mountedSession: () => 'session-b',
    send: async () => {},
    openTab: () => true,
  })
  adapter.onMountedSessionChanged('session-a')
  storeOf('session-a').apply(snapshot('a-surface', { placement: 'sidebar', title: 'A Only' }))
  let woke = 0
  const off = adapter.subscribeInline('a-surface', () => {
    woke += 1;
  })
  assert.ok(adapter.inlineModel('a-surface') !== undefined, 'A is on screen before the switch')

  adapter.onMountedSessionChanged('session-b')
  // The model is gone the moment the session changes, before any B frame.
  assert.equal(adapter.inlineModel('a-surface'), undefined, 'A is not readable from B')
  assert.deepEqual(adapter.surfacesOf('session-a'), [], 'A holds no tracked surface after the switch')
  // The switch itself wakes the view once: it has to repaint, and repainting now
  // yields nothing. That is the safe direction — the alternative is a stale card
  // left on screen because nobody told it to re-read.
  const wokeBySwitch = woke
  assert.equal(wokeBySwitch, 1, 'the switch asks each view to repaint exactly once')
  assert.equal(live.get('session-a'), 0, 'the previous session holds no live subscription')
  // A late frame for A must not repaint anything, which is the leak that matters.
  storeOf('session-a').apply(snapshot('a-surface', { placement: 'sidebar', revision: 2 }))
  assert.equal(woke, wokeBySwitch, 'a frame for the previous session woke no view')
  off()
})

test('opening the side column uses the surface title and the modelled session', () => {
  const { adapter, storeOf, opened } = harness()
  storeOf('session-a').apply(snapshot('card', { placement: 'sidebar', title: 'System Status' }))
  assert.equal(adapter.openInSidebar('card'), true)
  assert.deepEqual(opened, [{ surfaceId: 'card', title: 'System Status', sessionId: 'session-a' }])
  assert.equal(adapter.openInSidebar('missing'), false, 'an unknown surface opens nothing')
})

test('a disposed adapter stops waking views and refuses actions', async () => {
  const { adapter, storeOf } = harness()
  storeOf('session-a').apply(snapshot('card', { placement: 'sidebar' }))
  let woke = 0
  adapter.subscribeInline('card', () => {
    woke += 1;
  })
  adapter.dispose()
  storeOf('session-a').apply(snapshot('card', { placement: 'sidebar', revision: 2 }))
  assert.equal(woke, 0, 'teardown releases the store subscription')
  const outcome = await adapter.dispatch({ surfaceId: 'card', sourceComponentId: 'x', actionId: 'y', text: 'z', sessionId: 'session-a' })
  assert.equal(outcome.kind, 'failed')
})


/**
 * The browser surface store and its socket: revision guards, partial patches,
 * placement downgrade and reconnect.
 *
 * These exercise the compiled browser modules through the shared harness, so the
 * same code the bundle ships is what runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ClientSurfaceStore,
  DownlinkClient,
  applyOperation,
  downlinkUrl,
  effectivePlacement,
  escapePointer,
  isNarrowWidth,
  segmentsOf,
} from '../build/shared.mjs'

/** One snapshot frame as the Host produces it. */
function snapshot(surfaceId, revision, extra = {}) {
  return {
    type: 'ACTIVITY_SNAPSHOT',
    surfaceId,
    activityType: 'a2ui.surface',
    messageId: surfaceId,
    surfaceRevision: revision,
    content: {
      surfaceId,
      placement: 'inline',
      catalogId: 'dsh-a2ui/catalog/v1',
      messages: [{ version: '1.0' }],
      dataModel: {},
      components: [{ id: 'root', component: 'Column' }],
      ...extra,
    },
    replace: true,
  }
}

/** One delta frame. */
function delta(surfaceId, revision, operations) {
  return { type: 'STATE_DELTA', surfaceId, surfaceRevision: revision, delta: operations }
}

test('a snapshot creates a surface with its revision', () => {
  const store = new ClientSurfaceStore()
  assert.equal(store.apply(snapshot('card', 1)), true)
  const surface = store.get('card')
  assert.equal(surface.surfaceId, 'card')
  assert.equal(surface.revision, 1)
  assert.equal(surface.components.get('root').component, 'Column')
  assert.equal(store.currentRevision(), 1)
})

test('a stale snapshot is dropped rather than rolling the surface back', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 5, { dataModel: { v: 'new' } }))
  assert.equal(store.apply(snapshot('card', 3, { dataModel: { v: 'old' } })), false)
  assert.deepEqual(store.get('card').dataModel, { v: 'new' })
})

test('an equal revision is also stale', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 4))
  assert.equal(store.apply(snapshot('card', 4)), false)
})

test('a delta patches the data model and bumps the revision', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 1))
  const applied = store.apply(
    delta('card', 2, [{ op: 'add', path: '/surfaces/card/dataModel/total', value: 42 }]),
  )
  assert.equal(applied, true)
  assert.deepEqual(store.get('card').dataModel, { total: 42 })
  assert.equal(store.get('card').revision, 2)
})

test('a snapshot keeps the call title for the tab', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 1, { title: 'System Status' }))
  assert.equal(store.get('card').title, 'System Status')
  store.apply(snapshot('other', 2))
  assert.equal(store.get('other').title, undefined)
})

test('a delta to an unknown surface is ignored', () => {
  const store = new ClientSurfaceStore()
  assert.equal(store.apply(delta('ghost', 1, [{ op: 'add', path: '/surfaces/ghost/dataModel/x', value: 1 }])), false)
  assert.equal(store.get('ghost'), undefined)
})

test('a stale delta cannot overwrite a newer snapshot', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 10, { dataModel: { v: 'fresh' } }))
  const applied = store.apply(delta('card', 4, [{ op: 'replace', path: '/surfaces/card/dataModel/v', value: 'stale' }]))
  assert.equal(applied, false)
  assert.deepEqual(store.get('card').dataModel, { v: 'fresh' })
})

test('a delta that removes the surface closes it', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 1))
  assert.equal(store.apply(delta('card', 2, [{ op: 'remove', path: '/surfaces/card' }])), true)
  assert.equal(store.get('card'), undefined)
})

test('several surfaces update independently', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('a', 1))
  store.apply(snapshot('b', 2))
  store.apply(delta('a', 3, [{ op: 'replace', path: '/surfaces/a/dataModel', value: { v: 1 } }]))
  assert.deepEqual(store.get('a').dataModel, { v: 1 })
  assert.deepEqual(store.get('b').dataModel, {})
  assert.equal(store.list().length, 2)
})

test('an unapplicable patch leaves the surface intact', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 1, { dataModel: {} }))
  const applied = store.apply(delta('card', 2, [{ op: 'replace', path: '/surfaces/card/dataModel/missing/deep', value: 1 }]))
  assert.equal(applied, false, 'the client refuses a patch it cannot apply')
  assert.deepEqual(store.get('card').dataModel, {})
})

test('subscribers are notified once per applied frame', () => {
  const store = new ClientSurfaceStore()
  let notifications = 0
  store.subscribe(() => (notifications += 1))
  store.apply(snapshot('a', 1))
  store.apply(delta('a', 2, [{ op: 'replace', path: '/surfaces/a/dataModel', value: { v: 1 } }]))
  assert.equal(notifications, 2)
  store.apply(snapshot('a', 1))
  assert.equal(notifications, 2, 'a stale frame notifies nobody')
})

test('a surfaceDeleted custom frame closes the surface', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 1))
  assert.equal(store.apply({ type: 'CUSTOM', surfaceId: 'card', name: 'surfaceDeleted', value: {} }), true)
  assert.equal(store.get('card'), undefined)
})

/* ---------------------------------------------------------------- */
/* Epoch and resync                                                  */
/* ---------------------------------------------------------------- */

test('a snapshot from a new epoch is adopted despite a lower revision', () => {
  const store = new ClientSurfaceStore()
  store.apply({ ...snapshot('card', 40, { dataModel: { v: 'old-process' } }), surfaceEpoch: 'epoch-a' })
  assert.equal(store.get('card').revision, 40)

  // The Host restarted: its counter is back at 1, but it is a different store.
  const adopted = store.apply({ ...snapshot('card', 1, { dataModel: { v: 'new-process' } }), surfaceEpoch: 'epoch-b' })
  assert.equal(adopted, true, 'a new epoch invalidates the revision comparison')
  assert.deepEqual(store.get('card').dataModel, { v: 'new-process' })
  assert.equal(store.get('card').revision, 1)
  assert.equal(store.get('card').epoch, 'epoch-b')
})

test('the same epoch keeps the normal revision guard', () => {
  const store = new ClientSurfaceStore()
  store.apply({ ...snapshot('card', 5), surfaceEpoch: 'epoch-a' })
  assert.equal(store.apply({ ...snapshot('card', 4), surfaceEpoch: 'epoch-a' }), false)
})

test('a delta from another epoch is refused and counted', () => {
  const store = new ClientSurfaceStore()
  store.apply({ ...snapshot('card', 1), surfaceEpoch: 'epoch-a' })
  const applied = store.apply({
    ...delta('card', 2, [{ op: 'replace', path: '/surfaces/card/dataModel', value: { v: 'x' } }]),
    surfaceEpoch: 'epoch-b',
  })
  assert.equal(applied, false)
  assert.equal(store.failuresOf('card'), 1, 'a foreign delta counts toward a resync')
})

test('consecutive failures are counted and cleared by a snapshot', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 1))
  const bad = delta('card', 2, [{ op: 'replace', path: '/surfaces/card/dataModel/missing/deep', value: 1 }])
  store.apply(bad)
  store.apply({ ...bad, surfaceRevision: 3 })
  assert.equal(store.failuresOf('card'), 2)

  store.apply(snapshot('card', 4))
  assert.equal(store.failuresOf('card'), 0, 'a snapshot is the repair')
})

test('adopt accepts an authoritative frame regardless of revision', () => {
  const store = new ClientSurfaceStore()
  store.apply(snapshot('card', 99, { dataModel: { v: 'local' } }))
  const changed = store.adopt(snapshot('card', 1, { dataModel: { v: 'authoritative' } }))
  assert.equal(changed, true)
  assert.deepEqual(store.get('card').dataModel, { v: 'authoritative' })
})

/* ---------------------------------------------------------------- */
/* RFC 6902 application                                              */
/* ---------------------------------------------------------------- */

test('applyOperation supports add, replace and remove', () => {
  let document = { a: { b: [1, 2] } }
  document = applyOperation(document, { op: 'add', path: '/a/c', value: 3 })
  assert.deepEqual(document, { a: { b: [1, 2], c: 3 } })

  document = applyOperation(document, { op: 'replace', path: '/a/b/0', value: 9 })
  assert.deepEqual(document.a.b, [9, 2])

  document = applyOperation(document, { op: 'add', path: '/a/b/-', value: 7 })
  assert.deepEqual(document.a.b, [9, 2, 7])

  document = applyOperation(document, { op: 'remove', path: '/a/c' })
  assert.deepEqual(Object.keys(document.a), ['b'])
})

test('the test operation is not part of the surface protocol', () => {
  // The Host emits add/replace/remove only; a patcher branch nothing can reach
  // would misrepresent what the store accepts.
  assert.throws(() => applyOperation({ a: 1 }, { op: 'test', path: '/a', value: 1 }), /unsupported/u)
})

test('applyOperation delegates the same way at the document root', () => {
  assert.deepEqual(applyOperation({ a: 1 }, { op: 'replace', path: '/', value: { b: 2 } }), { b: 2 })
  assert.throws(() => applyOperation({ a: 1 }, { op: 'remove', path: '/' }), /root/u)
})

test('applyOperation refuses a path that does not resolve', () => {
  assert.throws(() => applyOperation({ a: 1 }, { op: 'remove', path: '/b' }), /does not resolve/u)
  assert.throws(() => applyOperation({ a: 1 }, { op: 'replace', path: '/b/c', value: 1 }), /does not resolve/u)
  assert.throws(() => applyOperation({ a: [1] }, { op: 'replace', path: '/a/3', value: 1 }), /outside the array/u)
})

test('applyOperation refuses an unknown operation', () => {
  assert.throws(() => applyOperation({ a: 1 }, { op: 'move', path: '/a' }), /unsupported/u)
})

/* ---------------------------------------------------------------- */
/* Placement                                                         */
/* ---------------------------------------------------------------- */

test('the narrow breakpoint matches the Host and DSH', () => {
  assert.equal(isNarrowWidth(767), true)
  assert.equal(isNarrowWidth(768), false)
  assert.equal(effectivePlacement('sidebar', 767).placement, 'inline')
  assert.equal(effectivePlacement('sidebar', 767).downgraded, true)
  assert.equal(effectivePlacement('sidebar', 1200).placement, 'sidebar')
  assert.equal(effectivePlacement('sidebar', 1200).downgraded, false)
  assert.equal(effectivePlacement('inline', 1200).downgraded, false)
})

/* ---------------------------------------------------------------- */
/* Socket                                                            */
/* ---------------------------------------------------------------- */

/** A WebSocket stand-in the test drives by hand. */
class FakeSocket {
  constructor(url, protocols) {
    this.url = url
    this.protocols = protocols
    this.closed = false
    FakeSocket.instances.push(this)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  /** Play the server's opening frame. */
  open() {
    this.onopen?.()
  }
  /** Deliver one frame. */
  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  /** Fail the socket. */
  fail() {
    this.onerror?.()
    this.onclose?.()
  }
}
FakeSocket.instances = []

test('the socket URL carries the session and the versioned subprotocol', () => {
  const url = downlinkUrl('s1', 'http://127.0.0.1:3080/')
  assert.match(url, /^ws:\/\/127\.0\.0\.1:3080\/a2ui\/ws\?sessionId=s1$/u)

  const secure = downlinkUrl('s1', 'https://example.test/')
  assert.match(secure, /^wss:\/\//u, 'an https page uses wss')
})

test('one socket feeds frames into the store', () => {
  FakeSocket.instances = []
  const store = new ClientSurfaceStore()
  const client = new DownlinkClient('s1', store, {
    createSocket: (url, protocols) => new FakeSocket(url, protocols),
  })
  client.connect()
  const socket = FakeSocket.instances[0]
  assert.deepEqual(socket.protocols, ['a2ui-plus.v1'])
  socket.open()
  assert.equal(client.getState().status, 'open')

  socket.deliver(snapshot('card', 1))
  assert.equal(store.get('card').revision, 1)
  socket.deliver(delta('card', 2, [{ op: 'replace', path: '/surfaces/card/dataModel', value: { v: 2 } }]))
  assert.deepEqual(store.get('card').dataModel, { v: 2 })
  client.dispose()
})

test('a dropped socket reconnects and the baseline re-syncs', () => {
  FakeSocket.instances = []
  const store = new ClientSurfaceStore()
  const client = new DownlinkClient('s1', store, {
    createSocket: (url, protocols) => new FakeSocket(url, protocols),
  })
  client.connect()
  const first = FakeSocket.instances[0]
  first.open()
  first.deliver(snapshot('card', 1))

  first.fail()
  assert.equal(client.getState().status, 'closed')
  assert.equal(FakeSocket.instances.length, 1, 'the retry is scheduled, not immediate')

  // The reconnect path is exercised by advancing the timer through a fresh
  // connect(), which is what the timer calls.
  client.connect()
  const second = FakeSocket.instances[1]
  second.open()
  // The Host synthesizes its current state; a higher revision replaces the copy.
  second.deliver(snapshot('card', 9, { dataModel: { v: 'from-host' } }))
  assert.equal(store.get('card').revision, 9)
  assert.deepEqual(store.get('card').dataModel, { v: 'from-host' })
  client.dispose()
})

test('a narrow viewport records a downgrade instead of a tab', () => {
  FakeSocket.instances = []
  const store = new ClientSurfaceStore()
  const client = new DownlinkClient('s1', store, {
    createSocket: () => new FakeSocket('', []),
    width: () => 700,
  })
  const resolved = client.resolvePlacement('sidebar')
  assert.equal(resolved.placement, 'inline')
  assert.equal(client.getState().downgraded, true)
  client.dispose()
})

test('dispose stops the socket and the retry', () => {
  FakeSocket.instances = []
  const store = new ClientSurfaceStore()
  const client = new DownlinkClient('s1', store, { createSocket: () => new FakeSocket('', []) })
  client.connect()
  const socket = FakeSocket.instances[0]
  socket.open()
  client.dispose()
  assert.equal(socket.closed, true)
  assert.equal(client.getState().status, 'closed')
})

/* ---------------------------------------------------------------- */
/* Pointer helpers                                                   */
/* ---------------------------------------------------------------- */

test('client pointer helpers agree with the Host', () => {
  assert.equal(escapePointer('a/b'), 'a~1b')
  assert.deepEqual(segmentsOf('/a/b~1c'), ['a', 'b/c'])
  assert.deepEqual(segmentsOf('/'), [])
})

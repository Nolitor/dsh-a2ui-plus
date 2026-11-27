/**
 * The Host Surface Store: what each A2UI message becomes, and the revision that
 * makes a reconnect safe.
 *
 * The store is the authority the whole out-of-turn channel rests on: it decides
 * `add` versus `replace`, it owns the revision a client compares against, and it
 * synthesizes the snapshot a returning browser receives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import jsonpatch from 'fast-json-patch'

import {
  MAX_SURFACES_PER_SESSION,
  SurfaceStore,
  applyToModel,
  baselineFrames,
  escapePointer,
  normalisePointer,
  pointerPath,
  pointerSegments,
  resolvesTo,
  unescapePointer,
} from '../lib/host/store.js'

/** One minimal createSurface message. */
function create(surfaceId, extra = {}) {
  return { version: '1.0', createSurface: { surfaceId, catalogId: 'dsh-a2ui/catalog/v1', ...extra } }
}

test('a createSurface becomes a snapshot with the store revision', () => {
  const store = new SurfaceStore()
  assert.equal(store.currentRevision(), 0)

  const changes = store.apply([create('card', { dataModel: { total: 1 } })])
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'snapshot')
  assert.equal(changes[0].state.surfaceId, 'card')
  assert.equal(changes[0].state.dataModel.total, 1)
  assert.equal(store.currentRevision(), 1)
  assert.equal(changes[0].state.revision, 1)
})

test('a placement is remembered per surface', () => {
  const store = new SurfaceStore()
  store.apply([create('card')], 'sidebar')
  assert.equal(store.get('card').placement, 'sidebar')
})

test('updateDataModel to a missing path becomes add, an existing one becomes replace', () => {
  const store = new SurfaceStore()
  store.apply([create('card', { dataModel: { form: { name: 'Ada' } } })])

  const added = store.apply([{ version: '1.0', updateDataModel: { surfaceId: 'card', path: '/form/email', value: 'a@b.c' } }])
  assert.equal(added[0].kind, 'delta')
  assert.deepEqual(added[0].delta, [
    { op: 'add', path: '/surfaces/card/dataModel/form/email', value: 'a@b.c' },
  ])

  const replaced = store.apply([{ version: '1.0', updateDataModel: { surfaceId: 'card', path: '/form/name', value: 'Grace' } }])
  assert.deepEqual(replaced[0].delta, [
    { op: 'replace', path: '/surfaces/card/dataModel/form/name', value: 'Grace' },
  ])
  assert.equal(store.get('card').dataModel.form.name, 'Grace')
})

test('a write applied through the store matches a patch applied to the model', () => {
  // The delta and the store's own mutation must describe the same change, or a
  // renderer and the Host would drift.
  const store = new SurfaceStore()
  store.apply([create('card', { dataModel: { list: [10, 20] } })])
  const change = store.apply([
    { version: '1.0', updateDataModel: { surfaceId: 'card', path: '/list/2', value: 30 } },
  ])[0]

  const before = { list: [10, 20] }
  const document = { surfaces: { card: { dataModel: structuredClone(before) } } }
  const patched = jsonpatch.applyPatch(structuredClone(document), change.delta, true, false).newDocument
  assert.deepEqual(patched.surfaces.card.dataModel, store.get('card').dataModel)
})

test('a root write replaces the whole data model', () => {
  const store = new SurfaceStore()
  store.apply([create('card', { dataModel: { a: 1 } })])
  const change = store.apply([
    { version: '1.0', updateDataModel: { surfaceId: 'card', path: '/', value: { b: 2 } } },
  ])[0]
  assert.deepEqual(change.delta, [{ op: 'replace', path: '/surfaces/card/dataModel', value: { b: 2 } }])
  assert.deepEqual(store.get('card').dataModel, { b: 2 })
})

test('updateComponents becomes one delta per component, add then replace', () => {
  const store = new SurfaceStore()
  store.apply([create('card')])

  const first = store.apply([
    {
      version: '1.0',
      updateComponents: {
        surfaceId: 'card',
        components: [
          { id: 'root', component: 'Column', children: [] },
          { id: 'title', component: 'Text', text: 'hi' },
        ],
      },
    },
  ])[0]
  assert.equal(first.kind, 'delta')
  assert.equal(first.delta.length, 2)
  assert.equal(first.delta[0].op, 'add')
  assert.equal(first.delta[0].path, '/surfaces/card/components/root')
  assert.equal(store.get('card').components.size, 2)

  const second = store.apply([
    { version: '1.0', updateComponents: { surfaceId: 'card', components: [{ id: 'title', component: 'Text', text: 'bye' }] } },
  ])[0]
  assert.equal(second.delta[0].op, 'replace')
  assert.equal(store.get('card').components.get('title').text, 'bye')
})

test('deleteSurface removes the surface and emits a remove operation', () => {
  const store = new SurfaceStore()
  store.apply([create('card')])
  const change = store.apply([{ version: '1.0', deleteSurface: { surfaceId: 'card' } }])[0]
  assert.deepEqual(change.delta, [{ op: 'remove', path: '/surfaces/card' }])
  assert.equal(store.has('card'), false)
})

test('every change bumps the revision monotonically', () => {
  const store = new SurfaceStore()
  store.apply([create('a'), create('b')])
  store.apply([{ version: '1.0', updateDataModel: { surfaceId: 'a', path: '/x', value: 1 } }])
  store.apply([{ version: '1.0', updateDataModel: { surfaceId: 'b', path: '/y', value: 2 } }])
  assert.equal(store.currentRevision(), 4)
  const revisions = store.list().map((surface) => surface.revision)
  assert.deepEqual([...revisions].sort((l, r) => l - r), revisions, 'older surfaces first')
})

test('a message for an unknown surface is ignored rather than created', () => {
  const store = new SurfaceStore()
  const changes = store.apply([
    { version: '1.0', updateDataModel: { surfaceId: 'ghost', path: '/x', value: 1 } },
    { version: '1.0', updateComponents: { surfaceId: 'ghost', components: [{ id: 'root', component: 'Text' }] } },
  ])
  assert.deepEqual(changes, [])
  assert.equal(store.has('ghost'), false)
  assert.equal(store.currentRevision(), 0, 'a refusal must not advance the revision')
})

test('several surfaces stay independent in one batch', () => {
  const store = new SurfaceStore()
  const changes = store.apply([
    create('left', { dataModel: { v: 1 } }),
    create('right', { dataModel: { v: 2 } }),
  ])
  assert.equal(changes.length, 2)
  store.apply([{ version: '1.0', updateDataModel: { surfaceId: 'left', path: '/v', value: 9 } }])
  assert.equal(store.get('left').dataModel.v, 9)
  assert.equal(store.get('right').dataModel.v, 2, 'the other surface is untouched')
})

test('each store instance owns a distinct epoch', () => {
  const first = new SurfaceStore()
  const second = new SurfaceStore()
  assert.equal(typeof first.currentEpoch(), 'string')
  assert.ok(first.currentEpoch().length > 0)
  assert.notEqual(first.currentEpoch(), second.currentEpoch(), 'a restart must be visible')
})

test('every baseline frame carries the epoch', () => {
  const store = new SurfaceStore()
  store.apply([create('card')])
  const frames = baselineFrames(store, () => [])
  assert.equal(frames[0].surfaceEpoch, store.currentEpoch())
})

test('a sidebar placement and the call title are recorded together', () => {
  const store = new SurfaceStore()
  const changes = store.apply([create('card')], { placement: 'sidebar', title: 'System Status' })
  assert.equal(changes[0].state.placement, 'sidebar')
  assert.equal(changes[0].state.title, 'System Status')
  const frames = baselineFrames(store, () => [])
  assert.equal(frames[0].content.placement, 'sidebar')
  assert.equal(frames[0].content.title, 'System Status', 'a restored tab keeps its name')
})

test('a call without a title records none', () => {
  const store = new SurfaceStore()
  store.apply([create('card')], 'inline')
  assert.equal(store.get('card').title, undefined)
  assert.equal(baselineFrames(store, () => [])[0].content.title, undefined)
})

test('the surface cap evicts the least recently changed', () => {
  const store = new SurfaceStore(3)
  for (const id of ['a', 'b', 'c', 'd']) store.apply([create(id)])
  assert.equal(store.list().length, 3)
  assert.equal(store.has('a'), false, 'the oldest went first')
  assert.ok(MAX_SURFACES_PER_SESSION >= 3)
})

/* ---------------------------------------------------------------- */
/* Baseline synthesis (D2)                                           */
/* ---------------------------------------------------------------- */

test('the baseline carries the store present, not a transport counter', () => {
  const store = new SurfaceStore()
  store.apply([create('card', { dataModel: { v: 1 } })])
  store.apply([{ version: '1.0', updateDataModel: { surfaceId: 'card', path: '/v', value: 2 } }])

  const frames = baselineFrames(store, () => [{ version: '1.0' }])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'ACTIVITY_SNAPSHOT')
  assert.equal(frames[0].surfaceRevision, store.get('card').revision)
  assert.deepEqual(frames[0].content.dataModel, { v: 2 }, 'the current model, not the first one')
  assert.equal(frames[0].replace, true)
})

test('the baseline covers every surface of the session', () => {
  const store = new SurfaceStore()
  store.apply([create('a'), create('b')])
  store.apply([{ version: '1.0', deleteSurface: { surfaceId: 'a' } }])
  const frames = baselineFrames(store, () => [])
  assert.equal(frames.length, 1)
  assert.equal(frames[0].surfaceId, 'b')
})

test('an empty store yields no baseline frame', () => {
  assert.deepEqual(baselineFrames(new SurfaceStore(), () => undefined), [])
})

/* ---------------------------------------------------------------- */
/* Pointer helpers                                                   */
/* ---------------------------------------------------------------- */

test('pointer segments escape and unescape RFC 6901 tokens', () => {
  assert.equal(escapePointer('a/b'), 'a~1b')
  assert.equal(escapePointer('a~b'), 'a~0b')
  assert.equal(unescapePointer('a~1b'), 'a/b')
  assert.deepEqual(pointerSegments('/a/b~1c'), ['a', 'b/c'])
  assert.deepEqual(pointerSegments('/'), [])
  assert.equal(normalisePointer(undefined), '/')
  assert.equal(normalisePointer('x/y'), '/x/y')
  assert.equal(pointerPath('card', '/form/name'), '/surfaces/card/dataModel/form/name')
  assert.equal(pointerPath('card', '/'), '/surfaces/card/dataModel')
})

test('resolvesTo distinguishes a present key from a missing one', () => {
  const document = { form: { name: null }, list: [1] }
  assert.equal(resolvesTo(document, '/form/name'), true, 'a null value still resolves')
  assert.equal(resolvesTo(document, '/form/email'), false)
  assert.equal(resolvesTo(document, '/form/name/deep'), false, 'walking through a scalar fails')
  assert.equal(resolvesTo(document, '/list/0'), true)
  assert.equal(resolvesTo(document, '/list/5'), false)
  assert.equal(resolvesTo(document, '/list/x'), false)
  assert.equal(resolvesTo(document, '/'), false)
})

test('applyToModel creates intermediate containers of the right kind', () => {
  const state = { dataModel: {} }
  applyToModel(state, '/a/b/0', 'x')
  assert.deepEqual(state.dataModel, { a: { b: ['x'] } })
  applyToModel(state, '/a/b', [1, 2])
  assert.deepEqual(state.dataModel, { a: { b: [1, 2] } })
  applyToModel(state, '/', 'scalar')
  assert.equal(state.dataModel, 'scalar')
})

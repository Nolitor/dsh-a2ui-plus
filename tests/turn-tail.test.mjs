/**
 * Tests for the turn-tail transcript lookup.
 *
 * The lookup reads DSH's Chat store (`order` + `nodes`) to find the `a2ui`
 * calls of one turn. A wrong assumption about that shape must fail here rather
 * than leave the user with an empty card, so every branch is pinned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { client } = await import('../build/shared.mjs')
const { collectA2uiRoots, toolPhaseOf, blockToolName, nodeTurn, rootsFromToolData } = client.surfaces

function node(kind, turn, root, extra = {}) {
  return { kind, anchorSeq: extra.anchorSeq ?? 1, visibility: extra.visibility ?? 'visible', location: { kind: 'step', turn: { turn } }, data: { root } }
}

const started = (name) => ({ phase: 'start', callId: 'c', name, argsRaw: '{}', subCalls: [] })
const result = (name, meta) => ({ kind: 'tool-result', callId: 'c', name, argsRaw: '{}', call: { name, argsRaw: '{}' }, content: [], isError: false, meta })

test('collects a2ui calls of exactly the requested turn, in order', () => {
  const nodes = new Map([
    ['k1', node('tool-call', 1, result('a2ui', { kind: 'a2ui' }))],
    ['k2', node('tool-call', 2, started('a2ui'))],
    ['k3', node('assistant-step', 2, undefined)],
    ['k4', node('tool-call', 2, result('bash'))],
    ['k5', node('tool-call', 2, result('a2ui', { kind: 'a2ui' }))],
  ])
  const found = collectA2uiRoots(['k1', 'k2', 'k3', 'k4', 'k5'], nodes, 2)
  assert.deepEqual(found.map((entry) => entry.key), ['k2', 'k5'])
  assert.deepEqual(found.map((entry) => entry.phase), ['start', 'result'])
})

test('resolves the tool name from the call field after settlement', () => {
  const nodes = new Map([['k', node('tool-call', 1, result('a2ui'))]])
  assert.equal(collectA2uiRoots(['k'], nodes, 1).length, 1)
  // A result block whose name only exists on `call` still matches.
  const silent = new Map([['k', node('tool-call', 1, { kind: 'tool-result', call: { name: 'a2ui' } })]])
  assert.equal(collectA2uiRoots(['k'], silent, 1).length, 1)
})

test('skips hidden nodes, other turns, and non-a2ui tools', () => {
  const nodes = new Map([
    ['hidden', node('tool-call', 1, started('a2ui'), { visibility: 'hidden' })],
    ['otherTurn', node('tool-call', 9, started('a2ui'))],
    ['otherTool', node('tool-call', 1, started('write'))],
    ['notToolCall', node('assistant-step', 1, started('a2ui'))],
  ])
  assert.deepEqual(collectA2uiRoots(['hidden', 'otherTurn', 'otherTool', 'notToolCall'], nodes, 1), [])
})

test('returns nothing for an unknown turn, missing order, or missing store', () => {
  const nodes = new Map([['k', node('tool-call', 3, started('a2ui'))]])
  assert.deepEqual(collectA2uiRoots(['k'], nodes, undefined), [])
  assert.deepEqual(collectA2uiRoots(undefined, nodes, 3), [])
  assert.deepEqual(collectA2uiRoots(['k'], undefined, 3), [])
  assert.deepEqual(collectA2uiRoots(['missing'], nodes, 3), [])
})

test('tolerates a plain object store as well as a Map', () => {
  const store = { k: node('tool-call', 4, started('a2ui')) }
  assert.equal(collectA2uiRoots(['k'], store, 4).length, 1)
})

test('phase and turn helpers match the Chat tool node contract', () => {
  assert.equal(toolPhaseOf(undefined), 'preparing')
  assert.equal(toolPhaseOf({ phase: 'preparing' }), 'preparing')
  assert.equal(toolPhaseOf({ phase: 'start' }), 'start')
  assert.equal(toolPhaseOf({ kind: 'tool-result' }), 'result')
  assert.equal(blockToolName(started('a2ui')), 'a2ui')
  assert.equal(blockToolName(result('a2ui')), 'a2ui')
  assert.equal(blockToolName(undefined), undefined)
  assert.equal(nodeTurn({ location: { kind: 'step', turn: { turn: 7 } } }), 7)
  assert.equal(nodeTurn({ location: { kind: 'turn', turn: { turn: 8 } } }), 8)
  assert.equal(nodeTurn({ location: { kind: 'other' } }), undefined)
  assert.equal(nodeTurn(undefined), undefined)
})

/* ------------------------------------------------------------------ */
/* Preferred turn-tail source: nodes.turnDataSource(turn, 'tool-call')  */
/* ------------------------------------------------------------------ */


test('turnDataSource payloads map to a2ui roots in anchor order', () => {
  const entries = rootsFromToolData([
    { root: { phase: 'start', callId: 'c1', name: 'a2ui' } },
    { root: { kind: 'tool-result', callId: 'c2', name: 'a2ui', call: { name: 'a2ui' } } },
    { root: { kind: 'tool-result', callId: 'c3', name: 'bash', call: { name: 'bash' } } },
  ])
  assert.deepEqual(entries.map((entry) => entry.key), ['c1', 'c2'])
  assert.deepEqual(entries.map((entry) => entry.phase), ['start', 'result'])
})

test('a settled result updates the phase without a new turn entry', () => {
  const running = rootsFromToolData([{ root: { phase: 'start', callId: 'c1', name: 'a2ui' } }])
  const settled = rootsFromToolData([{ root: { kind: 'tool-result', callId: 'c1', name: 'a2ui', call: { name: 'a2ui' }, meta: { kind: 'a2ui' } } }])
  assert.equal(running[0].phase, 'start')
  assert.equal(settled[0].phase, 'result')
  assert.equal(settled[0].root.meta.kind, 'a2ui')
})

test('missing or malformed turn data yields no roots', () => {
  assert.deepEqual(rootsFromToolData(undefined), [])
  assert.deepEqual(rootsFromToolData([]), [])
  assert.deepEqual(rootsFromToolData([null, 5, {}, { root: {} }]), [{ key: 'tool-3', root: {}, phase: 'start' }].slice(0, 0))
})

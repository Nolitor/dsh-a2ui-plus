/** Progressive argument recovery, folding, and live Session window handling. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sessionEvents, toolDelta } from '../tools/lib/render-view.mjs'

const { shared, client } = await import('../build/shared.mjs')
const { recoverArguments, foldStreaming, validateToolArguments, MAX_RECOVERY_DEPTH, LIMITS } = shared
const { watchStream, MAX_STREAM_CHARS, MAX_STREAM_ENTRIES, MAX_STREAM_TOTAL_CHARS } = client['stream-store']

/** A complete, valid single-surface call, as the model would write it. */
const SURFACE = {
  version: '1.0',
  createSurface: {
    surfaceId: 'sales',
    catalogId: 'dsh-a2ui/catalog/v1',
    dataModel: { rows: [{ label: 'Q1', value: 3 }] },
    components: [
      { id: 'root', component: 'Column', children: ['title', 'chart'] },
      { id: 'title', component: 'Text', text: 'Revenue' },
      { id: 'chart', component: 'BarChart', categories: ['Q1'], series: [{ label: 'Revenue', values: [3] }] },
    ],
  },
}

const ARGUMENTS = JSON.stringify({ title: 'Quarterly revenue', messages: [SURFACE] })

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

test('recovery keeps only values that closed', () => {
  // Cut inside the third component: the first two are real, the third is not.
  const cut = ARGUMENTS.indexOf('"BarChart"')
  const recovered = recoverArguments(ARGUMENTS.slice(0, cut))
  assert.equal(recovered.invalid, false)
  assert.equal(recovered.open, true)
  assert.equal(recovered.messages.length, 1)
  const surface = recovered.messages[0].createSurface
  assert.equal(surface.surfaceId, 'sales')
  assert.deepEqual(surface.components.map((component) => component.id), ['root', 'title'])
  assert.deepEqual(surface.dataModel, { rows: [{ label: 'Q1', value: 3 }] })
})

test('recovery reports the closed document and the finished title', () => {
  const recovered = recoverArguments(ARGUMENTS)
  assert.deepEqual([recovered.closed, recovered.open, recovered.invalid], [true, false, false])
  assert.equal(recovered.title, 'Quarterly revenue')
  assert.equal(recovered.messages.length, 1)
  assert.equal(recovered.messages[0].createSurface.components.length, 3)
})

test('a title is not read until its string closes', () => {
  const text = '{"title":"Revenue by region'
  const recovered = recoverArguments(text)
  assert.equal(recovered.title, undefined)
  assert.deepEqual([recovered.open, recovered.invalid], [true, false])
  assert.equal(recoverArguments(`${text}"}`).title, 'Revenue by region')
})

test('a complete compact flag is available before the first streaming surface', () => {
  assert.equal(foldStreaming('{"presentation":"comp').presentation, undefined)
  assert.equal(foldStreaming('{"presentation":"compact",').presentation, 'compact')
  const text = JSON.stringify({ presentation: 'compact', messages: [SURFACE] }).slice(0, -1)
  assert.equal(foldStreaming(text).presentation, 'compact')
  assert.equal(foldStreaming(text).surfaces.length, 1)
  assert.equal(foldStreaming(text.replace('compact', 'wide')).presentation, undefined)
})

test('streaming displays can wait for bindings which must be present at settlement', () => {
  const create = { version: '1.0', createSurface: { surfaceId: 'report',
    components: [
      { id: 'root', component: 'Column', children: ['matrix', 'events', 'radar'] },
      { id: 'matrix', component: 'Heatmap', rowLabels: ['Row'], columnLabels: ['Column'], values: { '@path': '/matrix' } },
      { id: 'events', component: 'Timeline', events: { '@path': '/events' } },
      { id: 'radar', component: 'RadarChart', axes: { '@path': '/axes' }, series: [{ values: { '@path': '/scores' } }] },
    ] } }
  const pending = { presentation: 'compact', messages: [create] }
  assert.equal(foldStreaming(JSON.stringify(pending).slice(0, -1)).surfaces.length, 1)
  assert.equal(validateToolArguments(pending).ok, false)
  const update = { version: '1.0', updateDataModel: {
    surfaceId: 'report', value: { matrix: [[0]], events: [{ when: 'Today', title: 'Ready' }],
      axes: ['Cost', 'Speed', 'Accuracy'], scores: [0, null, 90] },
  } }
  const complete = { ...pending, messages: [create, update] }
  assert.equal(foldStreaming(JSON.stringify(complete).slice(0, -1)).surfaces.length, 1)
  assert.equal(validateToolArguments(complete).ok, true)
})

test('escapes are decoded exactly once, by JSON.parse', () => {
  const text = '{"messages":[{"version":"1.0","createSurface":{"surfaceId":"s","components":[{"id":"root","component":"Text","text":"a\\"b\\u00e9\\\\c"}]}}]}'
  const recovered = recoverArguments(text)
  assert.equal(recovered.messages[0].createSurface.components[0].text, 'a"bé\\c')
})

test('malformed syntax stops the stream instead of guessing', () => {
  for (const broken of ['{"messages":[}]}', '{"messages":[{}],}', 'not json']) {
    const recovered = recoverArguments(broken)
    assert.equal(recovered.invalid, true, `expected ${broken} to be rejected`)
    const folded = foldStreaming(broken)
    assert.deepEqual([folded.surfaces.length, folded.stopped], [0, true])
  }
  // A missing final brace is not an error: more text can still arrive.
  assert.deepEqual([recoverArguments('{"messages":[{}]').invalid, recoverArguments('{"messages":[{}]').open], [false, true])
})

test('a payload deeper than the recovery bound is refused', () => {
  const deep = `${'['.repeat(MAX_RECOVERY_DEPTH + 2)}x${']'.repeat(MAX_RECOVERY_DEPTH + 2)}`
  assert.equal(recoverArguments(`{"messages":${deep}}`).invalid, true)
})

/* ------------------------------------------------------------------ */
/* Fold                                                                */
/* ------------------------------------------------------------------ */

test('the fold grows monotonically while the payload streams in', () => {
  let previous = 0
  let everStopped = false
  for (let length = 1; length <= ARGUMENTS.length; length += 1) {
    const folded = foldStreaming(ARGUMENTS.slice(0, length))
    everStopped = everStopped || folded.stopped
    assert.ok(folded.components >= previous, `component count regressed at ${length}`)
    previous = folded.components
    // A root is required before anything is drawn: no empty cards.
    for (const surface of folded.surfaces) assert.ok(surface.components.has('root'))
  }
  assert.equal(everStopped, false)
  assert.equal(previous, 3)
})

test('a surface without its root is not drawn yet', () => {
  const folded = foldStreaming('{"messages":[{"version":"1.0","createSurface":{"surfaceId":"s","components":[{"id":"a","component":"Text","text":"hi"}]}}]}')
  assert.deepEqual([folded.surfaces.length, folded.streaming, folded.stopped], [0, false, false])
})

test('one fold merges create and update messages like the settled path', () => {
  const create = { version: '1.0', createSurface: { surfaceId: 's', components: [{ id: 'root', component: 'Column', children: ['t'] }, { id: 't', component: 'Text', text: 'one' }] } }
  const update = { version: '1.0', updateComponents: { surfaceId: 's', components: [{ id: 't', component: 'Text', text: 'two' }] } }
  const folded = foldStreaming(JSON.stringify({ messages: [create, update] }))
  assert.equal(folded.surfaces.length, 1)
  const state = folded.surfaces[0]
  assert.equal(state.components.size, 2)
  assert.equal(state.components.get('t').text, 'two')
})

test('components that are structurally impossible are skipped, not drawn', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 's',
        components: [
          { id: 'root', component: 'Column', children: ['ok'] },
          { id: 'ok', component: 'Text', text: 'kept' },
          { id: 'bad id', component: 'Text', text: 'space in id' },
          { id: 'root', component: 'Text', text: 'duplicate' },
          { id: 'surfaceish', component: 'Surface' },
          { id: 'numeric', component: 7 },
          'not an object',
          { id: 'x'.repeat(200), component: 'Text' },
        ],
      },
    },
  ]
  const folded = foldStreaming(JSON.stringify({ messages }))
  assert.deepEqual([...folded.surfaces[0].components.keys()].sort(), ['ok', 'root'])
  // The duplicate did not replace the real root.
  assert.equal(folded.surfaces[0].components.get('root').component, 'Column')
  assert.equal(folded.truncated, true)
})

/* --- the reviewer's preview-validation bypass ---------------------- */

/** Cut a payload right after `needle`, so the component closed but the JSON did not. */
function cutAfter(payload, needle) {
  const at = payload.indexOf(needle)
  assert.ok(at > 0, `payload does not contain ${needle}`)
  return payload.slice(0, at + needle.length)
}

test('a closed component is validated exactly like the settled path validates it', () => {
  // `tabs: [null]` crashes a renderer that trusts the property; the settled path
  // rejects it, so the preview must not draw it either.
  const bad = JSON.stringify({
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'tabs',
          catalogId: 'dsh-a2ui/catalog/v1',
          components: [{ id: 'root', component: 'Tabs', tabs: [null] }],
        },
      },
    ],
  })
  const settled = validateToolArguments(JSON.parse(bad))
  assert.equal(settled.ok, false, 'the settled path must reject this payload')

  const folded = foldStreaming(cutAfter(bad, '"tabs":[null]}]'))
  assert.deepEqual([folded.surfaces.length, folded.stopped, folded.truncated], [0, false, true])

  // Another renderer, another malformed nested property.
  const badTable = JSON.stringify({
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'table',
          catalogId: 'dsh-a2ui/catalog/v1',
          components: [{ id: 'root', component: 'Table', columns: [null], rows: [] }],
        },
      },
    ],
  })
  assert.equal(validateToolArguments(JSON.parse(badTable)).ok, false)
  assert.deepEqual(foldStreaming(cutAfter(badTable, '"rows":[]}')).surfaces.length, 0)

  // The same shape with a legal property previews fine, and recovers as soon as
  // the payload becomes drawable again.
  const good = JSON.stringify({
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'tabs',
          catalogId: 'dsh-a2ui/catalog/v1',
          components: [{ id: 'root', component: 'Tabs', tabs: [{ title: 'One', child: 'later' }] }],
        },
      },
    ],
  })
  const recovered = foldStreaming(cutAfter(good, '"tabs":[{"title":"One","child":"later"}]}]'))
  assert.equal(recovered.surfaces.length, 1)
  assert.equal(recovered.surfaces[0].components.size, 1)
})

test('an illegal component is skipped while its legal siblings still draw', () => {
  const payload = JSON.stringify({
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 's',
          catalogId: 'dsh-a2ui/catalog/v1',
          components: [
            { id: 'root', component: 'Column', children: ['good', 'bad'] },
            { id: 'good', component: 'Text', text: 'kept' },
            { id: 'bad', component: 'Progress', caption: 'not a property of Progress' },
          ],
        },
      },
    ],
  })
  const folded = foldStreaming(payload)
  assert.deepEqual([...folded.surfaces[0].components.keys()].sort(), ['good', 'root'])
  assert.equal(folded.truncated, true)
})

/* --- budgets ------------------------------------------------------- */

/** One surface whose root expands a template over `items`. */
function templatedSurface(surfaceId, items) {
  return {
    version: '1.0',
    createSurface: {
      surfaceId,
      catalogId: 'dsh-a2ui/catalog/v1',
      dataModel: { items },
      components: [
        { id: 'root', component: 'Column', children: { componentId: 'row', path: '/items' } },
        { id: 'row', component: 'Text', text: 'x' },
      ],
    },
  }
}

test('a single surface over its own budget is skipped, the rest still draws', () => {
  const huge = templatedSurface('huge', Array.from({ length: LIMITS.maxExpandedNodes + 10 }, (_, index) => index))
  const small = templatedSurface('small', [1, 2, 3])
  const folded = foldStreaming(JSON.stringify({ messages: [small, huge] }))
  assert.deepEqual(folded.surfaces.map((surface) => surface.surfaceId), ['small'])
  assert.deepEqual([folded.stopped, folded.truncated], [false, true])
})

test('the per-call expansion budget is enforced across surfaces', () => {
  const each = Math.floor(LIMITS.maxTotalExpandedNodes / 2) + 500
  const first = templatedSurface('one', Array.from({ length: each }, (_, index) => index))
  const second = templatedSurface('two', Array.from({ length: each }, (_, index) => index))
  const folded = foldStreaming(JSON.stringify({ messages: [first, second] }))
  // The first fits on its own; adding the second would exceed the call budget,
  // so the preview keeps the last safe snapshot instead of drawing both.
  assert.deepEqual(folded.surfaces.map((surface) => surface.surfaceId), ['one'])
  assert.equal(folded.truncated, true)
  // And the settled path rejects the whole call, which is what makes the preview
  // a preview.
  assert.equal(validateToolArguments(JSON.parse(JSON.stringify({ messages: [first, second] }))).ok, false)
})

test('the per-call data-unit budget is enforced across surfaces', () => {
  const rows = Array.from({ length: LIMITS.maxTableRows }, (_, index) => ({ a: index }))
  const tables = (surfaceId, count) => ({
    version: '1.0',
    createSurface: {
      surfaceId,
      catalogId: 'dsh-a2ui/catalog/v1',
      components: [
        { id: 'root', component: 'Column', children: Array.from({ length: count }, (_, index) => `t${index}`) },
        ...Array.from({ length: count }, (_, index) => ({ id: `t${index}`, component: 'Table', columns: [{ key: 'a', label: 'A' }], rows })),
      ],
    },
  })
  // Exactly at the per-surface allowance: legal, and still previewed.
  const perSurface = Math.floor(LIMITS.maxExpandedDataUnits / LIMITS.maxTableRows)
  const first = tables('one', perSurface)
  const single = foldStreaming(JSON.stringify({ messages: [first] }))
  assert.equal(single.surfaces.length, 1, 'one legal surface still previews')
  const second = tables('two', perSurface)
  const both = foldStreaming(JSON.stringify({ messages: [first, second] }))
  assert.deepEqual(both.surfaces.map((surface) => surface.surfaceId), ['one'])
  assert.equal(both.truncated, true)
})

test('more surfaces than one call may create are left out', () => {
  const messages = Array.from({ length: LIMITS.maxSurfacesPerCall + 2 }, (_, index) => templatedSurface(`s${index}`, [index]))
  const folded = foldStreaming(JSON.stringify({ messages }))
  assert.equal(folded.surfaces.length, LIMITS.maxSurfacesPerCall)
  assert.equal(folded.truncated, true)
})

test('a surface with more components than the settled path allows is left out', () => {
  const over = (surfaceId) => ({
    version: '1.0',
    createSurface: {
      surfaceId,
      catalogId: 'dsh-a2ui/catalog/v1',
      components: [
        { id: 'root', component: 'Column', children: [] },
        ...Array.from({ length: LIMITS.maxComponentsPerSurface }, (_, index) => ({ id: `c${index}`, component: 'Text', text: 'x' })),
      ],
    },
  })
  const folded = foldStreaming(JSON.stringify({ messages: [over('big')] }))
  assert.deepEqual([folded.surfaces.length, folded.truncated], [0, true])
  assert.equal(validateToolArguments(JSON.parse(JSON.stringify({ messages: [over('big')] }))).ok, false)
})

test('official incremental messages prepare and update the model before the root arrives', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/examples/00_incremental.json', import.meta.url), 'utf8'))
  const beforeRoot = foldStreaming(JSON.stringify({ messages: fixture.messages.slice(0, 2) }))
  assert.deepEqual(beforeRoot.surfaces, [])
  const args = JSON.stringify({ messages: fixture.messages })
  const preview = foldStreaming(args.slice(0, -1))
  const settled = validateToolArguments({ messages: fixture.messages })
  assert.equal(settled.ok, true)
  assert.equal(preview.surfaces.length, 1)
  assert.deepEqual(preview.surfaces[0].dataModel, settled.states.get(preview.surfaces[0].surfaceId).dataModel)
})

test('a data model update waits for the complete message before replacing any data', () => {
  const initial = { name: 'Ada', details: { city: 'London', country: 'UK' } }
  const create = {
    version: '1.0',
    createSurface: {
      surfaceId: 'model',
      dataModel: initial,
      components: [{ id: 'root', component: 'Text', text: { '@path': '/name' } }],
    },
  }
  for (const [updateDataModel, pendingField, expected] of [
    [{ surfaceId: 'model', value: 'Bob', path: '/name' }, ',"path":', { ...initial, name: 'Bob' }],
    [
      { surfaceId: 'model', path: '/details', value: { city: 'Paris', country: 'France' } },
      ',"country":"France"',
      { ...initial, details: { city: 'Paris', country: 'France' } },
    ],
    [{ surfaceId: 'model', value: { name: 'Bob' } }, undefined, { name: 'Bob' }],
  ]) {
    const args = JSON.stringify({ messages: [create, { version: '1.0', updateDataModel }] })
    const cut = pendingField === undefined ? args.length - 3 : args.indexOf(pendingField)
    const pending = foldStreaming(args.slice(0, cut))
    assert.equal(pending.streaming, true)
    assert.equal(pending.truncated, false)
    assert.deepEqual(pending.surfaces[0].dataModel, initial)

    const closedMessage = foldStreaming(args.slice(0, -2))
    assert.equal(closedMessage.streaming, true, 'a closed message takes effect before the call closes')
    assert.deepEqual(closedMessage.surfaces[0].dataModel, expected)
  }
})

test('explicitly unsupported versions and closed messages without a version do not render', () => {
  const { version, ...rest } = SURFACE
  const backwards = { ...rest, version }
  const valid = JSON.stringify({ messages: [backwards] })
  const beforeVersion = valid.slice(0, valid.indexOf(',"version"'))
  assert.equal(foldStreaming(beforeVersion).surfaces.length, 1, 'a version written last can still arrive')
  const unsupported = valid.replace('"version":"1.0"', '"version":"0.8"')
  for (const text of [unsupported, unsupported.slice(0, -3), JSON.stringify({ messages: [rest] })]) {
    assert.equal(foldStreaming(text).surfaces.length, 0)
  }
})

test('updates draw only Surfaces created in the current call and respect deletion', () => {
  const { surfaceId, components } = SURFACE.createSurface
  const update = { version: '1.0', updateComponents: { surfaceId, components } }
  const drop = { version: '1.0', deleteSurface: { surfaceId } }
  assert.equal(foldStreaming(JSON.stringify({ messages: [update] })).surfaces.length, 0)
  assert.equal(foldStreaming(JSON.stringify({ messages: [SURFACE, drop, update] })).surfaces.length, 0)
  assert.equal(foldStreaming(JSON.stringify({ messages: [SURFACE, drop, SURFACE] })).surfaces.length, 1)
})

test('the Session window replaces prefixes, ignores repeated sequence numbers and recovers across revisions', () => {
  const feed = sessionEvents()
  const stream = watchStream(feed, 'call')
  const off = stream.subscribe(() => {})
  try {
    const first = toolDelta(1, 'call', '{"mes', { name: 'a2ui' })
    const second = toolDelta(2, 'call', 'sages":[{')
    feed.append(first, second)
    assert.equal(stream.getSnapshot(), '{"messages":[{')
    feed.append(second)
    assert.equal(stream.getSnapshot(), '{"messages":[{')
    feed.replace([first, second])
    assert.equal(stream.getSnapshot(), '{"messages":[{')
    feed.prepend({ type: 'event', event: { type: 'tool/call', seq: 0, data: { callId: 'older' } } })
    assert.equal(stream.getSnapshot(), '{"messages":[{')

    const missed = toolDelta(3, 'call', 'x')
    const latest = toolDelta(4, 'call', 'y')
    feed.skipRevision([first, second, missed, latest], [latest])
    assert.equal(stream.getSnapshot(), '{"messages":[{xy')
    feed.replace([])
    assert.equal(stream.getSnapshot(), undefined)
  } finally {
    off()
  }
  assert.equal(feed.subscriberCount(), 0)
})

test('settling one attempt or call never clears another and never revives withdrawn arguments', () => {
  const feed = sessionEvents()
  const first = watchStream(feed, 'first')
  const second = watchStream(feed, 'second')
  const off = [first.subscribe(() => {}), second.subscribe(() => {})]
  try {
    feed.append(
      toolDelta(1, 'first', 'one', { name: 'a2ui', attemptId: 'a' }),
      toolDelta(2, 'second', 'two', { name: 'a2ui', attemptId: 'b' }),
    )
    feed.settle('a')
    assert.equal(first.getSnapshot(), undefined)
    assert.equal(second.getSnapshot(), 'two')
    feed.append(toolDelta(3, 'first', 'anonymous', { attemptId: 'a' }))
    assert.equal(first.getSnapshot(), undefined)
    feed.append({ type: 'event', event: { type: 'tool/call', seq: 4, data: { callId: 'second' } } })
    assert.equal(second.getSnapshot(), undefined)
    feed.append(toolDelta(5, 'first', 'retry', { name: 'a2ui', attemptId: 'retry' }))
    feed.settle('a')
    assert.equal(first.getSnapshot(), 'retry')
    feed.append({ type: 'event', event: { type: 'tool/result', seq: 6, data: { message: { source: { callId: 'first' } } } } })
    assert.equal(first.getSnapshot(), undefined)
  } finally {
    off.forEach((dispose) => dispose())
  }
})

test('only named A2UI calls are picked up and the same call id is isolated across Sessions', () => {
  const a = sessionEvents()
  const b = sessionEvents()
  const first = watchStream(a, 'shared-call-id')
  const second = watchStream(b, 'shared-call-id')
  const off = [first.subscribe(() => {}), second.subscribe(() => {})]
  try {
    a.append(toolDelta(1, 'shared-call-id', 'foreign tool text', { name: 'shell' }), toolDelta(2, 'shared-call-id', 'unnamed'))
    assert.equal(first.getSnapshot(), undefined)
    b.append(toolDelta(1, 'shared-call-id', 'B', { name: 'a2ui' }))
    a.append(toolDelta(3, 'shared-call-id', 'A', { name: 'a2ui' }), toolDelta(4, 'shared-call-id', '1'))
    assert.equal(first.getSnapshot(), 'A1')
    assert.equal(second.getSnapshot(), 'B')
    b.settle('attempt')
    assert.equal(second.getSnapshot(), undefined)
    assert.equal(first.getSnapshot(), 'A1')
  } finally {
    off.forEach((dispose) => dispose())
  }
})

test('a late-mounted card rebuilds from the current window and releases its subscription on unmount', () => {
  const feed = sessionEvents()
  feed.append(toolDelta(1, 'open', 'first', { name: 'a2ui' }), toolDelta(2, 'open', ' second'))
  const stream = watchStream(feed, 'open')
  assert.equal(feed.subscriberCount(), 0)
  assert.equal(stream.getSnapshot(), undefined)
  const off = stream.subscribe(() => {})
  assert.equal(stream.getSnapshot(), 'first second')
  off()
  assert.equal(feed.subscriberCount(), 0)
  assert.equal(stream.getSnapshot(), undefined)
  feed.settle('attempt')
  const restart = stream.subscribe(() => {})
  try {
    assert.equal(stream.getSnapshot(), undefined)
  } finally {
    restart()
  }
})

test('a message with an unsupported version cannot modify a valid earlier Surface', () => {
  const { surfaceId, components } = SURFACE.createSurface
  const update = { version: '0.8', updateComponents: { surfaceId, components: [{ id: 'title', component: 'Text', text: 'wrong' }] } }
  const preview = foldStreaming(JSON.stringify({ messages: [SURFACE, update] }))
  assert.equal(preview.surfaces[0].components.get('title').text, components.find(({ id }) => id === 'title').text)
  assert.equal(preview.truncated, true)
})

test('live readers share bounded storage per preview and in total', () => {
  const off = []
  const make = (text) => {
    const feed = sessionEvents()
    feed.append(toolDelta(1, 'bounded', text, { name: 'a2ui' }))
    const stream = watchStream(feed, 'bounded')
    off.push(stream.subscribe(() => {}))
    return stream
  }
  try {
    const small = Array.from({ length: MAX_STREAM_ENTRIES + 1 }, () => make('small'))
    assert.equal(small[0].getSnapshot(), undefined, 'reader count is capped')
    assert.equal(small.at(-1).getSnapshot(), 'small')
    const big = 'x'.repeat(MAX_STREAM_CHARS + 1)
    const count = Math.floor(MAX_STREAM_TOTAL_CHARS / MAX_STREAM_CHARS)
    const large = Array.from({ length: count + 1 }, () => make(big))
    assert.equal(large[0].getSnapshot(), undefined, 'total characters are capped')
    assert.equal(large.at(-1).getSnapshot().length, MAX_STREAM_CHARS)
  } finally {
    off.forEach((dispose) => dispose())
  }
})

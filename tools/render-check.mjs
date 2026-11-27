#!/usr/bin/env node
/**
 * Real-render check for the shipped browser bundle.
 *
 * Loads `client.js` the way the Harness module table does and renders the two
 * registered surfaces with real React against repository-local synthetic
 * fixtures. Every case asserts visible content, not just "did not throw", so a
 * regression in the component tree fails the check.
 *
 * A recorded session payload is opt-in: `node tools/render-check.mjs --session`.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { loadView, renderToHtml, sessionEvents, toolDelta, visibleText, ROOT } from './lib/render-view.mjs'

const useRecorded = process.argv.includes('--session')

/* ------------------------------------------------------------------ */
/* Synthetic fixtures                                                   */
/* ------------------------------------------------------------------ */

/** A surface that exercises every component in the catalog. */
function allComponents() {
  const components = [
    { id: 'root', component: 'Column', children: ['text', 'icons', 'layout', 'card', 'tabs', 'divider', 'form', 'table', 'stats', 'charts', 'plot', 'displays', 'player', 'progress', 'modal', 'media'] },
    { id: 'text', component: 'Text', text: '**Bold** and *italic* and `code`\nsecond line' },
    { id: 'icons', component: 'Row', children: ['iconOk', 'iconWarn'] },
    { id: 'iconOk', component: 'Icon', name: 'check' },
    { id: 'iconWarn', component: 'Icon', name: 'warning' },
    { id: 'layout', component: 'Row', children: ['l1', 'l2'], justify: 'spaceBetween' },
    { id: 'l1', component: 'Text', text: 'left', weight: 1 },
    { id: 'l2', component: 'Text', text: 'right', weight: 2 },
    { id: 'card', component: 'Card', child: 'text' },
    { id: 'tabs', component: 'Tabs', tabs: [{ title: 'One', child: 'l1' }, { title: 'Two', child: 'l2' }] },
    { id: 'divider', component: 'Divider' },
    { id: 'form', component: 'Column', children: ['tf', 'cb', 'cp', 'sl', 'dt', 'btn'] },
    { id: 'tf', component: 'TextField', label: 'Name', value: { '@path': '/name' }, placeholder: 'x' },
    { id: 'cb', component: 'CheckBox', label: 'Agree', value: { '@path': '/agree' } },
    { id: 'cp', component: 'ChoicePicker', label: 'Pick', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], value: { '@path': '/pick' }, variant: 'multipleSelection', displayStyle: 'chips' },
    { id: 'sl', component: 'Slider', label: 'Amount', min: 0, max: 10, value: { '@path': '/amount' } },
    { id: 'dt', component: 'DateTimeInput', label: 'When', value: '', enableDate: true },
    { id: 'btn', component: 'Button', variant: 'primary', child: 'btnText', action: { event: { name: 'go', context: { name: { '@path': '/name' } } } } },
    { id: 'btnText', component: 'Text', text: 'Submit' },
    { id: 'table', component: 'Table', caption: 'Rows', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', format: 'number' }], rows: [{ a: 'x', b: 1 }, { a: 'y', b: 2 }] },
    { id: 'stats', component: 'Row', children: ['s1', 's2'], justify: 'start' },
    { id: 's1', component: 'Stat', label: 'Revenue', value: 1200, unit: 'CNY', trend: 'up', delta: '+8%' },
    { id: 's2', component: 'Stat', label: 'Churn', value: 0.03, trend: 'down', delta: '-1%' },
    { id: 'charts', component: 'Column', children: ['bar', 'line', 'pie'] },
    { id: 'bar', component: 'BarChart', categories: ['Q1', 'Q2'], series: [{ label: 'A', values: [3, 5] }, { label: 'B', values: [1, 2] }] },
    { id: 'line', component: 'LineChart', categories: ['Q1', 'Q2', 'Q3'], series: [{ label: 'A', values: [1, 4, 2] }], area: true, curve: 'smooth' },
    { id: 'pie', component: 'PieChart', slices: [{ label: 'x', value: 3 }, { label: 'y', value: 1 }], donut: true },
    { id: 'plot', component: 'Plot', plots: [{ label: 'f', expression: 'a*x^2+b' }], variables: { a: { '@path': '/a' }, b: 1 }, xMin: -3, xMax: 3 },
    { id: 'displays', component: 'Section', title: 'Additional displays', children: ['heatmap', 'timeline'] },
    { id: 'heatmap', component: 'Heatmap', caption: 'Correlation matrix', rowLabels: ['Signal A'], columnLabels: ['Signal B', 'Signal C'], values: [[-0.6, null]], scale: 'diverging' },
    { id: 'timeline', component: 'Timeline', events: [{ when: 'Release day', title: 'Rollout started', status: 'current' }] },
    { id: 'player', component: 'FramePlayer', frames: [{ label: 'f1', items: [{ value: 1 }, { value: 2 }] }, { label: 'f2', items: [{ value: 2, state: 'sorted' }, { value: 1 }] }], mode: 'bars' },
    { id: 'progress', component: 'Progress', label: 'Done', value: 4, max: 10, tone: 'success' },
    { id: 'modal', component: 'Modal', trigger: 'btn', content: 'text' },
    { id: 'media', component: 'Column', children: ['img'] },
    { id: 'img', component: 'Image', url: 'https://example.com/a.png', description: 'x' },
  ]
  return [{ version: '1.0', createSurface: { surfaceId: 'all', catalogId: 'dsh-a2ui/catalog/v1', components, dataModel: { name: 'Ada', agree: true, pick: ['a'], amount: 5, a: 2 } } }]
}

/** The official `00_incremental` shape: a list, then one appended record. */
function incrementalRestaurants() {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'restaurants',
        catalogId: 'dsh-a2ui/catalog/v1',
        dataModel: { places: ['Ramen Lab', 'Bistro Nord', 'Bao House'] },
        components: [
          { id: 'root', component: 'Column', children: ['title', 'list'] },
          { id: 'title', component: 'Text', text: 'Nearby restaurants' },
          { id: 'list', component: 'Column', children: ['r0', 'r1', 'r2'] },
          { id: 'r0', component: 'Text', text: { '@path': '/places/0' } },
          { id: 'r1', component: 'Text', text: { '@path': '/places/1' } },
          { id: 'r2', component: 'Text', text: { '@path': '/places/2' } },
        ],
      },
    },
    {
      version: '1.0',
      updateComponents: { surfaceId: 'restaurants', components: [{ id: 'list', component: 'Column', children: ['r0', 'r1', 'r2', 'r3'] }, { id: 'r3', component: 'Text', text: 'Trattoria Uno' }] },
    },
    { version: '1.0', updateDataModel: { surfaceId: 'restaurants', path: '/places/3', value: 'Trattoria Uno' } },
  ]
}

/** The official `00_incremental.json`, verbatim from the pinned upstream commit. */
function officialIncremental() {
  const file = path.join(ROOT, 'tests', 'fixtures', 'examples', '00_incremental.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')).messages
}

function block(messages, title, extra = {}) {
  return {
    kind: 'tool-result',
    callId: extra.callId ?? 'call_test',
    name: 'a2ui',
    call: { name: 'a2ui', argsRaw: JSON.stringify({ messages, title }) },
    content: [{ type: 'text', text: 'rendered' }],
    isError: false,
    meta: { kind: 'a2ui', title, messages, surfaces: [{ surfaceId: 'x', components: 1 }] },
    ...extra,
  }
}

/* ------------------------------------------------------------------ */
/* Optional: the newest recorded payload in this workspace              */
/* ------------------------------------------------------------------ */

function decodeLog(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let cursor = buffer.indexOf(magic)
  while (cursor >= 0) {
    starts.push(cursor)
    cursor = buffer.indexOf(magic, cursor + 4)
  }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buffer).toString('utf8')
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8'))
    } catch {
      /* partial trailing frame */
    }
  }
  return parts.join('')
}

function recordedCall() {
  const dir = path.join('C:\\Users\\ChimeSky\\.dsh\\sessions', '--C-Users-ChimeSky-Desktop-DSH-plugins-a2ui--')
  if (!fs.existsSync(dir)) return undefined
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'session.v4.jsonl.zstd'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const candidate of files.slice(0, 4)) {
    const events = decodeLog(fs.readFileSync(candidate.file))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
    const calls = new Map()
    for (const event of events) if (event.type === 'tool/call' && event.data?.name === 'a2ui') calls.set(event.data.callId, event.data)
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const callId = event.data?.message?.source?.callId
      if (!calls.has(callId)) continue
      const meta = event.data?.meta
      if (meta?.kind !== 'a2ui' || !Array.isArray(meta.messages)) continue
      return {
        callId,
        block: {
          kind: 'tool-result',
          callId,
          name: 'a2ui',
          call: { name: 'a2ui', argsRaw: calls.get(callId)?.arguments ?? '' },
          content: event.data?.message?.content ?? [],
          isError: false,
          meta,
          argsRaw: calls.get(callId)?.arguments ?? '',
        },
      }
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

const feed = sessionEvents()
const { View, Tail } = loadView({ locale: 'en-US', eventSource: () => feed })
const failures = []
let passed = 0

function check(name, html, expectations, forbidden = []) {
  const text = visibleText(html)
  const missing = expectations.filter((needle) => !text.includes(needle) && !html.includes(needle))
  if (missing.length > 0) {
    failures.push({ name, missing, text: text.slice(0, 400) })
    console.log(`\n[FAIL] ${name}: missing ${missing.map((entry) => JSON.stringify(entry)).join(', ')}`)
    console.log(`       got: ${text.slice(0, 240)}`)
    return
  }
  const leaked = forbidden.filter((needle) => text.includes(needle) || html.includes(needle))
  if (leaked.length > 0) {
    failures.push({ name, missing: leaked.map((entry) => `must not show ${JSON.stringify(entry)}`), text: text.slice(0, 400) })
    console.log(`\n[FAIL] ${name}: showed ${leaked.map((entry) => JSON.stringify(entry)).join(', ')}`)
    console.log(`       got: ${text.slice(0, 240)}`)
    return
  }
  passed += 1
  console.log(`\n[ok] ${name}: ${html.length} bytes`)
  console.log(`     ${text.slice(0, 180)}`)
}

function renderCase(name, Component, props, expectations, forbidden = []) {
  try {
    const html = renderToHtml(Component, props)
    check(name, html, expectations, forbidden)
  } catch (error) {
    failures.push({ name, error })
    console.log(`\n[FAIL] ${name}: threw ${error && error.message}`)
    console.log(String(error && error.stack).split('\n').slice(0, 6).join('\n'))
  }
}

const baseProps = { callId: 'call_test', toolName: 'a2ui', sessionId: 'session-test' }

renderCase('all components', View, { ...baseProps, phase: 'result', block: block(allComponents(), 'All components') }, [
  'Bold',
  'left',
  'right',
  'One',
  'Two',
  'Name',
  'Agree',
  'Submit',
  'Rows',
  'Revenue',
  '1,200',
  'Churn',
  'Done',
  'Additional displays',
  'Correlation matrix',
  'Release day',
  'Rollout started',
])

renderCase('incremental create + append', View, { ...baseProps, phase: 'result', block: block(incrementalRestaurants(), 'Restaurants') }, [
  'Ramen Lab',
  'Bistro Nord',
  'Bao House',
  'Trattoria Uno',
])

const pie = [{ version: '1.0', createSurface: { surfaceId: 'shares', components: [{
  id: 'root',
  component: 'PieChart',
  donut: true,
  slices: Array.from({ length: 41 }, (_, index) => ({ label: `Category ${index + 1}`, value: index === 40 ? 60 : 1 })),
}] } }]
renderCase('pie percentages include grouped categories', View, { ...baseProps, phase: 'result', block: block(pie, 'Shares') }, [
  'Total 100',
  'Category 1 · 1%',
  'Other (1) 60',
  'Categories grouped as Other: 1',
])

// The upstream example is the contract test for template scope: every row's
// `Text` resolves a *relative* path, so a dropped item scope renders 4 empty
// rows with 4 "Book now" buttons.
renderCase('official 00_incremental renders every row', View, { ...baseProps, phase: 'result', block: block(officialIncremental(), 'Incremental') }, [
  'The Golden Fork',
  'Fine Dining & Spirits',
  '123 Gastronomy Lane',
  "Ocean's Bounty",
  'Pizzeria Roma',
  'Spice Route',
  '101 Silk Road St',
  'Book now',
])

for (const [xMin, xMax] of [[2, 2], [3, 1]]) {
  const messages = [{
    version: '1.0',
    createSurface: {
      surfaceId: 'plot-range',
      components: [{ id: 'root', component: 'Plot', xMin, xMax, plots: [{ label: 'Square', expression: 'x*x' }] }],
    },
  }]
  renderCase(`plot reports an invalid range (${xMin}, ${xMax})`, View,
    { ...baseProps, phase: 'result', block: block(messages, 'Plot range') },
    ['The plot range requires xMin to be less than xMax.'], ['Invalid function expression'])
}

renderCase('preparing shows a skeleton', View, { ...baseProps, phase: 'preparing', block: { phase: 'preparing', callId: 'call_p', name: 'a2ui', subCalls: [] } }, ['Building interface'])

/* Render preparing against the same Session binding used by the browser. */
function primed(name, callId, text, expectations, forbidden) {
  const cut = Math.floor(text.length / 2)
  feed.replace([toolDelta(1, callId, text.slice(0, cut), { name: 'a2ui' }), toolDelta(2, callId, text.slice(cut))])
  renderCase(name, View, { ...baseProps, callId, phase: 'preparing', block: { phase: 'preparing', callId, name: 'a2ui', subCalls: [] } }, expectations, forbidden)
  feed.replace([])
}

const streamingPayload = JSON.stringify({
  title: 'Revenue by region',
  messages: [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'stream',
        catalogId: 'dsh-a2ui/catalog/v1',
        components: [
          { id: 'root', component: 'Column', children: ['heading', 'note', 'later'] },
          { id: 'heading', component: 'Text', text: 'Arrived heading' },
          { id: 'note', component: 'Text', text: 'Arrived note' },
          { id: 'declared', component: 'Text', text: 'Not referenced yet' },
        ],
      },
    },
  ],
})

primed('preparing draws the components that already arrived', 'call_stream', streamingPayload, ['Revenue by region', 'Arrived heading', 'Arrived note', 'generating'], [
  // `later` is referenced by the root but has not been written: it must become a
  // placeholder, never a "missing child" error.
  'Missing child',
])

// The same payload cut inside the first component's own `text`: only what closed
// is drawn, the reference to the unfinished component becomes a placeholder, and
// nothing reports a defect.
primed(
  'preparing drops the half-written component',
  'call_partial',
  streamingPayload.slice(0, streamingPayload.indexOf('Arrived heading') + 8),
  ['Revenue by region', 'generating'],
  ['Arrived heading', 'Arrived note', 'Missing child'],
)

primed('preparing with no usable content keeps the skeleton', 'call_bare', '{"messages":[{"version":"1.0","crea', ['Building interface'], [])

primed('preparing renders the official incremental rows', 'call_official_stream', JSON.stringify({ messages: officialIncremental() }).slice(0, -1), [
  'generating', 'The Golden Fork', "Ocean's Bounty", 'Pizzeria Roma', 'Spice Route',
])

// The reviewer's bypass: a component that closed but is illegal on its own must
// not be drawn by the preview (the settled path rejects the same payload).
const illegalTabs = JSON.stringify({
  messages: [{ version: '1.0', createSurface: { surfaceId: 'tabs', catalogId: 'dsh-a2ui/catalog/v1', components: [{ id: 'root', component: 'Tabs', tabs: [null] }] } }],
})
primed('preparing refuses a closed but illegal component', 'call_illegal', illegalTabs, ['Building interface'], ['Missing child', 'Error'])

renderCase('settled path still rejects the same illegal payload', View, { ...baseProps, phase: 'result', block: block(JSON.parse(illegalTabs).messages, 'Illegal') }, [
  'failed validation',
])

renderCase(
  'host rejection has a compact row with expandable diagnostics',
  View,
  {
    ...baseProps,
    phase: 'result',
    block: {
      kind: 'tool-result',
      callId: 'call_err',
      name: 'a2ui',
      call: { name: 'a2ui', argsRaw: '{}' },
      content: [{ type: 'text', text: 'Error: A2UI payload rejected (1 problem):\n- /messages/0: nope' }],
      isError: true,
      meta: undefined,
    },
  },
  ['Call failed', '<details', 'payload rejected', '/messages/0'],
  ['a2ui-notice-error'],
)

renderCase(
  'invalid payload is guarded in the client',
  View,
  {
    ...baseProps,
    phase: 'result',
    block: block([{ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Nope' }] } }], 'Broken'),
  },
  ['failed validation', 'unknown component'],
)

renderCase(
  'update-only call explains itself',
  View,
  {
    ...baseProps,
    phase: 'result',
    block: block([{ version: '1.0', updateDataModel: { surfaceId: 'earlier', path: '/a', value: 1 } }], 'Update'),
  },
  ['updated'],
)

renderCase('process row, copy claimed elsewhere', View, { ...baseProps, phase: 'result', block: block(allComponents(), 'All components'), compact: true }, [
  'All components',
  'shown at the end of this turn',
])

const tailNodes = new Map([
  ['call:test', { kind: 'tool-call', visibility: 'visible', location: { kind: 'step', turn: { turn: 1 } }, data: { root: block(incrementalRestaurants(), 'Restaurants') } }],
])
renderCase(
  'turn tail renders the turn cards',
  Tail,
  {
    turn: { turn: 1, status: 'closed' },
    seq: 99,
    sessionId: 'session-test',
    useChat: (selector) => selector({ order: ['call:test'], nodes: tailNodes }),
  },
  ['Ramen Lab', 'Trattoria Uno'],
)

renderCase(
  'turn tail without an a2ui call renders nothing',
  Tail,
  { turn: { turn: 2, status: 'closed' }, seq: 100, sessionId: 'session-test', useChat: (selector) => selector({ order: ['call:test'], nodes: tailNodes }) },
  [],
)

if (useRecorded) {
  const recorded = recordedCall()
  if (recorded === undefined) {
    console.log('\n[skip] recorded session: no a2ui call found')
  } else {
    renderCase('recorded payload', View, { ...baseProps, callId: recorded.callId, phase: 'result', block: recorded.block }, [])
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} render case(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nall ${passed} render cases matched their expectations`)
process.exit(0)

/**
 * DOM-level behaviour of the shipped browser bundle.
 *
 * The SSR harness proves structure; these tests prove the interaction contract
 * the review asked for with real events: a double click enqueues once, a rejected
 * send leaves the form editable so it can be retried, an edit made in the process
 * row is still there when the turn tail takes over, and a hidden call never
 * renders.
 *
 * The action path is exercised through the plugin's *own* `sendPrompt`, which
 * looks the Conversation service up through `sessions.scope(id).get(...)`; the
 * harness supplies that service, so a click proves the message would really be
 * queued — not that a test double was called.
 *
 * jsdom is a dev-only dependency; the bundle itself still needs only `react`.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const { window } = dom

/** Node's own globals for `window`/`navigator` are read-only accessors. */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

// The DOM globals must exist *before* `react-dom` is imported: it captures
// `document`/`window` while initializing, and with them missing the event system
// never receives a single event (silent, and very confusing).
defineGlobal('window', window)
defineGlobal('document', window.document)
defineGlobal('navigator', window.navigator)
defineGlobal('IS_REACT_ACT_ENVIRONMENT', true)
defineGlobal('HTMLElement', window.HTMLElement)
defineGlobal('HTMLInputElement', window.HTMLInputElement)
defineGlobal('MouseEvent', window.MouseEvent)
defineGlobal('Event', window.Event)

const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')
const { loadView, React, ROOT, sessionEvents, toolDelta } = await import('../tools/lib/render-view.mjs')

/** Messages the plugin would queue, in order. */
let sent = []
/** When set, the next queued send rejects with this message. */
let sendFailure = null

const feeds = new Map()
const { View, Tail } = loadView({
  eventSource: (sessionId) => feeds.get(sessionId),
  locale: 'en-US',
  // The plugin attaches the modal's Escape/Tab handling to `document`, so the
  // bundle must see the same document the test dispatches into.
  document: window.document,
  onSend: async (text, sessionId) => {
    if (sendFailure !== null) {
      const failure = sendFailure
      sendFailure = null
      throw new Error(failure)
    }
    sent.push({ text, sessionId })
  },
})

function surfaceBlock(messages) {
  return {
    kind: 'tool-result',
    callId: 'call_dom',
    name: 'a2ui',
    call: { name: 'a2ui', argsRaw: JSON.stringify({ messages }) },
    content: [{ type: 'text', text: 'rendered' }],
    isError: false,
    meta: { kind: 'a2ui', messages },
  }
}

function formMessages() {
  return [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'form',
        dataModel: { name: '' },
        components: [
          { id: 'root', component: 'Column', children: ['field', 'slider', 'submit'] },
          { id: 'field', component: 'TextField', label: 'Name', value: { '@path': '/name' } },
          { id: 'slider', component: 'Slider', label: 'Amount', min: 0, max: 10, value: { '@path': '/amount' } },
          {
            id: 'submit',
            component: 'Button',
            child: 'submitLabel',
            action: { event: { name: 'save', context: { name: { '@path': '/name' }, amount: { '@path': '/amount' } } } },
          },
          { id: 'submitLabel', component: 'Text', text: 'Save' },
        ],
      },
    },
  ]
}

/** Each test gets its own session, so no editable state leaks between cases. */
let sessionSerial = 0

function viewProps(overrides = {}) {
  sessionSerial += 1
  return {
    callId: 'call_dom',
    toolName: 'a2ui',
    sessionId: `session-dom-${sessionSerial}`,
    phase: 'result',
    block: surfaceBlock(formMessages()),
    ...overrides,
  }
}

function tailProps(sessionId, nodes, turn) {
  return {
    turn: { turn, status: 'closed' },
    seq: 1,
    sessionId,
    useChat: (selector) => selector({ order: [...nodes.keys()], nodes, locations: { getTurn: () => [...nodes.keys()] } }),
  }
}

function nodeFor(root, turn, visibility = 'visible') {
  return { kind: 'tool-call', visibility, location: { kind: 'turn', turn: { turn } }, data: { root } }
}

/**
 * Mount one element.
 * @param element the React element to render.
 * @param into an existing container, for a case that needs two live views in the
 *   same page — the default single `#root` is cleared on every mount, so two
 *   views would evict each other.
 */
function mount(element, into) {
  const container = into ?? window.document.getElementById('root')
  if (into === undefined) container.innerHTML = ''
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    render: (next) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  }
}

function query(container, selector) {
  const element = container.querySelector(selector)
  assert.ok(element !== null, `expected ${selector} to exist`)
  return element
}

test('compact Section streams inertly and survives history replay from result metadata', () => {
  const messages = [{ version: '1.0', createSurface: { surfaceId: 'summary', components: [
    { id: 'root', component: 'Section', title: 'What changed', description: 'Two points', children: ['body'] },
    { id: 'body', component: 'Text', text: 'Summary content' },
  ] } }]
  const { sessionId, callId } = viewProps()
  const feed = sessionEvents([])
  feeds.set(sessionId, feed)
  const mounted = mount(React.createElement(View, viewProps({
    callId, sessionId, phase: 'preparing',
    block: { phase: 'preparing', callId, name: 'a2ui', subCalls: [] },
  })))
  try {
    const raw = JSON.stringify({ presentation: 'compact', messages })
    act(() => feed.append(toolDelta(1, callId, raw.slice(0, -1), { name: 'a2ui' })))
    assert.equal(query(mounted.container, '.a2ui-compact-body').hasAttribute('inert'), true)
    assert.equal(query(mounted.container, 'section h3').textContent, 'What changed')
    assert.equal(mounted.container.querySelector('.a2ui-card-head'), null)
    const block = surfaceBlock(messages)
    block.meta.presentation = 'compact'
    block.call = undefined
    mounted.render(React.createElement(View, viewProps({ callId, sessionId, block })))
    assert.equal(query(mounted.container, '.a2ui-compact-body').hasAttribute('inert'), false)
    assert.equal(query(mounted.container, 'section h3').textContent, 'What changed')
    assert.equal(mounted.container.querySelector('.a2ui-compact-head'), null)
    assert.equal(mounted.container.querySelector('.a2ui-card-head'), null)
    block.meta = { kind: 'a2ui', messages, presentation: 'compact', title: 'Report' }
    mounted.render(React.createElement(View, viewProps({ block: { ...block } })))
    assert.equal(query(mounted.container, '.a2ui-compact-head').textContent, 'Report')
  } finally {
    mounted.unmount()
    feeds.delete(sessionId)
  }
})

test('scatter displays exact values with hover, keyboard and repeated taps on overlapping points', () => {
  const components = [
    { id: 'root', component: 'Column', children: ['plot', 'score'] },
    {
      id: 'plot', component: 'Plot', xLabel: 'Time (min)', yLabel: 'Score',
      plots: [
        { kind: 'scatter', label: 'Group A', points: { '@path': '/points' } },
        { kind: 'scatter', label: 'Group B', points: [{ x: 0, y: -1.23456789, label: 'Overlap' }] },
      ],
    },
    { id: 'score', component: 'Slider', label: 'Edit score', min: -5, max: 20, value: { '@path': '/points/0/y' } },
  ]
  const dataModel = { points: [{ x: 0, y: -1.23456789, label: 'First' }, { x: 20, y: 12.5, label: 'Last' }] }
  const block = surfaceBlock([{ version: '1.0', createSurface: { surfaceId: 'plot', components, dataModel } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const frame = query(container, '.a2ui-plot-frame[tabindex="0"]')
    const svg = query(frame, 'svg')
    const first = query(svg, '[data-plot-point="0"]')
    const overlap = query(svg, '[data-plot-point="2"]')
    assert.equal(first.getAttribute('cx'), overlap.getAttribute('cx'))
    assert.equal(first.getAttribute('cy'), overlap.getAttribute('cy'))
    assert.equal(frame.querySelectorAll('[tabindex]').length, 0, 'only the HTML frame is in the tab order')
    assert.match(container.textContent, /Time \(min\).*Score|Score.*Time \(min\)/u)
    act(() => first.dispatchEvent(new window.Event('pointerover', { bubbles: true })))
    const tooltip = () => query(container, '[role="tooltip"]').textContent
    assert.match(tooltip(), /Group A.*Time \(min\): 0.*Score: -1\.23456789/u)
    act(() => frame.focus())
    assert.equal(window.document.activeElement, frame)
    keyboard(frame, 'End')
    assert.match(tooltip(), /Overlap.*Group B/u)
    keyboard(frame, 'Escape')
    assert.equal(container.querySelector('[role="tooltip"]'), null)
    click(overlap)
    assert.match(tooltip(), /Overlap.*Overlapping point 2\/2/u)
    click(overlap)
    assert.match(tooltip(), /First.*Overlapping point 1\/2/u)
    typeInto(query(container, 'input[type="range"]'), '18')
    assert.ok(!container.querySelector('[role="tooltip"]'), 'a selection cannot point to replaced data')
    click(first)
    assert.match(tooltip(), /First.*Score: 18/u)
    act(() => query(container, 'input[type="range"]').focus())
    assert.ok(!container.querySelector('[role="tooltip"]'), 'focus leaving the plot clears its active mark')
  } finally {
    unmount()
  }
})

test('Plot legends toggle scatter series without moving visible points or leaving stale tooltips', () => {
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'scatter-legend',
    components: [{ id: 'root', component: 'Plot', plots: [
      { kind: 'scatter', label: 'Group A', points: [{ x: 0, y: 1, label: 'A point' }] },
      { kind: 'scatter', label: 'Group B', points: [{ x: 9, y: 10, label: 'B point' }] },
    ] }],
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const [groupA, groupB] = container.querySelectorAll('.a2ui-legend-item')
    const ticks = () => [...container.querySelectorAll('.a2ui-grid text')].map((tick) => tick.textContent)
    const marks = () => [...container.querySelectorAll('[data-plot-point]')]
      .map((mark) => ['cx', 'cy', 'fill'].map((attr) => mark.getAttribute(attr)))
    const initialTicks = ticks()
    const initialMarks = marks()
    const bPoint = query(container, '[data-plot-point="1"]')
    act(() => bPoint.dispatchEvent(new window.Event('pointerover', { bubbles: true })))
    assert.match(query(container, '[role="tooltip"]').textContent, /B point/u)

    click(groupB)
    assert.equal(groupB.getAttribute('aria-pressed'), 'false')
    assert.ok(groupB.classList.contains('a2ui-legend-off'))
    assert.deepEqual(marks(), [initialMarks[0]])
    assert.deepEqual(ticks(), initialTicks)
    assert.ok(!container.querySelector('[role="tooltip"]'))

    click(groupA)
    assert.deepEqual(marks(), [])
    assert.deepEqual(ticks(), initialTicks)
    click(groupB)
    assert.equal(groupB.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(marks(), [initialMarks[1]])
    click(groupA)
    assert.deepEqual(marks(), initialMarks)
  } finally {
    unmount()
  }
})

test('bubbles and linear fits toggle together while radius and axes stay stable', () => {
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'bubbles',
    dataModel: { small: [
      { x: 0, y: 0, size: 5, label: 'Small bubble' },
      { x: 1, y: 2, size: 20 },
      { x: 2, y: 4, size: 0 },
      { x: 3, y: 6 },
    ] },
    components: [{ id: 'root', component: 'Plot', sizeLabel: 'Samples', plots: [
      { kind: 'scatter', label: 'Small', regression: 'linear', points: { '@path': '/small' } },
      { kind: 'scatter', label: 'Large', regression: 'linear', points: [
        { x: 0, y: 0, size: 320 }, { x: 4, y: 3, size: 80 },
      ] },
      { kind: 'scatter', label: 'Vertical', regression: 'linear', points: [{ x: 2, y: 0 }, { x: 2, y: 8 }] },
    ] }],
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const point = (index) => query(container, `[data-plot-point="${index}"]`)
    const coords = () => ['cx', 'cy', 'r'].map((name) => point(0).getAttribute(name))
    const first = coords()
    assert.equal(Number(point(1).getAttribute('r')) / Number(first[2]), 2)
    assert.equal(point(2).getAttribute('fill'), 'transparent')
    assert.equal(point(3).getAttribute('r'), '3.5')
    assert.ok(point(4).compareDocumentPosition(point(0)) & window.Node.DOCUMENT_POSITION_FOLLOWING)
    assert.equal(container.querySelectorAll('[data-plot-regression]').length, 2)
    assert.match(container.textContent, /Small.*Linear fit · R² 1/u)
    assert.match(container.textContent, /Vertical.*requires at least two distinct X values/u)
    act(() => point(0).dispatchEvent(new window.Event('pointerover', { bubbles: true })))
    assert.match(query(container, '[role="tooltip"]').textContent, /Samples: 5/u)
    const ticks = () => [...container.querySelectorAll('.a2ui-grid text')].map((tick) => tick.textContent)
    const initialTicks = ticks()
    click(query(container, '.a2ui-legend-item[title="Large"]'))
    assert.equal(container.querySelector('[data-plot-regression="1"]'), null)
    assert.equal(container.querySelectorAll('[data-plot-regression]').length, 1)
    assert.deepEqual(coords(), first)
    assert.deepEqual(ticks(), initialTicks)
    const frame = query(container, '.a2ui-plot-frame[tabindex="0"]')
    act(() => frame.focus())
    keyboard(frame, 'ArrowRight')
    keyboard(frame, 'ArrowRight')
    assert.match(query(container, '[role="tooltip"]').textContent, /Samples: 0/u)
  } finally {
    unmount()
  }
})

test('a linked function plot keeps its Y axis while the slider crosses zero', () => {
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'linked-curve',
    dataModel: { a: 1 },
    components: [
      { id: 'root', component: 'Column', children: ['coefficient', 'plot'] },
      { id: 'coefficient', component: 'Slider', label: 'a', min: -1, max: 2, value: { '@path': '/a' } },
      { id: 'plot', component: 'Plot', xMin: -2, xMax: 2, variables: { a: { '@path': '/a' } },
        plots: [{ expression: 'a*x^2' }] },
    ],
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const slider = query(container, 'input[type="range"]')
    const axis = () => [...container.querySelectorAll('.a2ui-grid text[text-anchor="end"]')]
      .map((tick) => [tick.textContent, tick.getAttribute('y')])
    const endpoint = () => Number(query(container, 'svg path[stroke-width="2"]').getAttribute('d').match(/^M[^,]+,([\d.]+)/u)[1])
    const ticks = axis()
    assert.ok(ticks.some(([value]) => Number(value) < 0))
    assert.ok(ticks.some(([value]) => Number(value) >= 8))
    let previous = endpoint()
    for (const value of [0.5, 0.031, 0, -0.031, -0.5, -1]) {
      typeInto(slider, String(value))
      assert.deepEqual(axis(), ticks)
      const next = endpoint()
      assert.ok(next > previous, `the y endpoint should move down as a becomes ${value}`)
      previous = next
    }
  } finally {
    unmount()
  }
})

test('scatter handles a single point, extreme coordinates, clipping and an empty data set', () => {
  const args = (points, range = {}) => surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'plot',
    components: [{ id: 'root', component: 'Plot', ...range, plots: [{ kind: 'scatter', points }] }],
  } }])
  const cases = [
    { block: args([{ x: 0, y: 0 }]), marks: 1 },
    { block: args([{ x: -Number.MAX_VALUE, y: -1 }, { x: Number.MAX_VALUE, y: 1 }]), marks: 2 },
    { block: args([{ x: -1, y: 0 }, { x: 1, y: 0 }], { xMin: 0, xMax: 2 }), marks: 1, note: /1 points fall outside/u },
    { block: args([]), marks: 0, note: /no scatter points/u },
  ]
  for (const { block, marks, note } of cases) {
    const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
    try {
      const drawn = [...container.querySelectorAll('[data-plot-point]')]
      assert.equal(drawn.length, marks)
      assert.ok(drawn.every((point) => ['cx', 'cy'].every((axis) => Number.isFinite(Number(point.getAttribute(axis))))))
      if (note) assert.match(container.textContent, note)
    } finally {
      unmount()
    }
  }
})

test('heatmap shows exact zero, missing data, and a clipped color via keyboard and pointer', () => {
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'matrix',
    components: [{ id: 'root', component: 'Heatmap', rowLabels: ['Quality'], columnLabels: ['A', 'B', 'C'],
      values: [[null, 0, 2.123456]], min: -1, max: 1, scale: 'diverging', unit: 'pts' }],
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const cells = [...container.querySelectorAll('td[data-heat-cell]')]
    assert.equal(cells.length, 3)
    assert.equal(container.querySelectorAll('td[tabindex="0"]').length, 1)
    assert.ok(cells[0].classList.contains('a2ui-heat-missing'))
    assert.ok(!cells[1].classList.contains('a2ui-heat-missing'))
    assert.match(cells[1].getAttribute('aria-label'), /Quality · B · 0 pts/u)
    const tip = () => query(container, '[role="tooltip"]').textContent
    act(() => cells[0].focus())
    assert.match(tip(), /Missing/u)
    keyboard(cells[0], 'ArrowRight')
    assert.ok(window.document.activeElement === cells[1])
    assert.match(tip(), /Quality · B.*0 pts/u)
    keyboard(cells[1], 'End')
    assert.ok(window.document.activeElement === cells[2])
    assert.match(tip(), /2\.123456 pts.*Outside the color scale/u)
    keyboard(cells[2], 'Escape')
    assert.ok(!container.querySelector('[role="tooltip"]'))
    act(() => cells[1].dispatchEvent(new window.Event('pointerover', { bubbles: true })))
    assert.match(tip(), /Quality · B.*0 pts/u)
    click(cells[0])
    assert.match(tip(), /Quality · A.*Missing/u)
    const pointer = (cell, type, pointerType, relatedTarget = null) => {
      const event = new window.MouseEvent(type, { bubbles: true, relatedTarget })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      act(() => cell.dispatchEvent(event))
    }
    pointer(cells[0], 'pointerout', 'mouse', cells[1])
    assert.ok(!container.querySelector('[role="tooltip"]'))
    pointer(cells[1], 'pointerover', 'mouse', cells[0])
    assert.match(tip(), /Quality · B.*0 pts/u)
    pointer(cells[1], 'pointerout', 'mouse', container)
    assert.ok(!container.querySelector('[role="tooltip"]'))

    pointer(cells[0], 'pointerdown', 'touch')
    click(cells[0])
    pointer(cells[0], 'pointerout', 'touch')
    assert.match(tip(), /Quality · A.*Missing/u)
    pointer(cells[1], 'pointerover', 'mouse')
    assert.match(tip(), /Quality · B.*0 pts/u)

    const scroller = query(container, '.a2ui-heatmap-scroll')
    const table = query(scroller, 'table')
    assert.ok(!table.hasAttribute('data-heat-scrolled'))
    scroller.scrollLeft = 24
    scroller.scrollTop = 36
    scroller.dispatchEvent(new window.Event('scroll'))
    assert.equal(table.style.getPropertyValue('--a2ui-heat-scroll-x'), '24px')
    assert.equal(table.style.getPropertyValue('--a2ui-heat-scroll-y'), '36px')
    assert.ok(table.hasAttribute('data-heat-scrolled'))
    assert.ok(table.hasAttribute('data-heat-scrolled-y'))
    scroller.scrollLeft = 0
    scroller.scrollTop = 0
    scroller.dispatchEvent(new window.Event('scroll'))
    assert.ok(!table.hasAttribute('data-heat-scrolled'))
    assert.ok(!table.hasAttribute('data-heat-scrolled-y'))
  } finally {
    unmount()
  }
})

test('Pareto sorts bound items, reports the cumulative share and handles a zero total', () => {
  const component = { id: 'root', component: 'ParetoChart', items: { '@path': '/items' }, valueSuffix: 'cases' }
  const block = (items) => surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'pareto', components: [component], dataModel: { items },
  } }])
  const items = [{ label: 'Network', value: 30 }, { label: 'Other', value: 0 },
    { label: 'Timeout', value: 45 }, { label: 'Storage', value: 25 }]
  const { container, unmount } = mount(React.createElement(View, viewProps({ block: block(items) })))
  try {
    const svg = query(container, '.a2ui-pareto svg')
    const bars = [...svg.querySelectorAll('[data-pareto-bar]')]
    assert.equal(bars.length, 4)
    const heights = bars.map((bar) => Number(bar.getAttribute('height')))
    assert.deepEqual(heights, [...heights].sort((a, b) => b - a))
    assert.deepEqual(heights.slice(0, 3).map((height) => Math.round(height * 100 / 202)), [45, 30, 25])
    const frame = query(container, '.a2ui-pareto [tabindex="0"]')
    act(() => frame.focus())
    assert.match(query(container, '[role="tooltip"]').textContent, /Timeout.*45 cases.*45%/u)
    keyboard(frame, 'ArrowRight')
    assert.match(query(container, '[role="tooltip"]').textContent, /Network.*30 cases.*75%/u)
    keyboard(frame, 'End')
    assert.match(query(container, '[role="tooltip"]').textContent, /Other.*0 cases.*100%/u)
    keyboard(frame, 'Escape')
    assert.equal(container.querySelector('[role="tooltip"]'), null)
  } finally {
    unmount()
  }
  const zero = mount(React.createElement(View, viewProps({ block: block([{ label: 'None', value: 0 }]) })))
  try {
    assert.equal(zero.container.querySelector('[data-pareto-line]'), null)
    assert.match(zero.container.textContent, /All values are zero/u)
  } finally {
    zero.unmount()
  }
})

test('grouped error bars follow their own columns and clip caps outside a fixed domain', () => {
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'error-bars',
    dataModel: { categories: ['Run A', 'Run B', 'Run C'], actual: [10, null, 0] },
    components: [{ id: 'root', component: 'BarChart', categories: { '@path': '/categories' },
      yMin: -5, yMax: 15, valueSuffix: 'ms',
      series: [
        { label: 'Observed', values: { '@path': '/actual' }, errorLabel: '95% CI',
          errorBars: [{ lower: 8, upper: 17 }, null, { lower: -1, upper: 2 }] },
        { label: 'Baseline', values: [12, 4, 6], errorBars: [null, { lower: 2, upper: 6 }, null] },
      ],
    }],
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const bars = [...container.querySelectorAll('.a2ui-bar-plot rect')]
    const intervals = [...container.querySelectorAll('[data-bar-error]')]
    assert.equal(bars.length, 5)
    assert.equal(intervals.length, 3)
    for (const [index, bar] of [bars[0], bars[2], bars[3]].entries()) {
      const d = intervals[index].getAttribute('d')
      const [center, upperY] = [Number(/^M([^,]+)/u.exec(d)[1]), Number(/V([^M]+)/u.exec(d)[1])]
      assert.ok(Math.abs(center - Number(bar.getAttribute('x')) - Number(bar.getAttribute('width')) / 2) < 1e-9)
      assert.equal((d.match(/H/gu) ?? []).length, index === 0 ? 1 : 2)
      if (index === 0) assert.equal(upperY, 18)
    }
    act(() => bars[0].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
    assert.match(query(container, '[role="tooltip"]').textContent, /Run A.*Observed: 10 ms.*95% CI: 8 – 17 ms/u)
    click(query(container, '.a2ui-legend-item[title="Observed"]'))
    assert.equal(container.querySelectorAll('[data-bar-error]').length, 1)
    assert.equal(container.querySelector('[role="tooltip"]'), null)
  } finally {
    unmount()
  }
})

test('radar keeps gaps, zero, shared scores and legend toggles distinct', () => {
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'radar',
    dataModel: { scores: [100, null, 80, 40] },
    components: [{ id: 'root', component: 'RadarChart', axes: ['Speed', 'Accuracy', 'Stability', 'Cost'],
      series: [
        { label: 'Profile A', values: [100, 0, 80, 40] },
        { label: 'Profile B', values: { '@path': '/scores' } },
      ],
    }],
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    const frame = query(container, '.a2ui-radar-frame')
    const one = (index) => query(frame, `[data-radar-label="${index}"]`)
    const tip = () => query(frame, '[role="tooltip"]').textContent
    const point = query(frame, 'circle[data-radar-series="0"][data-radar-axis="1"]')
    const spoke = query(frame, '.a2ui-radar-grid line')
    assert.equal(point.getAttribute('cx'), spoke.getAttribute('x1'))
    assert.equal(point.getAttribute('cy'), spoke.getAttribute('y1'))
    assert.equal(frame.querySelector('circle[data-radar-series="1"][data-radar-axis="1"]'), null)
    const d = query(frame, '[data-radar-gap-path]').getAttribute('d')
    assert.equal(d.match(/M/gu).length, 2)
    assert.equal(frame.querySelectorAll('[data-radar-profile]').length, 1)
    assert.match(container.textContent, /1 missing/u)
    assert.match(container.textContent, /Shared scale 0 to 100/u)
    act(() => frame.focus())
    assert.match(tip(), /Speed.*Profile A: 100.*Profile B: 100/u)
    keyboard(frame, 'ArrowRight')
    assert.match(tip(), /Accuracy.*Profile A: 0.*Profile B: Missing/u)
    keyboard(frame, 'Escape')
    assert.equal(frame.querySelector('[role="tooltip"]'), null)

    click(one(1))
    assert.match(tip(), /Profile A: 0/u)
    act(() => one(1).dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true, relatedTarget: frame })))
    assert.equal(frame.querySelector('[role="tooltip"]'), null)
    const down = new window.Event('pointerdown', { bubbles: true })
    Object.defineProperty(down, 'pointerType', { value: 'touch' })
    act(() => one(1).dispatchEvent(down))
    click(one(1))
    act(() => one(1).dispatchEvent(new window.Event('pointerout', { bubbles: true })))
    assert.match(tip(), /Profile B: Missing/u)
    click(frame)
    assert.equal(frame.querySelector('[role="tooltip"]'), null)

    const [toggleA, toggleB] = container.querySelectorAll('.a2ui-radar-legend button')
    const geometry = query(frame, '[data-radar-profile]').getAttribute('points')
    click(toggleB)
    assert.equal(frame.querySelector('[data-radar-series-group="1"]'), null)
    assert.equal(query(frame, '[data-radar-profile]').getAttribute('points'), geometry)
    click(toggleA)
    assert.match(container.textContent, /All series are hidden/u)
    click(toggleA)
    assert.equal(query(frame, '[data-radar-profile]').getAttribute('points'), geometry)
  } finally {
    unmount()
  }
})

test('timeline renders bound events in input order and preserves date and description text', () => {
  const timestamp = '2026-11-24T23:45:00+08:00'
  const block = surfaceBlock([{ version: '1.0', createSurface: {
    surfaceId: 'release',
    components: [{ id: 'root', component: 'Timeline', events: { '@path': '/events' } }],
    dataModel: { events: [
      { when: timestamp, title: 'Earlier entry', status: 'done' },
      { when: timestamp, title: 'Later entry', status: 'blocked', description: 'Details\nSecond line' },
      { when: '待定', title: 'Follow-up', status: 'upcoming' },
    ] },
  } }])
  const { container, unmount } = mount(React.createElement(View, viewProps({ block })))
  try {
    assert.deepEqual([...container.querySelectorAll('.a2ui-timeline-title')].map((node) => node.textContent),
      ['Earlier entry', 'Later entry', 'Follow-up'])
    assert.deepEqual([...container.querySelectorAll('.a2ui-timeline-when')].map((node) => node.textContent),
      [timestamp, timestamp, '待定'])
    assert.match(query(container, '.a2ui-timeline-blocked').textContent, /Blocked/u)
    assert.equal(query(container, '.a2ui-timeline-description').textContent, 'Details\nSecond line')
  } finally {
    unmount()
  }
})

function typeInto(element, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function click(element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

/** Click and let the send promise settle (the failure path is asynchronous). */
async function clickSettled(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

before(() => {
  sent = []
  sendFailure = null
})

// No `after()` closing the jsdom window: with several test files imported into
// one process the hook can fire between them, leaving later renders with a
// closed document. The process exits without it.

test('an edit in the process row survives the hand-over to the turn tail', () => {
  const props = viewProps()
  const row = mount(React.createElement(View, props))
  typeInto(query(row.container, 'input[type="text"]'), 'Ada Lovelace')
  // The row is replaced by the tail copy — a different React tree and a fresh
  // component instance, so a component-local model would reset to `''` here.
  row.unmount()

  const nodes = new Map([['call:dom', nodeFor(surfaceBlock(formMessages()), 1)]])
  const tail = mount(React.createElement(Tail, tailProps(props.sessionId, nodes, 1)))
  assert.equal(query(tail.container, 'input[type="text"]').value, 'Ada Lovelace')
  tail.unmount()
})

test('a double click queues exactly one action', () => {
  sent = []
  const view = mount(React.createElement(View, viewProps()))
  const button = query(view.container, 'button')
  click(button)
  click(button)
  assert.equal(sent.length, 1, `expected one queued message, got ${sent.length}`)
  assert.match(sent[0].text, /^\[A2UI action\]/u)
  view.unmount()
})


test('two live views of one surface send one action for one click', () => {
  // The Step C target, at the layer the dedupe actually guards: the conversation
  // card and the sidebar tab body, both mounted, both showing one surface.
  //
  // They must render with DIFFERENT call ids, because that is what the tab does:
  // `makeTabBody` mounts the view with a `surfaceId` and no call, and the card
  // carries the call's id. That difference matters — local edit state is keyed by
  // `session + callId + surfaceId` (model-store.ts), so the shared form lock that
  // disables a button after the first click does NOT span the two views. The
  // mediator's window is the only thing between them.
  //
  // Both views come from the same module instance, so they share `runtime`, the
  // one ViewAdapter, and therefore its dedupe map. One surface, two subscribers,
  // one exit.
  sent = []
  const cardProps = viewProps()
  const hostA = window.document.createElement('div')
  const hostB = window.document.createElement('div')
  window.document.body.append(hostA, hostB)
  // Same session and surface, different call ids: card vs tab body.
  const card = mount(React.createElement(View, { ...cardProps, callId: 'call_card' }), hostA)
  const tab = mount(React.createElement(View, { ...cardProps, callId: 'call_tab' }), hostB)
  try {
    const buttonCard = query(card.container, '.a2ui-btn')
    const buttonTab = query(tab.container, '.a2ui-btn')
    // The tabs' lock is per call id, so this click does not disable the other view.
    click(buttonCard)
    const tabStillEnabled = buttonTab.disabled === false
    click(buttonTab)
    assert.equal(tabStillEnabled, true, 'the two views do not share the local form lock')
    assert.equal(sent.length, 1, `two views must send once, got ${sent.length}`)
    assert.match(sent[0].text, /^\[A2UI action\]/u)
  } finally {
    card.unmount()
    tab.unmount()
    hostA.remove()
    hostB.remove()
  }
})

test('a rejected send leaves the form editable so it can be retried', async () => {
  sent = []
  sendFailure = 'QUEUE_FULL'
  const view = mount(React.createElement(View, viewProps()))
  const button = query(view.container, 'button')
  const input = query(view.container, 'input[type="text"]')
  const slider = query(view.container, 'input[type="range"]')

  await clickSettled(button)
  assert.equal(sent.length, 0)
  assert.equal(input.disabled, false, 'the text field must be editable after a failure')
  assert.equal(slider.disabled, false, 'the slider must be editable after a failure')
  assert.equal(button.disabled, false, 'the button must be clickable again')

  typeInto(input, 'Grace Hopper')
  await clickSettled(button)
  assert.equal(sent.length, 1, 'the retry must queue exactly one message')
  assert.match(sent[0].text, /Grace Hopper/u)
  view.unmount()
})

test('a successful send locks the form', () => {
  sent = []
  const view = mount(React.createElement(View, viewProps()))
  click(query(view.container, 'button'))
  assert.equal(sent.length, 1)
  assert.equal(query(view.container, 'input[type="text"]').disabled, true)
  assert.equal(query(view.container, 'input[type="range"]').disabled, true)
  view.unmount()
})

test('a hidden call never renders at the turn tail', () => {
  const nodes = new Map([['call:hidden', nodeFor(surfaceBlock(formMessages()), 2, 'hidden')]])
  const tail = mount(React.createElement(Tail, tailProps('session-hidden', nodes, 2)))
  assert.equal(tail.container.querySelector('input[type="text"]'), null)
  tail.unmount()
})

test('a renamed tool still renders at the turn tail through its result meta', () => {
  const renamed = surfaceBlock(formMessages())
  renamed.name = 'myui'
  renamed.call = { name: 'myui', argsRaw: '{}' }
  const nodes = new Map([['call:renamed', nodeFor(renamed, 3)]])
  const tail = mount(React.createElement(Tail, tailProps('session-renamed', nodes, 3)))
  assert.ok(tail.container.querySelector('input[type="text"]') !== null, 'the renamed card must render')
  tail.unmount()
})

test('a renamed tool without a2ui meta is not claimed', () => {
  const foreign = { kind: 'tool-result', callId: 'call:foreign', name: 'myui', call: { name: 'myui', argsRaw: '{}' }, content: [], isError: false }
  const nodes = new Map([['call:foreign', nodeFor(foreign, 4)]])
  const tail = mount(React.createElement(Tail, tailProps('session-foreign', nodes, 4)))
  assert.equal(tail.container.innerHTML, '')
  tail.unmount()
})

test('the official incremental example wires each row button to its own row', () => {
  const messages = JSON.parse(fs.readFileSync(`${ROOT}/tests/fixtures/examples/00_incremental.json`, 'utf8')).messages
  sent = []
  const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
  const buttons = [...view.container.querySelectorAll('button')]
  assert.equal(buttons.length, 4, 'one button per restaurant')
  click(buttons[2])
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Pizzeria Roma/u)
  view.unmount()
})

/* ------------------------------------------------------------------ */
/* Keyboard behaviour: Tabs arrow keys, Modal focus management          */
/* ------------------------------------------------------------------ */

function keyboard(element, key) {
  act(() => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

for (const [mode, options, anchor, expectedLeft, expectedTop] of [
  ['grouped', {}, { left: 60, top: 118, width: 20, height: 66 }, 88, 131],
  ['stacked', { stacked: true }, { left: 260, top: 104, width: 24, height: 12 }, 148, 90],
  ['horizontal', { horizontal: true }, { left: 50, top: 163, width: 52, height: 14 }, 110, 150],
]) {
  test(`the ${mode} bar tooltip follows the hovered rectangle and stays within the plot`, () => {
    const category = '末行分类'
    const label = '中文数据系列说明，包含足够长的文字'
    const messages = [{ version: '1.0', createSurface: { surfaceId: 'bar', components: [
      { id: 'root', component: 'BarChart', categories: ['首行', category], series: [
        { label: 'Series 1', values: [100, 64] },
        { label, values: [40, 24] },
      ], valueSuffix: '万元', ...options },
    ] } }]
    const { container, unmount } = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
    const plot = query(container, '.a2ui-bar-plot')
    const bar = plot.querySelectorAll('rect').item(3)
    const measure = (left, top, width, height) => ({
      left: 150 + left * 2, top: 80 + top * 2, right: 150 + (left + width) * 2, bottom: 80 + (top + height) * 2,
      width: width * 2, height: height * 2,
    })
    Object.defineProperties(plot, { clientWidth: { value: 300 }, clientHeight: { value: 200 } })
    plot.getBoundingClientRect = () => measure(0, 0, 300, 200)
    bar.getBoundingClientRect = () => measure(anchor.left, anchor.top, anchor.width, anchor.height)
    const prototype = window.HTMLElement.prototype
    const original = prototype.getBoundingClientRect
    prototype.getBoundingClientRect = function () {
      return this.matches('.a2ui-bar-tip') ? measure(0, 0, 104, 40) : original.call(this)
    }
    try {
      act(() => bar.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
      const tip = query(plot, '[role=tooltip]')
      assert.deepEqual([...tip.children].map((line) => line.textContent), [category, `${label}: 24 万元`])
      assert.equal(tip.style.left, `${expectedLeft}px`)
      assert.equal(tip.style.top, `${expectedTop}px`)
      act(() => bar.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })))
      assert.equal(plot.querySelector('[role=tooltip]'), null)
    } finally {
      prototype.getBoundingClientRect = original
      unmount()
    }
  })
}

test('bar charts leave missing categories blank without shifting later bound values', () => {
  for (const options of [{}, { stacked: true }, { horizontal: true }]) {
    const render = (values) => {
      const messages = [{
        version: '1.0',
        createSurface: {
          surfaceId: 'bar-gaps',
          dataModel: { points: [2, null, '0', 4, 999] },
          components: [{
            id: 'root',
            component: 'BarChart',
            categories: ['Alpha', 'Beta', 'Gamma', 'Delta'],
            series: [{ label: 'Series', values }],
            ...options,
          }],
        },
      }]
      const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
      try {
        const svg = query(view.container, '.a2ui-bar-plot svg')
        const bars = [...svg.querySelectorAll('rect[rx="2"]')]
        const position = options.horizontal ? 'y' : 'x'
        const size = options.horizontal ? 'width' : 'height'
        return {
          positions: bars.map((bar) => bar.getAttribute(position)),
          sizes: bars.map((bar) => bar.getAttribute(size)),
          summary: svg.getAttribute('aria-label'),
        }
      } finally {
        view.unmount()
      }
    }
    const full = render([2, 3, 0, 4])
    assert.equal(full.positions.length, 4)
    const short = render([2, 3])
    assert.deepEqual(short.positions, full.positions.slice(0, 2))
    const bound = render({ '@path': '/points' })
    assert.deepEqual(bound.positions, [full.positions[0], full.positions[2], full.positions[3]])
    assert.equal(bound.sizes[1], '0.5', 'an actual zero still has its baseline mark')
    assert.match(bound.summary, /Total 6 \(min 0, max 4\)/u)
  }
})

test('line charts preserve category positions, gaps and zero in bound data', () => {
  const categories = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  for (const curve of ['linear', 'smooth']) {
    const messages = [{
      version: '1.0',
      createSurface: {
        surfaceId: 'line-gaps',
        dataModel: { points: [null, 1, 2, 3, null, '0', 4, null] },
        components: [{
          id: 'root',
          component: 'LineChart',
          categories,
          series: [{ label: 'Series', values: { '@path': '/points' } }],
          area: true,
          curve,
        }],
      },
    }]
    const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
    try {
      const svg = query(view.container, '.a2ui-axis')
      const labels = [...svg.querySelectorAll('text[text-anchor="middle"]')]
      assert.deepEqual(labels.map((label) => label.textContent), categories)
      const positions = labels.map((label) => Number(label.getAttribute('x')))
      const points = [...svg.querySelectorAll('circle')]
      assert.deepEqual(points.map((point) => Number(point.getAttribute('cx'))), [1, 2, 3, 5, 6].map((index) => positions[index]))

      const lines = [...svg.querySelectorAll('path[stroke-width="2"]')].map((path) => path.getAttribute('d'))
      const areas = [...svg.querySelectorAll('path[opacity="0.14"]')].map((path) => path.getAttribute('d'))
      assert.equal(lines.length, 2)
      assert.equal(areas.length, 2)
      assert.ok(lines[0].startsWith(`M${positions[1].toFixed(2)},`))
      assert.ok(lines[1].startsWith(`M${positions[5].toFixed(2)},`))
      assert.equal(lines[0].includes(' C'), curve === 'smooth')
      assert.ok(areas.every((path, index) => path.startsWith(lines[index]) && path.endsWith(' Z')))

      const bands = svg.querySelectorAll('rect[fill="transparent"]')
      act(() => bands[4].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
      assert.equal(view.container.querySelector('[role="tooltip"]'), null)
      act(() => bands[4].dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })))
      act(() => bands[5].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
      const tooltip = query(view.container, '[role="tooltip"]')
      assert.deepEqual([...tooltip.children].map((label) => label.textContent), ['F', 'Series: 0'])
      assert.equal(tooltip.style.visibility, 'visible')
    } finally {
      view.unmount()
    }
  }
})

test('function plots leave a gap at a pole on and between sampled positions', () => {
  for (const samples of [9, 240]) {
    for (const expression of ['1/x', '100*x']) {
      const block = surfaceBlock([{ version: '1.0', createSurface: {
        surfaceId: 'plot-pole',
        components: [{ id: 'root', component: 'Plot', xMin: -1, xMax: 1, samples,
          plots: [{ expression }], ...(samples === 9 && expression === '1/x' ? { yMin: -10, yMax: 10 } : {}) }],
      } }])
      const view = mount(React.createElement(View, viewProps({ block })))
      try {
        const paths = view.container.querySelectorAll('.a2ui-chart-svg path')
        assert.equal(paths.length, expression === '1/x' ? 2 : 1)
      } finally {
        view.unmount()
      }
    }
  }
})

test('bar and Pareto ticks label the values at their actual positions', () => {
  for (const [component, expected] of [
    [{ component: 'BarChart', yMin: 0, yMax: 7, categories: ['A'],
      series: [{ values: [4], errorBars: [{ lower: 2, upper: 9 }] }] }, ['0', '2', '4', '6', '7']],
    [{ component: 'ParetoChart', items: [{ label: 'A', value: 0.019 }, { label: 'B', value: 0.011 }] },
      ['0', '0.0075', '0.015', '0.0225', '0.03']],
  ]) {
    const block = surfaceBlock([{ version: '1.0', createSurface: {
      surfaceId: 'chart-ticks', components: [{ id: 'root', ...component }],
    } }])
    const view = mount(React.createElement(View, viewProps({ block })))
    try {
      const ticks = [...view.container.querySelectorAll('.a2ui-grid text')].map((tick) => tick.textContent)
      assert.deepEqual(ticks.filter((label) => !label.endsWith('%')), expected)
    } finally {
      view.unmount()
    }
  }
})

test('a table discloses truncation for both literal and bound rows and still expands', () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({ id: index + 1 }))
  for (const values of [rows, { '@path': '/rows' }, rows.slice(0, 500)]) {
    const messages = [{
      version: '1.0',
      createSurface: {
        surfaceId: 'table-limit',
        dataModel: { rows },
        components: [{ id: 'root', component: 'Table', columns: [{ key: 'id', label: 'ID' }], rows: values }],
      },
    }]
    const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
    try {
      const limited = values === rows || !Array.isArray(values)
      assert.equal(view.container.querySelectorAll('tbody tr').length, 40)
      assert.equal(view.container.textContent.includes('Only the first 500 of 501 rows'), limited)
      assert.match(query(view.container, '.a2ui-btn-borderless').textContent, limited ? /Show available rows \(500\)/u : /Show all \(500\)/u)
      click(query(view.container, '.a2ui-btn-borderless'))
      assert.equal(view.container.querySelectorAll('tbody tr').length, 500)
      assert.equal(query(view.container, 'tbody tr:last-child').textContent, '500')
    } finally {
      view.unmount()
    }
  }
})

test('FramePlayer bars scale proportionally without stretching across the card', () => {
  const messages = [{
    version: '1.0',
    createSurface: {
      surfaceId: 'player-height',
      components: [{
        id: 'root', component: 'FramePlayer', mode: 'bars',
        frames: [{ items: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }] }],
      }],
    },
  }]
  const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
  try {
    const bars = query(view.container, '.a2ui-bars')
    const marks = [...bars.querySelectorAll('.a2ui-bar')]
    assert.equal(window.getComputedStyle(bars).height, '120px')
    assert.equal(window.getComputedStyle(bars).justifyContent, 'safe center')
    assert.ok(marks.every((bar) => window.getComputedStyle(bar).maxWidth === '64px'))
    assert.deepEqual(marks.map((bar) => bar.style.height), ['50%', '100%'])
    const css = query(window.document, 'style[data-plugin="dsh-a2ui-plus"]').textContent
    const baseBar = css.match(/\.a2ui-bar\{[^}]+\}/u)?.[0] ?? ''
    assert.match(baseBar, /background:color-mix\(in srgb,var\(--dsw-alias-brand-primary/u)
  } finally {
    view.unmount()
  }
})

test('arrow keys move the selected tab and keep focus in the tab strip', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'tabs',
        components: [
          { id: 'root', component: 'Tabs', tabs: [{ title: 'One', child: 'p1' }, { title: 'Two', child: 'p2' }, { title: 'Three', child: 'p3' }] },
          { id: 'p1', component: 'Text', text: 'panel one' },
          { id: 'p2', component: 'Text', text: 'panel two' },
          { id: 'p3', component: 'Text', text: 'panel three' },
        ],
      },
    },
  ]
  const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
  const tabs = [...view.container.querySelectorAll('[role="tab"]')]
  assert.equal(tabs.length, 3)
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
  assert.equal(tabs[0].getAttribute('tabindex'), '0')
  assert.equal(tabs[1].getAttribute('tabindex'), '-1')

  keyboard(tabs[0], 'ArrowRight')
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true')
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false')
  assert.equal(window.document.activeElement, tabs[1], 'focus follows the selection')

  keyboard(tabs[1], 'End')
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true')

  keyboard(tabs[2], 'ArrowRight')
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'ArrowRight wraps to the first tab')

  keyboard(tabs[0], 'ArrowLeft')
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true', 'ArrowLeft wraps to the last tab')
  view.unmount()
})

test('a modal traps focus, closes on Escape and returns focus to its trigger', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'modal',
        components: [
          { id: 'root', component: 'Modal', trigger: 'open', content: 'body' },
          // A local `functionCall` keeps the trigger a real, enabled button: an
          // `action.event` would disable it after the send, and a disabled button
          // cannot take focus back when the dialog closes.
          {
            id: 'open',
            component: 'Button',
            child: 'openLabel',
            action: { functionCall: { '@call': 'formatString', args: { value: 'open' } } },
          },
          { id: 'openLabel', component: 'Text', text: 'Open details' },
          { id: 'body', component: 'Text', text: 'Inside the dialog' },
        ],
      },
    },
  ]
  const view = mount(React.createElement(View, viewProps({ block: surfaceBlock(messages) })))
  const trigger = query(view.container, '.a2ui-modal-trigger button')
  click(trigger)

  const dialog = query(view.container, '[role="dialog"]')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  const focusables = [...dialog.querySelectorAll('button')]
  assert.ok(focusables.length > 0)
  assert.ok(dialog.contains(window.document.activeElement), 'focus starts inside the dialog')

  keyboard(focusables[focusables.length - 1], 'Tab')
  assert.ok(dialog.contains(window.document.activeElement), 'Tab keeps focus inside the dialog')

  keyboard(dialog, 'Escape')
  assert.equal(view.container.querySelector('[role="dialog"]'), null, 'Escape closes the dialog')
  // The trigger element is re-created when the dialog closes, so focus is checked
  // against the current one rather than the reference captured before opening.
  const restored = query(view.container, '.a2ui-modal-trigger button')
  assert.equal(window.document.activeElement, restored, 'focus returns to the trigger')
  view.unmount()
})

/**
 * The generating preview must be genuinely read-only.
 *
 * jsdom does not implement `inert` semantics, so the DOM assertion is the
 * attribute React actually produced (the browser is what makes it block Tab and
 * clicks); the behavioural half is asserted separately: a click on a preview
 * button queues nothing, and the same call once settled is a normal card again.
 */
test('a failed call keeps expandable diagnostics in its process row', () => {
  const block = {
    ...surfaceBlock(formMessages()),
    isError: true,
    content: [{ type: 'text', text: '\nRejected input\r\n- /messages/0: invalid' }],
  }
  const props = viewProps({ block })
  const view = mount(React.createElement(View, props))
  try {
    const disclosure = query(view.container, 'details')
    const summary = query(disclosure, 'summary')
    assert.match(summary.textContent, /Rejected input.*Call failed/u)
    assert.doesNotMatch(summary.textContent, /\/messages\/0/u)
    assert.equal(disclosure.open, false)
    assert.equal(view.container.querySelector('.a2ui-notice-error'), null)
    assert.equal(view.container.querySelector('input'), null, 'failed results never revive their replay payload')
    click(summary)
    assert.equal(disclosure.open, true)
    assert.match(query(disclosure, 'pre').textContent, /\/messages\/0: invalid/u)

    view.render(React.createElement(View, { ...props, block: { ...block, content: [] } }))
    assert.match(query(view.container, 'pre').textContent, /This call failed/u)
  } finally {
    view.unmount()
  }
})

test('the turn tail keeps successful cards and omits failed-only containers', () => {
  const messages = [{
    version: '1.0',
    createSurface: {
      surfaceId: 'successful',
      components: [{ id: 'root', component: 'Text', text: 'Successful retry' }],
    },
  }]
  const success = surfaceBlock(messages)
  const failed = {
    ...surfaceBlock(formMessages()),
    callId: 'failed-call',
    isError: true,
    content: [{ type: 'text', text: 'Rejected input' }],
  }
  const failedNodes = new Map([['failed', nodeFor(failed, 1)]])
  const mixedNodes = new Map([...failedNodes, ['success', nodeFor(success, 1)]])
  for (const withLocations of [true, false]) {
    const props = (nodes) => {
      const result = tailProps('session-failure-tail', nodes, 1)
      if (!withLocations) result.useChat = (select) => select({ order: [...nodes.keys()], nodes })
      return result
    }
    const view = mount(React.createElement(Tail, props(mixedNodes)))
    try {
      assert.equal(view.container.querySelectorAll('.a2ui-card').length, 1)
      assert.match(view.container.textContent, /Successful retry/u)
      assert.doesNotMatch(view.container.textContent, /Rejected input|Call failed/u)

      view.render(React.createElement(Tail, props(failedNodes)))
      assert.equal(view.container.querySelector('.a2ui-tail'), null)
    } finally {
      view.unmount()
    }
  }
})

test('the generating preview body is inert and hands over to an interactive card', () => {
  const sessionId = 'session-stream-dom'
  const callId = 'call_stream_dom'
  const feed = sessionEvents()
  feeds.set(sessionId, feed)
  const components = [
    { id: 'root', component: 'Tabs', tabs: [{ title: 'One', child: 'panel' }] },
    { id: 'panel', component: 'Column', children: ['text', 'button'] },
    { id: 'text', component: 'Text', text: 'streamed text' },
    { id: 'button', component: 'Button', child: 'label', action: { event: { name: 'go' } } },
    { id: 'label', component: 'Text', text: 'Send it' },
  ]
  const messages = [{ version: '1.0', createSurface: { surfaceId: 'live', catalogId: 'dsh-a2ui/catalog/v1', components } }]
  const text = JSON.stringify({ messages })
  const cut = text.indexOf('streamed text')

  sent = []
  const preparing = mount(
    React.createElement(View, {
      callId,
      toolName: 'a2ui',
      sessionId,
      phase: 'preparing',
      block: { phase: 'preparing', callId, name: 'a2ui', subCalls: [] },
    }),
  )
  assert.equal(feed.subscriberCount(), 1)
  assert.ok(preparing.container.querySelector('.a2ui-skel'))
  act(() => feed.append(toolDelta(1, callId, text.slice(0, cut), { name: 'a2ui' })))
  assert.doesNotMatch(preparing.container.textContent, /streamed text/u)
  act(() => feed.append(toolDelta(2, callId, text.slice(cut))))
  assert.match(preparing.container.textContent, /streamed text/u)
  const body = query(preparing.container, '.a2ui-card-streaming .a2ui-card-body')
  assert.equal(body.getAttribute('inert'), '', 'the preview body carries the inert attribute')
  assert.equal(preparing.container.querySelectorAll('.a2ui-card-streaming').length, 1)
  // The content is still drawn — inert blocks input, it does not hide the card.
  assert.ok(query(preparing.container, '[role="tab"]') !== null)
  assert.equal(query(preparing.container, '.a2ui-card-title').textContent, 'Building interface…')
  assert.equal(query(preparing.container, '.a2ui-card-state').textContent, 'generating')

  // The submit path is a stub during the preview, so even a synthetic click queues
  // nothing (this is the guard that does not depend on `inert`).
  click(query(preparing.container, '.a2ui-btn'))
  assert.deepEqual(sent, [], 'a preview click must not send an action')
  act(() => feed.settle('attempt'))
  assert.doesNotMatch(preparing.container.textContent, /streamed text/u)
  act(() => feed.replace([toolDelta(3, callId, text, { name: 'a2ui', attemptId: 'retry' })]))
  assert.match(preparing.container.textContent, /streamed text/u)
  act(() => feed.replace([]))
  assert.doesNotMatch(preparing.container.textContent, /streamed text/u)

  // The same mounted card hands off to the normal interactive result.
  preparing.render(React.createElement(View, viewProps({ callId, sessionId, block: surfaceBlock(messages) })))
  assert.equal(feed.subscriberCount(), 0)
  const settled = preparing
  assert.equal(settled.container.querySelector('.a2ui-card-streaming'), null)
  const settledBody = query(settled.container, '.a2ui-card-body')
  assert.equal(settledBody.hasAttribute('inert'), false, 'the settled card is not inert')
  const tab = query(settled.container, '[role="tab"]')
  assert.equal(tab.getAttribute('tabindex'), '0', 'the settled card is back in the tab order')
  click(query(settled.container, '.a2ui-btn'))
  assert.equal(sent.length, 1, 'the settled card still sends its action')
  settled.unmount()
  feeds.delete(sessionId)
})

test('a sidebar surface renders a non-empty inline card with an open control', () => {
  // The defect this pins: a `placement: "sidebar"` call used to paint the empty
  // notice in the conversation ("this call produced no interface to display")
  // while its tab rendered fine. The card is drawn from the same store the tab
  // reads, through the mediator, so it can be neither empty nor out of date.
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'sidebar-card',
        catalogId: 'dsh-a2ui/catalog/v1',
        components: [
          { id: 'root', component: 'Column', children: ['k1', 'k2', 'k3'] },
          { id: 'k1', component: 'Stat', label: 'CPU', value: '0.55' },
          { id: 'k2', component: 'Stat', label: 'Memory', value: '8 GB' },
          { id: 'k3', component: 'Text', text: 'uptime 6h' },
        ],
        dataModel: {},
      },
    },
  ]
  const { sessionId, callId } = viewProps()
  const block = surfaceBlock(messages)
  block.meta = { kind: 'a2ui', title: 'System Status', placement: 'sidebar', messages, surfaces: [{ surfaceId: 'sidebar-card', deleted: false }] }
  const mounted = mount(React.createElement(View, viewProps({ callId, sessionId, block })))
  try {
    const card = query(mounted.container, '[data-a2ui-inline="summary"]')
    assert.ok(card !== null)
    assert.equal(mounted.container.querySelectorAll('.a2ui-stack').length, 0, 'the full graph is not painted twice')
    // The empty notice is the regression: its title string must not appear.
    assert.doesNotMatch(mounted.container.textContent, /produced no interface|만들지 않았습니다|没有产生/u)
    assert.match(mounted.container.textContent, /System Status/u, 'the card carries the surface title')
    assert.match(mounted.container.textContent, /CPU/u, 'the card carries resolved rows')
    assert.match(mounted.container.textContent, /8 GB/u)
    // Four declared components: the root plus the three children. The count is the
    // card's own proof it summarises a real surface rather than an empty one.
    assert.match(mounted.container.textContent, /4 components|컴포넌트 4개|4 个组件/u, 'the card states the component count')
    const open = query(mounted.container, '.a2ui-inline-open')
    assert.match(open.textContent, /Open in sidebar|사이드바에서 열기|在侧边栏中打开/u)
  } finally {
    mounted.unmount()
  }
})

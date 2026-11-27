/**
 * Pure client units: the action payload a click produces, DateTimeInput value
 * conversion, and the chart domain/segment helpers.
 *
 * These are the parts of the UI that can be wrong without looking wrong, so they
 * are asserted directly instead of through the DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { client } = await import('../build/shared.mjs')
const { buildAction, formatActionPrompt } = client.action
const { toControlValue, fromControlValue, dateTimeKind } = client.datetime
const { barDomain, splitPlotSegments } = client.charts

const NOW = Date.UTC(2026, 10, 13, 4, 0, 0)

function actionInput(overrides = {}) {
  return {
    surfaceId: 'study',
    component: { id: 'submit', component: 'Button' },
    name: 'generate-plan',
    contextSpec: { level: { '@path': '/level' }, hours: { '@path': '/hours' } },
    dataModel: { level: ['beginner'], hours: 6 },
    locale: 'en-US',
    now: NOW,
    ...overrides,
  }
}

test('a click produces the A2UI 1.0 action envelope', () => {
  const outcome = buildAction(actionInput())
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.action.name, 'generate-plan')
  assert.equal(outcome.action.surfaceId, 'study')
  assert.equal(outcome.action.sourceComponentId, 'submit')
  assert.equal(outcome.action.timestamp, '2026-11-13T04:00:00.000Z')
  assert.deepEqual(outcome.action.context, { level: ['beginner'], hours: 6 })
  const prompt = formatActionPrompt(outcome.action)
  assert.match(prompt, /^\[A2UI action\]/u)
  const json = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.lastIndexOf('}') + 1))
  assert.equal(json.version, '1.0')
  assert.equal(json.action.name, 'generate-plan')
})

test('a template row resolves its own item, not the surface model', () => {
  const rows = [{ name: 'one', id: 1 }, { name: 'two', id: 2 }]
  const contextSpec = { who: { '@path': 'name' }, abs: { '@path': '/label' } }
  const first = buildAction(actionInput({ contextSpec, dataModel: { rows, label: 'surface' }, item: rows[0], index: 0 }))
  const second = buildAction(actionInput({ contextSpec, dataModel: { rows, label: 'surface' }, item: rows[1], index: 1 }))
  assert.deepEqual(first.action.context, { who: 'one', abs: 'surface' })
  assert.deepEqual(second.action.context, { who: 'two', abs: 'surface' })
})

test('an edited bound value is carried, not the initial one', () => {
  const model = { level: ['advanced'], hours: 12 }
  const outcome = buildAction(actionInput({ dataModel: model }))
  assert.deepEqual(outcome.action.context, { level: ['advanced'], hours: 12 })
})

test('userMessage is forwarded and omitted when absent', () => {
  const withMessage = buildAction(actionInput({ userMessage: 'Generate a plan' }))
  assert.equal(withMessage.action.userMessage, 'Generate a plan')
  assert.match(withMessage.text, /^\[A2UI action\] Generate a plan/u)
  const without = buildAction(actionInput())
  assert.equal('userMessage' in without.action, false)
})

test('an oversized action is refused instead of sent', () => {
  const huge = { '@path': '/big' }
  const outcome = buildAction(actionInput({ contextSpec: { payload: huge }, dataModel: { big: 'x'.repeat(40_000) } }))
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.state.state, 'error')
})

/* ------------------------------------------------------------------ */
/* DateTimeInput                                                       */
/* ------------------------------------------------------------------ */

test('the control kind follows enableDate/enableTime', () => {
  assert.equal(dateTimeKind(true, false), 'date')
  assert.equal(dateTimeKind(true, true), 'datetime-local')
  assert.equal(dateTimeKind(false, false), 'time')
})

test('a bare time round-trips unchanged', () => {
  assert.equal(toControlValue('14:30', 'time'), '14:30')
  assert.equal(fromControlValue('14:30', 'time'), '14:30')
  assert.equal(toControlValue('14:30:45', 'time'), '14:30')
  assert.equal(fromControlValue('', 'time'), '')
})

test('an ISO timestamp is shown in local wall-clock time', () => {
  const iso = new Date(2026, 5, 8, 9, 15).toISOString()
  assert.equal(toControlValue(iso, 'datetime-local'), '2026-06-08T09:15')
  assert.equal(toControlValue(iso, 'time'), '09:15')
  // Round-trip through the control keeps the same instant.
  const back = fromControlValue('2026-06-08T09:15', 'datetime-local')
  assert.equal(new Date(back).getTime(), new Date(2026, 5, 8, 9, 15).getTime())
})

test('date min/max survive a round-trip and garbage degrades safely', () => {
  for (const zone of ['Asia/Shanghai', 'America/Los_Angeles']) {
    const previousZone = process.env.TZ
    try {
      process.env.TZ = zone
      const date = '2026-11-13'
      const iso = '2026-11-13T00:00:00.000Z'
      assert.equal(toControlValue(date, 'date'), date)
      assert.equal(toControlValue(iso, 'date'), date)
      const stored = fromControlValue(date, 'date')
      assert.equal(stored, iso)
      const action = buildAction(actionInput({ contextSpec: { date: { '@path': '/date' } }, dataModel: { date: stored } }))
      assert.equal(action.action.context.date, iso)
    } finally {
      if (previousZone === undefined) delete process.env.TZ
      else process.env.TZ = previousZone
    }
  }
  assert.equal(toControlValue('not a date', 'date'), '')
  assert.equal(fromControlValue('2026-13-45', 'date'), '')
  assert.equal(toControlValue('', 'date'), '')
})

/* ------------------------------------------------------------------ */
/* Chart domain and segments                                           */
/* ------------------------------------------------------------------ */

test('bar domains include the zero baseline', () => {
  assert.deepEqual(barDomain([100, 120]), { min: 0, max: undefined })
  assert.deepEqual(barDomain([-5, -9]), { min: undefined, max: 0 })
  assert.deepEqual(barDomain([-5, 9]), { min: undefined, max: undefined })
  // An explicit bound wins.
  assert.deepEqual(barDomain([1, 2], 1), { min: 1, max: undefined })
  // Degenerate all-zero data must not collapse the scale.
  assert.deepEqual(barDomain([0, 0]), { min: undefined, max: undefined })
})

test('a discontinuity splits the curve instead of connecting it', () => {
  const samples = [
    { x: -2, y: -0.5 },
    { x: -1.5, y: 5 },
    { x: 0, y: 0.5 },
  ]
  // Outside the visible domain: the middle sample is dropped and a break appears.
  const segments = splitPlotSegments(samples, -1, 1)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map((segment) => segment.length), [1, 1])
  // A continuous curve stays one segment.
  const continuous = splitPlotSegments([{ x: 0, y: 0 }, { x: 1, y: 0.5 }], -1, 1)
  assert.equal(continuous.length, 1)
  // A non-finite sample breaks as well.
  assert.equal(splitPlotSegments([{ x: 0, y: 0 }, { x: 1, y: Number.POSITIVE_INFINITY }, { x: 2, y: 0 }], -1, 1).length, 2)
})

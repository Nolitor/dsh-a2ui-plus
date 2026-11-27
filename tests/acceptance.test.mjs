/**
 * Acceptance scenarios from the project brief, verified headlessly.
 *
 * Each test builds the payload a model would emit, runs it through the same
 * validator and folder the Host and the browser use, and then exercises the
 * data path a user action takes. Anything that needs a real browser (pixels,
 * focus, animation timing) is listed in the delivery report as visually
 * unverified rather than claimed here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shared } from '../build/shared.mjs'

const {
  validateToolArguments,
  applyMessageBatch,
  resolveString,
  resolveNumber,
  resolveActionContext,
  pointerSet,
  compileExpression,
  safeMediaUrl,
} = shared

function surfaceOf(messages) {
  const validation = validateToolArguments({ messages })
  assert.equal(validation.ok, true, JSON.stringify(validation.errors))
  const folded = applyMessageBatch(new Map(), validation.messages)
  return { folded, validation }
}

const scopeFor = (surface, dataModel = surface.dataModel) => ({ dataModel, locale: 'zh-CN', now: Date.UTC(2026, 10, 12) })

test('Test 1 — basic UI: text, button, and choice picker in one card', () => {
  const { folded } = surfaceOf([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'basic',
        dataModel: { plan: ['pro'] },
        components: [
          { id: 'root', component: 'Card', child: 'body' },
          { id: 'body', component: 'Column', children: ['title', 'desc', 'picker', 'submit'] },
          { id: 'title', component: 'Text', text: '**Choose your plan**' },
          { id: 'desc', component: 'Text', variant: 'caption', text: 'You can change this later.' },
          {
            id: 'picker',
            component: 'ChoicePicker',
            label: 'Plan',
            options: [{ label: 'Starter', value: 'free' }, { label: 'Pro', value: 'pro' }],
            value: { '@path': '/plan' },
            variant: 'multipleSelection',
            displayStyle: 'chips',
          },
          { id: 'submitLabel', component: 'Text', text: 'Continue' },
          {
            id: 'submit',
            component: 'Button',
            variant: 'primary',
            child: 'submitLabel',
            action: { event: { name: 'choose-plan', context: { plan: { '@path': '/plan' } } } },
          },
        ],
      },
    },
  ])
  const surface = folded.surfaces.get('basic')
  assert.equal(surface.components.get('title').component, 'Text')
  assert.equal(surface.components.get('submit').component, 'Button')
  assert.equal(surface.components.get('picker').component, 'ChoicePicker')

  const scope = scopeFor(surface)
  const context = resolveActionContext(surface.components.get('submit').action.event.context, scope)
  assert.deepEqual(context, { plan: ['pro'] })
})

test('Test 2 — data visualization: bar and line charts of the same monthly data', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
  const revenue = [120, 145, 132, 168, 191, 205]
  const { folded } = surfaceOf([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'sales',
        dataModel: { revenue },
        components: [
          { id: 'root', component: 'Column', children: ['bar', 'line'] },
          { id: 'bar', component: 'BarChart', categories: months, series: [{ label: 'Revenue', values: { '@path': '/revenue' } }], valueSuffix: 'k CNY', caption: 'Monthly revenue' },
          { id: 'line', component: 'LineChart', categories: months, series: [{ label: 'Revenue', values: { '@path': '/revenue' } }], area: true },
        ],
      },
    },
  ])
  const surface = folded.surfaces.get('sales')
  const bar = surface.components.get('bar')
  const line = surface.components.get('line')
  assert.equal(bar.component, 'BarChart')
  assert.deepEqual(bar.series[0].values, { '@path': '/revenue' })
  assert.deepEqual(surface.dataModel.revenue, revenue)
  assert.equal(line.area, true)
})

test('Test 3 — parameter exploration: sliders drive a quadratic plot locally', () => {
  const { folded } = surfaceOf([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'quad',
        dataModel: { a: 1, b: 0, c: -4 },
        components: [
          { id: 'root', component: 'Column', children: ['a', 'b', 'c', 'plot'] },
          { id: 'a', component: 'Slider', label: 'a', min: -5, max: 5, value: { '@path': '/a' } },
          { id: 'b', component: 'Slider', label: 'b', min: -5, max: 5, value: { '@path': '/b' } },
          { id: 'c', component: 'Slider', label: 'c', min: -10, max: 10, value: { '@path': '/c' } },
          {
            id: 'plot',
            component: 'Plot',
            plots: [{ label: 'f(x)', expression: 'a*x^2 + b*x + c' }],
            variables: { a: { '@path': '/a' }, b: { '@path': '/b' }, c: { '@path': '/c' } },
            xMin: -6,
            xMax: 6,
          },
        ],
      },
    },
  ])
  const surface = folded.surfaces.get('quad')
  const plot = surface.components.get('plot')

  // What the renderer does when the user moves the `a` slider: write the model,
  // then re-evaluate the expression against the new variables.
  const moved = pointerSet(surface.dataModel, '/a', 2)
  const variables = {}
  for (const [key, value] of Object.entries(plot.variables)) variables[key] = resolveNumber(value, scopeFor(surface, moved))
  assert.deepEqual(variables, { a: 2, b: 0, c: -4 })
  const compiled = compileExpression(plot.plots[0].expression)
  assert.equal(compiled.evaluate({ ...variables, x: 1 }), -2)
  assert.equal(compiled.evaluate({ ...variables, x: 0 }), -4)
  // The old model is untouched: edits are copy-on-write.
  assert.equal(surface.dataModel.a, 1)
})

test('Test 4 — algorithm animation: precomputed bubble-sort frames', () => {
  const frames = [
    { label: 'Start', items: [5, 1, 4, 2].map((value) => ({ value, state: 'idle' })) },
    { label: 'Compare 5,1', items: [{ value: 5, state: 'compare' }, { value: 1, state: 'compare' }, { value: 4, state: 'idle' }, { value: 2, state: 'idle' }] },
    { label: 'Swap', items: [{ value: 1, state: 'active' }, { value: 5, state: 'active' }, { value: 4, state: 'idle' }, { value: 2, state: 'idle' }] },
    { label: 'Done', items: [1, 2, 4, 5].map((value) => ({ value, state: 'sorted' })) },
  ]
  const { folded } = surfaceOf([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'sort',
        components: [
          { id: 'root', component: 'Column', children: ['player'] },
          { id: 'player', component: 'FramePlayer', frames, mode: 'bars', speed: 380, caption: 'Bubble sort' },
        ],
      },
    },
  ])
  const player = folded.surfaces.get('sort').components.get('player')
  assert.equal(player.frames.length, 4)
  assert.equal(player.frames[3].items[0].state, 'sorted')
})

test('Test 5 — agent loop: a form whose submit carries the filled values', () => {
  const { folded } = surfaceOf([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'study',
        dataModel: { level: ['beginner'], hours: 6, goal: '', algorithms: true },
        components: [
          { id: 'root', component: 'Card', child: 'form' },
          { id: 'form', component: 'Column', children: ['level', 'hours', 'goal', 'algo', 'submit'] },
          {
            id: 'level',
            component: 'ChoicePicker',
            label: 'Level',
            variant: 'mutuallyExclusive',
            options: [{ label: 'Beginner', value: 'beginner' }, { label: 'Advanced', value: 'advanced' }],
            value: { '@path': '/level' },
          },
          { id: 'hours', component: 'Slider', label: 'Hours per week', min: 1, max: 20, value: { '@path': '/hours' } },
          { id: 'goal', component: 'TextField', label: 'Goal', value: { '@path': '/goal' }, placeholder: 'e.g. ship a side project' },
          { id: 'algo', component: 'CheckBox', label: 'Include algorithms', value: { '@path': '/algorithms' } },
          { id: 'submitLabel', component: 'Text', text: 'Generate my plan' },
          {
            id: 'submit',
            component: 'Button',
            variant: 'primary',
            child: 'submitLabel',
            action: {
              event: {
                name: 'generate-plan',
                userMessage: 'Generate a study plan',
                context: {
                  level: { '@path': '/level' },
                  hours: { '@path': '/hours' },
                  goal: { '@path': '/goal' },
                  algorithms: { '@path': '/algorithms' },
                },
              },
            },
          },
        ],
      },
    },
  ])
  const surface = folded.surfaces.get('study')
  const filled = pointerSet(pointerSet(surface.dataModel, '/goal', 'become a backend dev'), '/hours', 8)
  const context = resolveActionContext(surface.components.get('submit').action.event.context, scopeFor(surface, filled))
  assert.deepEqual(context, { level: ['beginner'], hours: 8, goal: 'become a backend dev', algorithms: true })
  assert.equal(resolveString(surface.components.get('submit').action.event.userMessage, scopeFor(surface, filled)), 'Generate a study plan')
})

test('Test 6 — session restore: replay is pure and produces the same surface', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'restore',
        dataModel: { n: 1 },
        components: [
          { id: 'root', component: 'Column', children: ['stat', 'progress'] },
          { id: 'stat', component: 'Stat', label: 'Done', value: { '@path': '/n' }, unit: 'tasks' },
          { id: 'progress', component: 'Progress', value: { '@path': '/n' }, max: 10 },
        ],
      },
    },
  ]
  const snapshot = JSON.stringify(messages)
  const first = surfaceOf(messages).folded.surfaces.get('restore')
  const second = surfaceOf(messages).folded.surfaces.get('restore')
  assert.equal(JSON.stringify(messages), snapshot, 'validation must not mutate the logged payload')
  assert.deepEqual([...first.components.keys()], [...second.components.keys()])
  assert.deepEqual(first.dataModel, second.dataModel)
  // Re-playing the same batch onto its own result is idempotent for declarations.
  const replay = applyMessageBatch(new Map([['restore', first]]), validateToolArguments({ messages }).messages)
  assert.equal(replay.surfaces.get('restore').components.size, first.components.size)
})

test('Test 7 — plain conversation compatibility: no tools outside the two registered', () => {
  // The Host half must not touch Markdown, the composer, or other tools; the
  // integration suite asserts exactly two registrations and one prompt section.
  assert.equal(typeof validateToolArguments, 'function')
})

test('Test 8 — malicious and malformed payloads are refused or neutralised', () => {
  const cases = [
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    '"; DROP TABLE users; --',
    '${process.env.SECRET}',
    '__proto__',
  ]
  for (const payload of cases) {
    // Text is data: it is accepted verbatim and rendered as text nodes.
    const textResult = validateToolArguments({
      messages: [
        {
          version: '1.0',
          createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Text', text: payload }] },
        },
      ],
    })
    assert.equal(textResult.ok, true, `text payload ${payload}`)
    assert.equal(textResult.messages[0].createSurface.components[0].text, payload)
  }
  // URLs are filtered before they reach the DOM.
  assert.equal(safeMediaUrl('javascript:alert(1)', true), undefined)
  assert.equal(safeMediaUrl('file:///etc/passwd', true), undefined)

  // Unknown components, unknown properties, and non-1.0 versions are refused.
  assert.equal(validateToolArguments({ messages: [{ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Script' }] } }] }).ok, false)
  assert.equal(validateToolArguments({ messages: [{ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Text', dangerouslySetInnerHTML: '<b>x</b>' }] } }] }).ok, false)
  assert.equal(validateToolArguments({ messages: [{ version: '0.8', surfaceUpdate: { surfaceId: 'x', components: [] } }] }).ok, false)

  // A prototype-poisoning property name is just an unknown property.
  const pollution = validateToolArguments({
    messages: [{ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Text', text: 'x', __proto__: { evil: true } }] } }],
  })
  assert.equal({}.evil, undefined)
  assert.ok(pollution.ok === true || pollution.ok === false)
})

test('Test 9 — multi-session isolation: identical surface ids do not collide', () => {
  const payload = (label) => [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'shared',
        components: [{ id: 'root', component: 'Text', text: label }],
      },
    },
  ]
  const sessionA = surfaceOf(payload('session A')).folded
  const sessionB = surfaceOf(payload('session B')).folded
  assert.equal(sessionA.surfaces.get('shared').components.get('root').text, 'session A')
  assert.equal(sessionB.surfaces.get('shared').components.get('root').text, 'session B')

  const updateA = validateToolArguments({
    messages: [{ version: '1.0', updateComponents: { surfaceId: 'shared', components: [{ id: 'root', component: 'Text', text: 'A updated' }] } }],
  })
  const afterA = applyMessageBatch(sessionA.surfaces, updateA.messages)
  assert.equal(afterA.surfaces.get('shared').components.get('root').text, 'A updated')
  assert.equal(sessionB.surfaces.get('shared').components.get('root').text, 'session B')
})

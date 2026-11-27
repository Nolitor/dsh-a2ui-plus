/**
 * Unit tests for the shared primitives: JSON pointers, data binding, catalog
 * functions, the safe expression language, and one valid sample per component.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shared } from '../build/shared.mjs'
import { fitLinearRegression, visibleRegressionSegment } from '../lib/shared/plot-data.js'

test('linear regression fits original points and clips to both displayed axes', () => {
  const fit = fitLinearRegression([{ x: 0, y: 8 }, { x: 1, y: 6 }, { x: 4, y: 0 }])
  assert.ok(Math.abs(fit.rSquared - 1) < 1e-12)
  assert.deepEqual(visibleRegressionSegment(fit, { xMin: 1, xMax: 3, yMin: 3, yMax: 5 }), [
    { x: 1.5, y: 5 }, { x: 2.5, y: 3 },
  ])
  const noisy = fitLinearRegression([{ x: 0, y: 0, size: 100 }, { x: 1, y: 2 }, { x: 2, y: 1 }])
  assert.equal(noisy.rSquared, 0.25)
  assert.equal(fitLinearRegression([{ x: 2, y: 1 }, { x: 2, y: 4 }]), undefined)
  const flat = fitLinearRegression([{ x: 1, y: 3 }, { x: 2, y: 3 }])
  assert.equal(flat.rSquared, undefined)
  assert.deepEqual(visibleRegressionSegment(flat, { xMin: 0, xMax: 5, yMin: 0, yMax: 5 }), [
    { x: 1, y: 3 }, { x: 2, y: 3 },
  ])
  const extreme = fitLinearRegression([{ x: -1e308, y: -1e308 }, { x: 0, y: 0 }, { x: 1e308, y: 1e308 }])
  assert.equal(extreme.rSquared, 1)
  const segment = visibleRegressionSegment(extreme, { xMin: -1e308, xMax: 1e308, yMin: -5e307, yMax: 5e307 })
  assert.ok(segment.every(({ x, y }) => Number.isFinite(x) && x === y))
  assert.equal(visibleRegressionSegment(extreme, { xMin: 0, xMax: 1e308, yMin: -1e308, yMax: -1 }), undefined)
})

const {
  pointerGet,
  pointerSet,
  resolveString,
  resolveNumber,
  resolveBoolean,
  resolveStringList,
  resolveNumberList,
  resolveValue,
  resolveActionContext,
  expandTemplate,
  FUNCTIONS,
  compileExpression,
  tryCompileExpression,
  COMPONENTS,
  COMPONENT_BY_NAME,
  COMPONENT_NAMES,
  describeCatalog,
  BASIC_FUNCTION_NAMES,
  knownFunctions,
  validateToolArguments,
  foldStreaming,
  BASIC_CATALOG_ID,
  EXTENSION_CATALOG_ID,
} = shared

const ctx = (dataModel, item, index) => ({ dataModel, item, index, locale: 'en-US', now: Date.UTC(2026, 5, 8, 12, 0, 0) })

test('JSON pointers read nested objects and arrays, and report missing paths', () => {
  const model = { a: { b: [10, 20] }, n: null, s: 'x', 'k/1': true }
  assert.deepEqual(pointerGet(model, '/a/b/1'), { found: true, value: 20 })
  assert.deepEqual(pointerGet(model, '/n'), { found: true, value: null })
  assert.deepEqual(pointerGet(model, '/missing'), { found: false, value: undefined })
  assert.deepEqual(pointerGet(model, '/a/b/5'), { found: false, value: undefined })
  assert.deepEqual(pointerGet(model, '/k~11'), { found: true, value: true })
})

test('JSON pointer writes copy-on-write, create missing objects, and delete on null', () => {
  const model = { a: { b: 1 }, list: [1, 2] }
  const next = pointerSet(model, '/a/c', 2)
  assert.deepEqual(next, { a: { b: 1, c: 2 }, list: [1, 2] })
  assert.equal(model.a.c, undefined, 'the input model must not be mutated')
  const replaced = pointerSet(model, '/list/0', 9)
  assert.deepEqual(replaced.list, [9, 2])
  const added = pointerSet(model, '/deep/new/key', 'v')
  assert.equal(added.deep.new.key, 'v')
  const removed = pointerSet(model, '/a/b', null)
  assert.equal('b' in removed.a, false)
})

test('dynamic values resolve literals, bindings, and calls', () => {
  const scope = ctx({ user: { name: 'Ada' }, total: 1200.5, flags: { ok: true }, list: ['a', 'b'], nums: [1, 2, 3] })
  assert.equal(resolveString('literal', scope), 'literal')
  assert.equal(resolveString({ '@path': '/user/name' }, scope), 'Ada')
  assert.equal(resolveString({ path: '/user/name' }, scope), 'Ada')
  assert.equal(resolveNumber({ '@path': '/total' }, scope), 1200.5)
  assert.equal(resolveBoolean({ '@path': '/flags/ok' }, scope), true)
  assert.deepEqual(resolveStringList({ '@path': '/list' }, scope), ['a', 'b'])
  assert.deepEqual(resolveNumberList({ '@path': '/nums' }, scope), [1, 2, 3])
  assert.equal(resolveString({ '@path': '/missing/deep' }, scope), '')
  assert.equal(resolveValue({ '@call': 'formatNumber', args: { value: { '@path': '/total' }, decimals: 1 } }, scope), '1,200.5')
})

test('relative bindings resolve against a template item first', () => {
  const scope = ctx({ items: [{ name: 'one' }], name: 'outer' }, { name: 'item' }, 0)
  assert.equal(resolveString({ '@path': 'name' }, scope), 'item')
  assert.equal(resolveString({ '@path': '/name' }, scope), 'outer')
  assert.equal(resolveString({ '@path': 'missing' }, scope), 'outer' in {} ? '' : '')
})

test('template expansion bounds the item count', () => {
  const scope = ctx({ items: Array.from({ length: 10 }, (_, index) => ({ index })) })
  const items = expandTemplate('row', '/items', scope, 4)
  assert.equal(items.length, 4)
  assert.equal(items[2].index, 2)
  assert.equal(expandTemplate('row', '/missing', scope, 4).length, 0)
})

test('formatString interpolates paths, literals, and nested calls', () => {
  const scope = ctx({ user: { name: 'Ada' }, total: 1200 })
  // Go through `resolveValue`, which is how the renderer and the action-context
  // resolver reach the function (it supplies the evaluation environment).
  const format = (template) => resolveString({ '@call': 'formatString', args: { value: template } }, scope)
  assert.equal(format('Hello ${/user/name}!'), 'Hello Ada!')
  assert.equal(format('Total: ${formatNumber(value:/total, decimals:0)}'), 'Total: 1,200')
  assert.equal(format('${1}'), '1')
  assert.equal(format("cost: ${'x'}"), 'cost: x')
  assert.equal(format('no placeholders'), 'no placeholders')
  // A malformed or unknown expression must not throw and must not leak internals.
  assert.equal(format('${unknownFn(a:1)}'), '')
  assert.equal(format('${'), '${')
})

test('number, currency, date, and plural formatting follow the locale', () => {
  const scope = ctx({})
  assert.equal(FUNCTIONS.formatNumber({ value: 1234.567, decimals: 2 }, scope), '1,234.57')
  assert.equal(FUNCTIONS.formatNumber({ value: 1234, grouping: false }, scope), '1234')
  assert.equal(FUNCTIONS.formatCurrency({ value: 10, currency: 'USD' }, scope), '$10.00')
  assert.equal(FUNCTIONS.formatCurrency({ value: 10, currency: 'nope' }, scope), '')
  assert.equal(FUNCTIONS.formatDate({ value: '2026-06-08T12:00:00Z', format: 'yyyy-MM-dd' }, { ...scope, locale: 'en-US' }), '2026-06-08')
  assert.equal(FUNCTIONS.pluralize({ value: 1, one: 'item', other: 'items' }, scope), 'item')
  assert.equal(FUNCTIONS.pluralize({ value: 5, one: 'item', other: 'items' }, scope), 'items')
})

test('validation functions return structured results', () => {
  const scope = ctx({})
  assert.deepEqual(FUNCTIONS.required({ value: '' }, scope), { valid: false })
  assert.deepEqual(FUNCTIONS.required({ value: 'x' }, scope), { valid: true })
  assert.equal(FUNCTIONS.regex({ value: 'abc', pattern: '^a' }, scope).valid, true)
  assert.equal(FUNCTIONS.regex({ value: 'abc', pattern: '(' }, scope).valid, false)
  assert.equal(FUNCTIONS.length({ value: 'abc', min: 4 }, scope).valid, false)
  assert.equal(FUNCTIONS.numeric({ value: 5, min: 1, max: 10 }, scope).valid, true)
  assert.equal(FUNCTIONS.email({ value: 'a@b.co' }, scope).valid, true)
  assert.equal(FUNCTIONS.email({ value: 'a@b' }, scope).valid, false)
  assert.equal(FUNCTIONS.and({ values: [{ valid: true }, { valid: true }] }, scope), true)
  assert.equal(FUNCTIONS.or({ values: [{ valid: false }, { valid: true }] }, scope), true)
  assert.equal(FUNCTIONS.not({ value: { valid: true } }, scope), false)
  assert.equal(FUNCTIONS['@index']({ offset: 2 }, { ...scope, index: 3 }), 5)
})

test('action context resolution keeps only resolvable values', () => {
  const scope = ctx({ form: { name: 'Ada', age: 36, missing: undefined } })
  const context = resolveActionContext(
    { name: { '@path': '/form/name' }, age: { '@path': '/form/age' }, literal: 7, gone: { '@path': '/form/missing' } },
    scope,
  )
  assert.deepEqual(context, { name: 'Ada', age: 36, literal: 7 })
})

test('expression language evaluates arithmetic and functions', () => {
  const quadratic = compileExpression('a*x^2 + b*x + c')
  assert.deepEqual([...quadratic.variables].sort(), ['a', 'b', 'c'])
  assert.equal(quadratic.evaluate({ x: 2, a: 1, b: 0, c: -4 }), 0)
  assert.equal(quadratic.evaluate({ x: 0, a: 1, b: 2, c: 3 }), 3)
  assert.equal(compileExpression('sin(x) + cos(x)').evaluate({ x: 0 }), 1)
  assert.equal(compileExpression('2^3^2').evaluate({}), 512)
  assert.equal(compileExpression('-x + 1').evaluate({ x: 2 }), -1)
  assert.equal(compileExpression('pi').evaluate({}), Math.PI)
  assert.equal(compileExpression('max(1, x)').evaluate({ x: 5 }), 5)
})

test('expression language rejects anything outside the closed grammar', () => {
  assert.equal(tryCompileExpression('window.location'), undefined)
  assert.equal(tryCompileExpression('x.constructor'), undefined)
  assert.equal(tryCompileExpression('alert(1)'), undefined)
  assert.equal(tryCompileExpression('this'), undefined)
  assert.equal(tryCompileExpression('x[0]'), undefined)
  assert.equal(tryCompileExpression('x; y'), undefined)
  assert.equal(tryCompileExpression('x'.repeat(400)), undefined)
  assert.throws(() => compileExpression('foo('), /unexpected|ends/u)
})

test('every catalog component validates with a minimal sample', () => {
  const samples = {
    Text: { text: 'hi' },
    Image: { url: 'https://example.com/a.png' },
    Icon: { name: 'check' },
    Video: { url: 'https://example.com/a.mp4' },
    AudioPlayer: { url: 'https://example.com/a.mp3' },
    Row: { children: ['root'] },
    Column: { children: ['root'] },
    List: { children: ['root'] },
    Card: { child: 'root' },
    Tabs: { tabs: [{ title: 'One', child: 'root' }] },
    Modal: { trigger: 'root', content: 'root' },
    Divider: {},
    Button: { child: 'root', action: { event: { name: 'go' } } },
    TextField: { label: 'Name' },
    CheckBox: { label: 'Agree', value: true },
    ChoicePicker: { options: [{ label: 'A', value: 'a' }], value: ['a'] },
    Slider: { label: 'Amount', min: 0, max: 10, value: 5 },
    DateTimeInput: { value: '', enableDate: true },
    Table: { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] },
    BarChart: { categories: ['Q1'], series: [{ label: 'S', values: [1] }] },
    ParetoChart: { items: [{ label: 'A', value: 1 }] },
    RadarChart: { axes: ['Speed', 'Quality', 'Stability'], series: [{ values: [80, 90, 70] }] },
    LineChart: { categories: ['Q1'], series: [{ label: 'S', values: [1] }] },
    PieChart: { slices: [{ label: 'A', value: 1 }] },
    Stat: { label: 'Revenue', value: 100 },
    Progress: { value: 40 },
    Plot: { plots: [{ expression: 'x^2' }], xMin: -1, xMax: 1 },
    Section: { title: 'Details', children: ['leaf'] },
    Heatmap: { rowLabels: ['Row'], columnLabels: ['Column'], values: [[0]] },
    Timeline: { events: [{ when: 'Today', title: 'Release' }] },
    FramePlayer: { frames: [{ items: [{ value: 1 }] }] },
  }
  assert.deepEqual(Object.keys(samples).sort(), [...COMPONENT_NAMES].sort(), 'a sample exists for every component')
  const leaf = { id: 'leaf', component: 'Text', text: 'leaf' }
  for (const name of COMPONENT_NAMES) {
    const catalogId = COMPONENT_BY_NAME.get(name).origin === 'basic' ? BASIC_CATALOG_ID : EXTENSION_CATALOG_ID
    const sample = { ...samples[name] }
    // Child references point at a sibling, never at the root itself.
    for (const key of ['child', 'trigger', 'content']) if (sample[key] === 'root') sample[key] = 'leaf'
    if (Array.isArray(sample.children)) sample.children = sample.children.map((id) => (id === 'root' ? 'leaf' : id))
    if (Array.isArray(sample.tabs)) sample.tabs = sample.tabs.map((tab) => ({ ...tab, child: tab.child === 'root' ? 'leaf' : tab.child }))
    const result = validateToolArguments({
      messages: [
        {
          version: '1.0',
          createSurface: {
            surfaceId: 's',
            catalogId,
            components: [{ id: 'root', component: name, ...sample }, leaf],
          },
        },
      ],
    })
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`)
  }
})

test('the model-facing catalog reference lists every component and function', () => {
  const brief = describeCatalog('brief')
  const full = describeCatalog('full')
  assert.match(brief, /Default catalogId: dsh-a2ui\/catalog\/v1/u)
  for (const name of COMPONENT_NAMES) {
    assert.ok(brief.includes(name), `brief mention of ${name}`)
    assert.ok(full.includes(name), `full mention of ${name}`)
  }
  for (const name of BASIC_FUNCTION_NAMES) assert.ok(full.includes(name), `function ${name}`)
  assert.ok(full.length > brief.length)
  assert.ok(full.length < 8_000, 'the reference must stay small enough to be worth a round trip')
})

test('Row and Column normalize the CSS justify spellings for final and streamed cards', () => {
  const spellings = [
    ['space-around', 'spaceAround'],
    ['space-between', 'spaceBetween'],
    ['space-evenly', 'spaceEvenly'],
  ]
  for (const component of ['Row', 'Column']) {
    for (const [alias, canonical] of spellings) {
      const args = { messages: [{
        version: '1.0',
        createSurface: {
          surfaceId: 'layout',
          catalogId: BASIC_CATALOG_ID,
          components: [
            { id: 'root', component, children: ['text'], justify: alias },
            { id: 'text', component: 'Text', text: 'Example' },
          ],
        },
      }] }
      const result = validateToolArguments(args)
      assert.equal(result.ok, true, JSON.stringify(result.errors))
      assert.equal(result.states.get('layout').components.get('root').justify, canonical)
      assert.equal(args.messages[0].createSurface.components[0].justify, alias)
      const streamed = foldStreaming(JSON.stringify(args).slice(0, -1))
      assert.equal(streamed.surfaces[0].components.get('root').justify, canonical)
    }
  }
})

test('obsolete Text usage hints remain invalid and explain the replacement', () => {
  const result = validateToolArguments({ messages: [{
    version: '1.0',
    createSurface: {
      surfaceId: 'text',
      components: [{ id: 'root', component: 'Text', text: 'Example', usageHint: 'h2' }],
    },
  }] })
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].path, /\/usageHint$/u)
  assert.match(result.errors[0].message, /Use "variant" with "body" or "caption"/u)
})

test('the catalog examples validate and the reference explains renderer limits', () => {
  const full = describeCatalog('full')
  const brief = describeCatalog('brief')
  assert.match(full, /"weight" lets siblings share available space/u)
  assert.match(full, /spaceBetween/u)
  assert.match(brief, /first 500 rows/u)
  assert.match(brief, /one value per category/u)
  for (const name of ['Text', 'Table', 'Weighted Row']) {
    const line = full.split('\n').find((line) => line.startsWith(`  ${name}: `))
    assert.ok(line, `${name} example is listed`)
    const example = JSON.parse(line.slice(line.indexOf(': ') + 2))
    const components = Array.isArray(example) ? example : [example]
    const result = validateToolArguments({ messages: [{ version: '1.0', createSurface: { surfaceId: 'example', components } }] })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
  }
})

test('every catalog function is registered as known', () => {
  for (const name of BASIC_FUNCTION_NAMES) assert.ok(knownFunctions.has(name), name)
  assert.equal(COMPONENTS.length, 31)
})

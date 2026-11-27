/**
 * §2 resource-boundary regressions.
 *
 * These pin the cheap-rejection paths: a payload must be refused (or degraded)
 * *before* a large array or React tree is built, and the error has to be
 * locatable. Each case also asserts it completes quickly, which is the property
 * that actually protects the UI.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shared } from '../build/shared.mjs'

const {
  validateToolArguments,
  applyMessageBatch,
  estimateExpansion,
  pointerGet,
  pointerSet,
  pointerWrite,
  pointerViolation,
  resolveString,
  FUNCTIONS,
  LIMITS,
  MAX_ARRAY_INDEX,
  MAX_POINTER_SEGMENTS,
  regexUnsafeReason,
  isSafeRegexPattern,
} = shared

const v = (messages) => validateToolArguments({ messages })

function timed(fn) {
  const started = performance.now()
  const value = fn()
  return { value, ms: performance.now() - started }
}

/* ------------------------------------------------------------------ */
/* Regex admission                                                     */
/* ------------------------------------------------------------------ */

test('catastrophic regex patterns are refused before execution', () => {
  const { value, ms } = timed(() => {
    // The classic ReDoS shape, with an input designed to blow up a backtracking engine.
    assert.equal(FUNCTIONS.regex({ value: `${'a'.repeat(32)}!`, pattern: '^(a+)+$' }, { locale: 'en-US', now: 0 }).valid, false)
    return true
  })
  assert.equal(value, true)
  assert.ok(ms < 500, `regex evaluation took ${ms.toFixed(1)} ms`)

  for (const pattern of ['^(a+)+$', '(a*)*b', '(a|aa)+$', '(x+){2,}']) {
    assert.ok(regexUnsafeReason(pattern) !== undefined, `expected refusal for ${pattern}`)
    assert.equal(isSafeRegexPattern(pattern), false)
  }
  // Simple, linear patterns still work.
  for (const pattern of ['^[^@]+@[^@]+\\.[^@]+$', '^\\d{3}-\\d{4}$', 'abc']) {
    assert.equal(isSafeRegexPattern(pattern), true, pattern)
  }
  assert.deepEqual(FUNCTIONS.regex({ value: 'a@b.co', pattern: '^[^@]+@[^@]+\\.[^@]+$' }, { locale: 'en-US', now: 0 }), { valid: true })
})

test('a literal unsafe regex pattern is rejected at validation time with its path', () => {
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'f',
        components: [
          { id: 'root', component: 'TextField', label: 'Email', checks: [{ condition: { '@call': 'regex', args: { value: { '@path': '/email' }, pattern: '^(a+)+$' } } }] },
        ],
      },
    },
  ])
  assert.equal(result.ok, false)
  assert.match(result.errors[0].path, /checks\/0\/condition\/args\/pattern/u)
})

test('an over-long regex input is refused', () => {
  assert.equal(FUNCTIONS.regex({ value: 'x'.repeat(5_000), pattern: '^x+$' }, { locale: 'en-US', now: 0 }).valid, false)
})

/* ------------------------------------------------------------------ */
/* Expansion budget                                                    */
/* ------------------------------------------------------------------ */

test('7 definitions reused 6x per level are rejected cheaply', () => {
  // Seven definitions, six reuses per level through absolute templates: a tiny
  // payload that expands to 6^6 = 46,656 leaves, far beyond the node budget.
  const components = []
  for (let level = 1; level <= 6; level += 1) {
    const next = level === 6 ? null : `l${level + 1}`
    components.push(
      next === null
        ? { id: 'l6', component: 'Text', text: { '@path': 'a' } }
        : { id: `l${level}`, component: 'Column', children: { componentId: next, path: '/six' } },
    )
  }
  components.unshift({ id: 'root', component: 'Column', children: { componentId: 'l1', path: '/six' } })
  const { value, ms } = timed(() =>
    v([
      {
        version: '1.0',
        createSurface: { surfaceId: 'huge', dataModel: { six: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }, { a: 6 }] }, components },
      },
    ]),
  )
  assert.equal(value.ok, false)
  assert.match(value.errors.map((error) => error.message).join('\n'), /expands to more than \d+ rendered components/u)
  assert.ok(ms < 2_000, `rejection took ${ms.toFixed(1)} ms`)
})

test('a template bound to a long list is rejected before expansion', () => {
  const items = Array.from({ length: 5_000 }, (_, index) => ({ name: `row ${index}` }))
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'rows',
        dataModel: { items },
        components: [
          { id: 'root', component: 'Column', children: { componentId: 'row', path: '/items' } },
          { id: 'row', component: 'Text', text: { '@path': 'name' } },
        ],
      },
    },
  ])
  assert.equal(result.ok, false)
  assert.match(result.errors.map((error) => error.message).join('\n'), /expands to more than/u)
})

test('a chart bound to a huge series is rejected by the data-unit budget', () => {
  const values = Array.from({ length: 6_000 }, (_, index) => index)
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'chart',
        dataModel: { values },
        components: [
          { id: 'root', component: 'LineChart', categories: ['a'], series: [{ label: 'S', values: { '@path': '/values' } }] },
        ],
      },
    },
  ])
  assert.equal(result.ok, false)
  assert.match(result.errors.map((error) => error.message).join('\n'), /data rows, points or animation items/u)
})

test('a normal nested template stays inside the budget', () => {
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'ok',
        dataModel: { groups: [{ title: 'A', items: ['a1', 'a2'] }, { title: 'B', items: ['b1'] }] },
        components: [
          { id: 'root', component: 'Column', children: { componentId: 'group', path: '/groups' } },
          { id: 'group', component: 'Card', child: 'inner' },
          { id: 'inner', component: 'Column', children: ['title', 'items'] },
          { id: 'title', component: 'Text', text: { '@path': 'title' } },
          { id: 'items', component: 'Column', children: { componentId: 'item', path: 'items' } },
          { id: 'item', component: 'Text', text: { '@path': '' } },
        ],
      },
    },
  ])
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  const state = result.states.get('ok')
  const estimate = estimateExpansion(state)
  assert.equal(estimate.reason, undefined)
  assert.ok(estimate.nodes >= 6 && estimate.nodes <= 40, `nodes=${estimate.nodes}`)
})

test('the estimator reports node and data-unit counts for a normal card', () => {
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'n',
        dataModel: { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] },
        components: [
          { id: 'root', component: 'Column', children: ['t', 'table'] },
          { id: 't', component: 'Text', text: 'x' },
          { id: 'table', component: 'Table', columns: [{ key: 'a', label: 'A' }], rows: { '@path': '/rows' } },
        ],
      },
    },
  ])
  const estimate = estimateExpansion(result.states.get('n'))
  assert.equal(estimate.reason, undefined)
  assert.equal(estimate.nodes, 3)
  assert.equal(estimate.dataUnits, 3)
})

/* ------------------------------------------------------------------ */
/* JSON Pointer constraints                                            */
/* ------------------------------------------------------------------ */

test('over-large array indices and over-deep pointers are refused', () => {
  assert.match(String(pointerViolation('/values/4294967294')), /array index/u)
  assert.equal(pointerGet({ values: [1] }, '/values/4294967294').found, false)

  const deep = `/${Array.from({ length: MAX_POINTER_SEGMENTS + 1 }, () => 'a').join('/')}`
  assert.match(String(pointerViolation(deep)), /more than/u)

  const long = `/${'a'.repeat(2_000)}`
  assert.match(String(pointerViolation(long)), /longer than/u)

  assert.match(String(pointerViolation('/__proto__/x')), /must not address/u)
  assert.equal(pointerViolation('/ok/1'), undefined)
})

test('a sparse array write is refused and leaves the model unchanged', () => {
  const model = { values: [1, 2] }
  assert.equal(pointerSet(model, '/values/10', 9), model, 'the same reference comes back')
  assert.deepEqual(model, { values: [1, 2] })
  assert.equal(pointerSet(model, '/values/4294967294', 9), model)
})

test('appending at the end and the "-" token work; null deletes', () => {
  const model = { values: [1, 2], keep: true }
  assert.deepEqual(pointerSet(model, '/values/2', 3), { values: [1, 2, 3], keep: true })
  assert.deepEqual(pointerSet(model, '/values/-', 4), { values: [1, 2, 4], keep: true })
  const deleted = pointerSet(model, '/values/0', null)
  assert.deepEqual(deleted.values, [2])
  const removed = pointerSet(deleted, '/keep', null)
  assert.equal('keep' in removed, false)
})

test('an invalid pointer in updateDataModel is reported at its field', () => {
  const result = v([{ version: '1.0', updateDataModel: { surfaceId: 's', path: '/values/4294967294', value: 1 } }])
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].path, '/messages/0/updateDataModel/path')
  assert.match(result.errors[0].message, /array index/u)
})

test('a refused data update does not change the folded model', () => {
  const first = v([
    { version: '1.0', createSurface: { surfaceId: 's', dataModel: { values: [1, 2] }, components: [{ id: 'root', component: 'Text', text: { '@path': '/values/0' } }] } },
  ])
  const folded = applyMessageBatch(new Map(), first.messages)
  const snapshot = JSON.stringify(folded.surfaces.get('s').dataModel)
  // A pointer the validator would refuse never reaches the fold; a direct call
  // to the copy-on-write writer must also leave the model untouched.
  const after = pointerSet(folded.surfaces.get('s').dataModel, '/values/10', 7)
  assert.equal(JSON.stringify(after), snapshot)
})

test('resolving a binding through a refused pointer degrades to empty text', () => {
  assert.equal(resolveString({ '@path': '/values/4294967294' }, { dataModel: { values: [1] }, locale: 'en-US', now: 0 }), '')
})

test('the limits are exported so the client and Host share them', () => {
  assert.ok(LIMITS.maxExpandedNodes > 0)
  assert.ok(LIMITS.maxExpandedDataUnits > 0)
  assert.equal(MAX_ARRAY_INDEX, 10_000)
})

/* ------------------------------------------------------------------ */
/* 复验返修：正则安全子集的官方规则                                      */
/* ------------------------------------------------------------------ */

test('the official safety rules accept and reject the documented examples', () => {
  // Spec §"regex examples": accepted.
  for (const pattern of ['^[a-z]+@[a-z]+\\.com$', '^(?=.*\\d).{8,}$', '\\w+\\s+\\w+']) {
    assert.equal(regexUnsafeReason(pattern), undefined, `expected ${pattern} to be accepted`)
  }
  // Rejected: rule 2, rule 3, rule 4, backreference.
  assert.match(String(regexUnsafeReason('(a+)+$')), /unbounded repetition/u)
  assert.match(String(regexUnsafeReason('(a|ab)*c')), /alternatives/u)
  assert.match(String(regexUnsafeReason('\\d+\\s*\\d+')), /adjacent unbounded/u)
  assert.match(String(regexUnsafeReason('(\\w)\\1')), /backreferences/u)
  // Bounded repeats over a single atom stay usable (regression from the review).
  assert.equal(regexUnsafeReason('(?:ab){2}'), undefined)
  assert.equal(regexUnsafeReason('([A-Z]){2}'), undefined)
  // Adjacent overlapping unbounded quantifiers (the reported hole).
  assert.match(String(regexUnsafeReason(`^${'a*'.repeat(12)}$`)), /adjacent unbounded/u)
  assert.match(String(regexUnsafeReason('^a+a+$')), /adjacent unbounded/u)
  // Dialect limits.
  assert.match(String(regexUnsafeReason('(?<=a)b')), /lookbehind/u)
  assert.match(String(regexUnsafeReason('\\p{L}')), /character properties/u)
  assert.match(String(regexUnsafeReason('a'.repeat(257))), /256/u)
})

test('a rejected pattern never reaches the engine', () => {
  const started = performance.now()
  const result = FUNCTIONS.regex({ value: `${'a'.repeat(32)}!`, pattern: '^(a+)+$' }, { locale: 'en-US', now: 0 })
  const elapsed = performance.now() - started
  assert.equal(result.valid, false)
  assert.ok(elapsed < 100, `rejection took ${elapsed.toFixed(1)} ms`)
  // The adjacent-quantifier shape the review reported.
  const second = performance.now()
  assert.equal(FUNCTIONS.regex({ value: `${'a'.repeat(32)}!`, pattern: `^${'a*'.repeat(12)}$` }, { locale: 'en-US', now: 0 }).valid, false)
  assert.ok(performance.now() - second < 100)
})

test('a dynamic (bound) unsafe pattern is refused at evaluation time', () => {
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'dyn',
        dataModel: { pattern: '^(a+)+$' },
        components: [
          {
            id: 'root',
            component: 'TextField',
            label: 'Value',
            checks: [{ condition: { '@call': 'regex', args: { value: { '@path': '/value' }, pattern: { '@path': '/pattern' } } } }],
          },
        ],
      },
    },
  ])
  assert.equal(result.ok, true, 'a bound pattern cannot be judged statically')
  const outcome = FUNCTIONS.regex({ value: `${'a'.repeat(32)}!`, pattern: '^(a+)+$' }, { locale: 'en-US', now: 0 })
  assert.equal(outcome.valid, false)
})

test('an isolated process rejects hostile patterns within its timeout', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const repetitions = 'a*'.repeat(12)
  const attacks = [
    ['^(a+)+$', `${'a'.repeat(32)}!`],
    [`^(?:${repetitions})$`, `${'a'.repeat(32)}!`],
    [`^(?=${repetitions}$)`, `${'a'.repeat(32)}!`],
    ['^(?:a|aa){1,60}$', `${'a'.repeat(45)}!`],
    ['^(?:b?a|a)+$', `${'a'.repeat(32)}!`],
    // Separate overlapping repeats with a mandatory atom that also matches "a".
    [`^${'a*a'.repeat(12)}$`, `${'a'.repeat(48)}!`],
  ]
  const script = `
    const { shared } = await import(${JSON.stringify(new URL('../build/shared.mjs', import.meta.url).href)})
    const results = ${JSON.stringify(attacks)}.map(([pattern, value]) =>
      shared.FUNCTIONS.regex({ pattern, value }, { locale: 'en-US', now: 0 }))
    process.stdout.write(JSON.stringify(results))
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 3_000, encoding: 'utf8' })
  if (child.error?.code === 'EPERM') {
    t.skip('the sandbox does not allow child processes')
    return
  }
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  const parsed = JSON.parse(child.stdout)
  assert.deepEqual(parsed.map((result) => result.valid), attacks.map(() => false))
  assert.match(parsed.at(-1).message, /match work limit/u)
})

test('regex keeps the existing matching semantics for regular validation patterns', () => {
  const cases = [
    ['(?:ab){2}', 'zabab', 'aba'],
    ['([A-Z]){2}', 'ZAB', 'ZaB'],
    ['^(?=.*\\d).{8,}$', 'pass1234', 'password'],
    ['^(?!admin)[a-z]+$', 'alice', 'admin'],
    ['^(?:b?a|c)+$', 'abaac', 'xyz'],
    ['^😀{2}$', '😀😀', '😀'],
    ['^\\d{4}$', '1234', '01234'],
    ['\\bhello\\b', 'say hello!', 'shelloworld'],
  ]
  for (const [pattern, matching, failing] of cases) {
    assert.equal(FUNCTIONS.regex({ pattern, value: matching }, { locale: 'en-US', now: 0 }).valid, true, pattern)
    assert.equal(FUNCTIONS.regex({ pattern, value: failing }, { locale: 'en-US', now: 0 }).valid, false, pattern)
  }
})

/* ------------------------------------------------------------------ */
/* 复验返修：散点计数、多 Surface 总预算、深层 JSON、拒绝写入              */
/* ------------------------------------------------------------------ */

test('Plot scatter points are counted, not just sampled curves', () => {
  const points = Array.from({ length: 500 }, (_, index) => ({ x: index, y: index }))
  const plots = Array.from({ length: 8 }, () => ({ kind: 'scatter', points }))
  const result = v([
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'p',
        components: [
          { id: 'root', component: 'Column', children: ['p1', 'p2'] },
          { id: 'p1', component: 'Plot', plots, samples: 8, xMin: 0, xMax: 500 },
          { id: 'p2', component: 'Plot', plots, samples: 8, xMin: 0, xMax: 500 },
        ],
      },
    },
  ])
  assert.equal(result.ok, false)
  assert.match(result.errors.map((error) => error.message).join('\n'), /data rows, points or animation items/u)
})

test('a multi-surface payload is bounded in total, not only per surface', () => {
  const values = Array.from({ length: 1_500 }, (_, index) => index)
  const surface = (id) => ({
    version: '1.0',
    createSurface: {
      surfaceId: id,
      dataModel: { values },
      components: [{ id: 'root', component: 'LineChart', categories: ['a'], series: [{ label: 'S', values: { '@path': '/values' } }] }],
    },
  })
  const result = v([surface('a'), surface('b'), surface('c'), surface('d'), surface('e')])
  assert.equal(result.ok, false)
  assert.match(result.errors.map((error) => error.message).join('\n'), /in total across its surfaces/u)
})

test('a deeply nested payload is rejected without overflowing the stack', () => {
  let cursor = []
  const root = cursor
  for (let index = 0; index < 11_000; index += 1) {
    const next = []
    cursor.push(next)
    cursor = next
  }
  const result = v([{ version: '1.0', createSurface: { surfaceId: 'd', dataModel: { deep: root }, components: [{ id: 'root', component: 'Text', text: 'x' }] } }])
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].path, '/messages')
  assert.match(result.errors[0].message, /128 levels/u)
})

test('a refused data-model write is reported at its field', () => {
  const result = v([
    { version: '1.0', createSurface: { surfaceId: 's', dataModel: { arr: [] }, components: [{ id: 'root', component: 'Text', text: 'x' }] } },
    { version: '1.0', updateDataModel: { surfaceId: 's', path: '/arr/500', value: 1 } },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].path, '/messages/1/updateDataModel/path')
  assert.match(result.errors[0].message, /past the end/u)
})

test('a legal append and a legal delete still apply', () => {
  const result = v([
    { version: '1.0', createSurface: { surfaceId: 's', dataModel: { arr: [], keep: 1 }, components: [{ id: 'root', component: 'Text', text: 'x' }] } },
    { version: '1.0', updateDataModel: { surfaceId: 's', path: '/arr/0', value: 1 } },
    { version: '1.0', updateDataModel: { surfaceId: 's', path: '/arr/-', value: 2 } },
    { version: '1.0', updateDataModel: { surfaceId: 's', path: '/keep', value: null } },
  ])
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.states.get('s').dataModel, { arr: [1, 2] })
})

test('pointerWrite distinguishes ok, unchanged and refused', () => {
  assert.equal(pointerWrite({ a: 1 }, '/a', 1).status, 'unchanged')
  assert.equal(pointerWrite({ a: 1 }, '/a', 2).status, 'ok')
  assert.equal(pointerWrite({ a: 1 }, '/b', 2).status, 'ok')
  const refused = pointerWrite({ arr: [] }, '/arr/500', 1)
  assert.equal(refused.status, 'refused')
  assert.match(String(refused.reason), /past the end/u)
  assert.equal(pointerWrite({ arr: [1] }, '/arr/-', 2).status, 'ok')
})

/**
 * The renderer executor: the only place a browser action is authorized.
 *
 * These are the tests that matter for release. The rule the module exists to
 * enforce is that neither the agent nor its payload can produce an action: a
 * gesture-bound function needs a live activation *and* an explicit confirmation,
 * and a URL needs `https:` parsed, not matched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXECUTABLE,
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
  RendererExecutor,
  admitFilename,
  admitHttpsUrl,
  checkExecutableArguments,
  isExecutable,
  requiresGesture,
} from '../build/shared.mjs'

/** An executor whose gates answer as the test dictates. */
function executor(overrides = {}) {
  const calls = { open: [], copy: [], download: [], scroll: [], confirm: [] }
  const host = {
    activation: () => true,
    confirm: async (request) => {
      calls.confirm.push(request)
      return true
    },
    open: (url) => calls.open.push(url),
    copy: async (text) => calls.copy.push(text),
    download: (file) => calls.download.push(file),
    scroll: (componentId) => {
      calls.scroll.push(componentId)
      return true
    },
    ...overrides,
  }
  return { executor: new RendererExecutor(host), calls }
}

/* ---------------------------------------------------------------- */
/* Scheme admission                                                  */
/* ---------------------------------------------------------------- */

test('only https is admitted for a URL', () => {
  assert.equal(admitHttpsUrl('https://example.com/a').ok, true)
  for (const bad of [
    'http://example.com',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:x',
    'chrome://settings',
    '//example.com',
    '/relative/path',
    'example.com',
  ]) {
    const result = admitHttpsUrl(bad)
    assert.equal(result.ok, false, `"${bad}" must be refused`)
  }
})

test('a scheme cannot be smuggled past the parser', () => {
  for (const bad of [
    ' javascript:alert(1)',
    'javascript:alert(1) ',
    '\tjavascript:alert(1)',
    'java\nscript:alert(1)',
    'https://example.com\nhttps://evil.test',
  ]) {
    assert.equal(admitHttpsUrl(bad).ok, false, `"${bad}" must be refused`)
  }
})

test('credentials in a URL are refused', () => {
  assert.equal(admitHttpsUrl('https://user:pass@example.com').ok, false)
})

test('an over-long URL is refused before parsing', () => {
  assert.equal(admitHttpsUrl(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`).ok, false)
})

test('a download filename cannot escape its directory', () => {
  assert.equal(admitFilename('report.txt').ok, true)
  for (const bad of ['../escape.txt', 'a/b.txt', 'a\\b.txt', '..', '.', '', 'a\u0000b']) {
    assert.equal(admitFilename(bad).ok, false, `"${bad}" must be refused`)
  }
})

/* ---------------------------------------------------------------- */
/* Gesture gate                                                      */
/* ---------------------------------------------------------------- */

test('a gesture-bound function does nothing without a live activation', async () => {
  const { executor: run, calls } = executor({ activation: () => false })
  const outcome = await run.execute('openUrl', { url: 'https://example.com' })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'gesture-required')
  assert.equal(calls.open.length, 0, 'nothing was opened')
  assert.equal(calls.confirm.length, 0, 'the user was not even asked')
})

test('activation alone is not enough: the user must confirm', async () => {
  const asked = []
  const { executor: run, calls } = executor({
    confirm: async (request) => {
      asked.push(request)
      return false
    },
  })
  const outcome = await run.execute('copyToClipboard', { text: 'secret' })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'user-declined')
  assert.equal(calls.copy.length, 0)
  assert.equal(asked.length, 1, 'the user was asked once and said no')
})

test('both gates together perform the action', async () => {
  const { executor: run, calls } = executor()
  const outcome = await run.execute('copyToClipboard', { text: 'hello' })
  assert.equal(outcome.kind, 'result')
  assert.deepEqual(calls.copy, ['hello'])
  assert.equal(calls.confirm.length, 1)
})

test('a page with no confirm dialog falls back to refusing', async () => {
  // Production wires `window.confirm`; a page without it must not become a page
  // where a gesture-bound action happens silently.
  const run = new RendererExecutor({ activation: () => true, copy: async () => {}, confirm: undefined })
  const outcome = await run.execute('copyToClipboard', { text: 'x' })
  // In Node there is no `window.confirm`, so the default confirm returns false.
  assert.equal(outcome.kind, 'refused')
  assert.ok(['user-declined', 'not-available'].includes(outcome.reason), `got ${outcome.reason}`)
})

test('a missing activation API is treated as no activation', async () => {
  // The default probe reads navigator.userActivation; in Node there is none, so
  // this is the "very old browser" path.
  const run = new RendererExecutor({ confirm: async () => true, copy: async () => {} })
  const outcome = await run.execute('copyToClipboard', { text: 'x' })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'gesture-required')
})

test('every gesture-bound function is gated, and only those', async () => {
  const bound = Object.keys(EXECUTABLE).filter((name) => requiresGesture(name)).sort()
  assert.deepEqual(bound, ['copyToClipboard', 'downloadFile', 'openUrl', 'requestFilePicker'])

  for (const name of bound) {
    const { executor: denied, calls } = executor({ activation: () => false })
    const outcome = await denied.execute(name, argsFor(name))
    assert.equal(outcome.kind, 'refused', `${name} must be gated`)
    assert.equal(calls.confirm.length, 0)
  }
})

test('a non-gesture function runs without activation or confirmation', async () => {
  const { executor: run, calls } = executor({ activation: () => false })
  const outcome = await run.execute('scrollTo', { componentId: 'root' })
  assert.equal(outcome.kind, 'result')
  assert.deepEqual(calls.scroll, ['root'])
  assert.equal(calls.confirm.length, 0)
})

/* ---------------------------------------------------------------- */
/* Execution                                                         */
/* ---------------------------------------------------------------- */

test('openUrl refuses a non-https URL even after both gates pass', async () => {
  const { executor: run, calls } = executor()
  const outcome = await run.execute('openUrl', { url: 'javascript:alert(1)' })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'scheme-rejected')
  assert.equal(calls.open.length, 0, 'the browser was never handed the URL')
})

test('downloadFile only saves text with a safe name', async () => {
  const { executor: run, calls } = executor()
  const ok = await run.execute('downloadFile', { filename: 'a.txt', text: 'body' })
  assert.equal(ok.kind, 'result')
  assert.equal(calls.download[0].filename, 'a.txt')

  const traversal = await run.execute('downloadFile', { filename: '../a.txt', text: 'body' })
  assert.equal(traversal.kind, 'refused')
  assert.equal(traversal.reason, 'invalid-arguments')

  const huge = await run.execute('downloadFile', { filename: 'a.txt', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })
  assert.equal(huge.kind, 'refused')
})

test('an unknown function is refused without executing anything', async () => {
  const { executor: run, calls } = executor()
  for (const name of ['eval', 'fetch', 'readFile', 'window', undefined, 42]) {
    const outcome = await run.execute(name, {})
    assert.equal(outcome.kind, 'refused')
    assert.equal(outcome.reason, 'unknown-function')
  }
  assert.equal(calls.open.length + calls.copy.length + calls.download.length, 0)
})

test('argument shape is re-checked at execution time', async () => {
  const { executor: run } = executor()
  const outcome = await run.execute('copyToClipboard', { text: 42 })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'invalid-arguments')
})

test('validateForm answers immediately from the bound values', async () => {
  const { executor: run, calls } = executor({ readForm: (paths) => ({ paths, ok: true }) })
  const outcome = await run.execute('validateForm', { paths: ['/form/name'] })
  assert.equal(outcome.kind, 'result')
  assert.deepEqual(outcome.value.values, { paths: ['/form/name'], ok: true })
  assert.equal(calls.confirm.length, 0)
})

test('a scroll to a missing component reports it instead of pretending', async () => {
  const { executor: run } = executor({ scroll: () => false })
  const outcome = await run.execute('scrollTo', { componentId: 'ghost' })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'not-available')
})

test('a throwing browser API becomes a refusal, not an exception', async () => {
  const { executor: run } = executor({
    copy: async () => {
      throw new Error('clipboard denied')
    },
  })
  const outcome = await run.execute('copyToClipboard', { text: 'x' })
  assert.equal(outcome.kind, 'refused')
  assert.equal(outcome.reason, 'not-available')
  assert.match(outcome.message, /clipboard denied/u)
})

test('the executable table and the names agree', () => {
  assert.deepEqual(Object.keys(EXECUTABLE).sort(), [
    'copyToClipboard',
    'downloadFile',
    'openUrl',
    'requestFilePicker',
    'scrollTo',
    'validateForm',
  ])
  assert.equal(isExecutable('openUrl'), true)
  assert.equal(isExecutable('toString'), false, 'a prototype key is not a function')
  assert.equal(isExecutable('__proto__'), false)
})

test('checkExecutableArguments rejects unknown keys', () => {
  assert.equal(checkExecutableArguments('openUrl', { url: 'https://a.test', extra: 1 }), 'args.extra is not a property of openUrl')
  assert.match(checkExecutableArguments('openUrl', {}), /url is required/u)
  assert.equal(checkExecutableArguments('nope', {}), '"nope" is not executable')
})

/** Minimal valid arguments for one gesture-bound function. */
function argsFor(name) {
  switch (name) {
    case 'openUrl':
      return { url: 'https://example.com' }
    case 'copyToClipboard':
      return { text: 'x' }
    case 'downloadFile':
      return { filename: 'a.txt', text: 'x' }
    case 'requestFilePicker':
      return {}
    default:
      return {}
  }
}

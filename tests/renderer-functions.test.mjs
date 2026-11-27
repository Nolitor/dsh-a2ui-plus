/**
 * The renderer-function channel end to end, plus the catalog advertisement that
 * tells the agent what it may call.
 *
 * The invariant under test is narrow on purpose: a name is either on the one
 * table or it does not exist, and a gesture-bound name cannot run without a
 * gesture no matter who asks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REFUSAL,
  RENDERER_FUNCTIONS,
  RENDERER_SPECS,
  admitRequest,
  capabilitiesMatch,
  checkArguments,
  isRendererFunction,
  needsGesture,
} from '../lib/host/actions.js'
import { RENDERER_FUNCTION_CAPABILITIES, describeCatalog } from '../lib/shared/catalog.js'
import { validateToolArguments } from '../lib/shared/validate.js'

test('the catalog and the Host agree on the renderer functions', () => {
  assert.equal(capabilitiesMatch(), true, 'the advertised list must equal the accepted list')
  assert.deepEqual(
    [...RENDERER_FUNCTIONS].sort(),
    ['copyToClipboard', 'downloadFile', 'openUrl', 'requestFilePicker', 'scrollTo', 'validateForm'],
  )
  assert.equal(RENDERER_FUNCTION_CAPABILITIES.length, 6)
  assert.equal(Object.keys(RENDERER_SPECS).length, 6)
})

test('the catalog advertises capabilities.rendererFunctions', () => {
  const text = describeCatalog('full')
  assert.match(text, /^capabilities\.rendererFunctions:/mu)
  for (const name of RENDERER_FUNCTIONS) assert.ok(text.includes(name), `${name} must be advertised`)
  // The annotation states the requirement: the scheme where one is checked, and
  // the gesture requirement where a click is needed.
  assert.match(text, /openUrl \(scheme=https, gesture-required\)/u)
  assert.match(text, /downloadFile \(scheme=https, gesture-required\)/u)
  assert.match(text, /copyToClipboard \(gesture-required\)/u)
  assert.match(text, /validateForm \(pure\)/u)
  assert.match(text, /scrollTo \(local\)/u)
})

test('the advertisement survives the brief detail level', () => {
  assert.match(describeCatalog('brief'), /^capabilities\.rendererFunctions:/mu)
})

test('the Host admits a gesture-bound call but records that a gesture is required', () => {
  // The Host no longer refuses on the agent's flag, and no longer accepts it as
  // proof either: it reports the requirement and the browser enforces it.
  for (const name of ['openUrl', 'copyToClipboard', 'downloadFile', 'requestFilePicker']) {
    assert.equal(needsGesture(name), true, `${name} must be gesture-bound`)

    const withoutFlag = admitRequest({ surfaceId: 's', functionName: name, args: validArgsFor(name) })
    assert.equal(withoutFlag.ok, true, `${name} is admitted; the browser gates it`)
    assert.equal(withoutFlag.gestureRequired, true)

    const withFlag = admitRequest({ surfaceId: 's', functionName: name, args: validArgsFor(name), gesture: true })
    assert.equal(withFlag.ok, true)
    assert.equal(withFlag.gestureRequired, true, 'the agent\'s own flag changes nothing')
  }
})

test('the agent cannot authorize itself with a gesture flag', () => {
  // The regression this test pins: an earlier Host accepted `gesture: true` as
  // proof of a user gesture, which let the model approve its own browser action.
  const selfAuthorized = admitRequest({
    surfaceId: 's',
    functionName: 'openUrl',
    args: { url: 'https://example.com' },
    gesture: true,
  })
  assert.equal(selfAuthorized.ok, true)
  assert.equal(selfAuthorized.gestureRequired, true, 'the requirement survives the flag')
  // And the Host exposes no "gesture satisfied" field at all.
  assert.equal(Object.hasOwn(selfAuthorized, 'gesture'), false)
  assert.equal(Object.hasOwn(selfAuthorized, 'gestureSatisfied'), false)
})

test('the pure function answers without a gesture', () => {
  assert.equal(needsGesture('validateForm'), false)
  const admitted = admitRequest({ surfaceId: 's', functionName: 'validateForm', args: { paths: ['/form/x'] } })
  assert.equal(admitted.ok, true)
  assert.equal(admitted.gestureRequired, false)
})

test('a local function needs no gesture because it changes nothing outside the view', () => {
  assert.equal(needsGesture('scrollTo'), false)
  const admitted = admitRequest({ surfaceId: 's', functionName: 'scrollTo', args: { componentId: 'root' } })
  assert.equal(admitted.ok, true)
  assert.equal(admitted.gestureRequired, false)
})

test('an unknown name is refused before it reaches any renderer', () => {
  for (const name of ['eval', 'newFunction', 'readFile', 'fetch', 'openUrl2', '', undefined, 42, null]) {
    const refused = admitRequest({ surfaceId: 's', functionName: name, args: {}, gesture: true })
    assert.equal(refused.ok, false, `${String(name)} must be refused`)
    assert.equal(refused.reason, REFUSAL.unknownFunction)
    assert.equal(isRendererFunction(name), false)
  }
})

test('a malformed request never reaches the allowlist check', () => {
  for (const payload of [undefined, null, 'x', 42, [], {}, { functionName: 'openUrl' }]) {
    const refused = admitRequest(payload)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, REFUSAL.malformedRequest)
  }
})

test('arguments are checked against the declared schema', () => {
  assert.equal(checkArguments('copyToClipboard', { text: 'hi' }), undefined)
  assert.match(checkArguments('copyToClipboard', {}), /text is required/u)
  assert.match(checkArguments('copyToClipboard', { text: 1 }), /must be a string/u)
  assert.match(checkArguments('copyToClipboard', { text: 'x', secret: 1 }), /not a property/u)
  assert.match(checkArguments('requestFilePicker', { multiple: 'yes' }), /must be a boolean/u)
  assert.match(checkArguments('scrollTo', { componentId: 'a', behavior: 'warp' }), /must be one of/u)
})

test('the tool refuses a call outside the allowlist at the model boundary', () => {
  const result = validateToolArguments({
    messages: [
      {
        version: '1.0',
        callRendererFunction: { surfaceId: 's', functionCallId: 'c', callFunction: { '@call': 'runShell' } },
      },
    ],
  })
  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /is not a renderer function/u)
})

test('the tool admits a whitelisted call and a matching answer in one batch', () => {
  const result = validateToolArguments({
    messages: [
      { version: '1.0', callRendererFunction: { surfaceId: 's', functionCallId: 'c', callFunction: { '@call': 'openUrl', args: { url: 'https://example.com' } } } },
      { version: '1.0', agentFunctionResponse: { surfaceId: 's', functionCallId: 'c', response: { opened: true } } },
    ],
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('a function message does not disturb a surface in the same batch', () => {
  const result = validateToolArguments({
    messages: [
      { version: '1.0', createSurface: { surfaceId: 's', components: [{ id: 'root', component: 'Text', text: 'hi' }] } },
      { version: '1.0', callRendererFunction: { surfaceId: 's', functionCallId: 'c', callFunction: { '@call': 'scrollTo', args: { componentId: 'root' } } } },
    ],
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.equal(result.surfaces.length, 1, 'the surface still folds')
})

/** Minimal valid arguments for one function, so the gesture check is what runs. */
function validArgsFor(name) {
  switch (name) {
    case 'openUrl':
      return { url: 'https://example.com' }
    case 'copyToClipboard':
      return { text: 'hi' }
    case 'downloadFile':
      return { filename: 'a.txt', text: 'hi' }
    case 'requestFilePicker':
      return { multiple: false }
    default:
      return {}
  }
}

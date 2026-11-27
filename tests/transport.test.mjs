/**
 * Transport tests: the two channels that carry traffic the inline card cannot.
 *
 * These run against the compiled Host modules (`lib/host/*.js`) rather than the
 * TypeScript sources, so they exercise exactly what ships.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DownlinkRegistry,
  WS_PATH,
  WS_PROTOCOL,
  RPC_CHANNEL,
  RPC_ACTION_ENDPOINT,
  acceptKey,
  installDownlink,
  sessionIdOf,
  writeTextFrame,
} from '../lib/host/transport.js'
import {
  DEFAULT_TIMEOUT_MS,
  PendingActions,
  ActionTimeoutError,
} from '../lib/host/pending.js'
import {
  RENDERER_FUNCTIONS,
  RENDERER_SPECS,
  admitRequest,
  checkArguments,
  installUplink,
  isRendererFunction,
  needsGesture,
} from '../lib/host/actions.js'

/** A Host context stub recording effects and upgrade routes. */
function makeHostContext(services = {}) {
  const effects = []
  const upgrades = []
  const rpcHandlers = new Map()
  return {
    webServer: {
      registerUpgrade(route) {
        upgrades.push(route)
        return () => upgrades.splice(upgrades.indexOf(route), 1)
      },
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          rpcHandlers.set(channel, handler)
          return async () => rpcHandlers.delete(channel)
        },
      },
    },
    get: (name) => services[name],
    logger: { warn() {}, debug() {} },
    effect(factory, label) {
      const cleanup = factory()
      effects.push({ label, cleanup })
      return cleanup
    },
    upgrades_() {
      return upgrades
    },
    rpc_() {
      return rpcHandlers
    },
    effects_() {
      return effects
    },
  }
}

/** A raw duplex stub that records what the Host writes. */
function makeSocket() {
  const written = []
  const listeners = new Map()
  return {
    write(chunk) {
      written.push(chunk)
      return true
    },
    destroy() {
      listeners.get('close')?.()
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
    written_() {
      return written
    },
  }
}

/** Decode the JSON of the first frame written to a socket. */
function frameOf(socket) {
  const chunks = socket.written_()
  assert.ok(chunks.length > 0, 'the socket received something')
  const last = chunks[chunks.length - 1]
  // The first write may be the 101 handshake; frames are Buffers.
  const payload = Buffer.isBuffer(last) ? last : Buffer.from(String(last), 'utf8')
  if (payload[0] === 0x81) {
    // Strip the frame header: 2 bytes below 126, 4 bytes below 64 KiB.
    const length = payload[1] & 0x7f
    const offset = length < 126 ? 2 : length === 126 ? 4 : 10
    return JSON.parse(payload.subarray(offset).toString('utf8'))
  }
  return JSON.parse(payload.toString('utf8').split('\r\n\r\n').pop() || '{}')
}

/* ---------------------------------------------------------------- */
/* Constants                                                         */
/* ---------------------------------------------------------------- */

test('the RPC channel carries no slash, which Connection requires', () => {
  assert.equal(RPC_CHANNEL, '/a2ui-plus')
  assert.match(RPC_CHANNEL, /^\/[A-Za-z0-9._~-]+$/u, 'Connection validates this exact shape')
  assert.equal(RPC_ACTION_ENDPOINT, 'action')
  assert.match(RPC_ACTION_ENDPOINT, /^[A-Za-z0-9_$.-]+$/u)
  assert.equal(WS_PATH, '/a2ui/ws')
  assert.equal(WS_PROTOCOL, 'a2ui-plus.v1')
})

test('the websocket accept key matches RFC 6455', () => {
  // The RFC's own example: this key produces this accept value.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('a session id is read from the upgrade query and never guessed', () => {
  assert.equal(sessionIdOf('/a2ui/ws?sessionId=abc'), 'abc')
  assert.equal(sessionIdOf('/a2ui/ws?x=1&sessionId=abc'), 'abc')
  assert.equal(sessionIdOf('/a2ui/ws?sessionId='), undefined)
  assert.equal(sessionIdOf('/a2ui/ws'), undefined)
  assert.equal(sessionIdOf(undefined), undefined)
})

/* ---------------------------------------------------------------- */
/* Downlink                                                          */
/* ---------------------------------------------------------------- */

test('a frame fans out to every attachment of its session only', () => {
  const registry = new DownlinkRegistry()
  const a = []
  const b = []
  const other = []
  registry.attach('s1', { send: (f) => a.push(f), close() {} })
  registry.attach('s1', { send: (f) => b.push(f), close() {} })
  registry.attach('s2', { send: (f) => other.push(f), close() {} })

  const delivered = registry.push('s1', { type: 'STATE_DELTA', surfaceId: 'x', delta: [] })
  assert.equal(delivered, 2)
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(other.length, 0, 'another session must not see this surface')
  assert.equal(a[0].surfaceRevision, undefined, 'the transport no longer invents a revision')
})

test('a reconnecting browser receives a freshly synthesized baseline', () => {
  let revision = 3
  const registry = new DownlinkRegistry(() => [
    { type: 'ACTIVITY_SNAPSHOT', surfaceId: 'card', activityType: 'a2ui.surface', messageId: 'card', surfaceRevision: revision, content: { surfaceId: 'card', messages: [] }, replace: true },
  ])
  registry.attach('s1', { send() {}, close() {} })
  registry.push('s1', { type: 'STATE_DELTA', surfaceId: 'card', delta: [] })

  const late = []
  registry.attach('s1', { send: (f) => late.push(f), close() {} })
  assert.equal(late.length, 1, 'exactly one baseline frame')
  assert.equal(late[0].type, 'ACTIVITY_SNAPSHOT')
  assert.equal(late[0].surfaceRevision, 3, 'the store revision, not a transport counter')

  // A provider is read per attach, so the next socket sees the newer state.
  revision = 11
  const second = []
  registry.attach('s1', { send: (f) => second.push(f), close() {} })
  assert.equal(second[0].surfaceRevision, 11)
})

test('a delta is not a baseline, and detaching stops delivery', () => {
  const registry = new DownlinkRegistry()
  const frames = []
  const detach = registry.attach('s1', { send: (f) => frames.push(f), close() {} })
  registry.push('s1', { type: 'STATE_DELTA', surfaceId: 'card', delta: [] })
  assert.equal(frames.length, 1)

  detach()
  registry.push('s1', { type: 'STATE_DELTA', surfaceId: 'card', delta: [] })
  assert.equal(frames.length, 1, 'a detached attachment receives nothing')

  const late = []
  registry.attach('s1', { send: (f) => late.push(f), close() {} })
  assert.equal(late.length, 0, 'a session that never sent a snapshot has no baseline')
})

test('a throwing attachment is dropped without stopping its siblings', () => {
  const registry = new DownlinkRegistry()
  const good = []
  let closed = 0
  registry.attach('s1', {
    send() {
      throw new Error('socket gone')
    },
    close() {
      closed += 1
    },
  })
  registry.attach('s1', { send: (f) => good.push(f), close() {} })

  registry.push('s1', { type: 'STATE_DELTA', surfaceId: 'x', delta: [] })
  assert.equal(good.length, 1)
  assert.equal(closed, 1)
  assert.equal(registry.has('s1'), true, 'the surviving attachment keeps the session')
})

test('dispose closes every socket', () => {
  const registry = new DownlinkRegistry()
  let closed = 0
  registry.attach('s1', { send() {}, close: () => (closed += 1) })
  registry.dispose()
  assert.equal(closed, 1)
  assert.equal(registry.has('s1'), false)
})

test('the upgrade route is installed once and removed by its disposer', () => {
  const ctx = makeHostContext()
  const registry = new DownlinkRegistry()
  installDownlink(ctx, registry)
  assert.equal(ctx.upgrades_().length, 1)
  assert.equal(ctx.upgrades_()[0].path, WS_PATH)
  assert.deepEqual(
    ctx.effects_().map((effect) => effect.label),
    ['a2ui-plus: downlink websocket', 'a2ui-plus: downlink keepalive'],
  )

  for (const effect of ctx.effects_()) effect.cleanup()
  assert.equal(ctx.upgrades_().length, 0, 'unloading removes the route')
})

test('a socket without a sessionId is refused in HTTP, not a bare reset', () => {
  const ctx = makeHostContext()
  const registry = new DownlinkRegistry()
  installDownlink(ctx, registry)
  const socket = makeSocket()
  ctx.upgrades_()[0].handler({ url: WS_PATH, headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, socket, Buffer.alloc(0))
  const answer = String(socket.written_()[0])
  assert.match(answer, /^HTTP\/1\.1 400 Bad Request/u, 'a client must be able to tell refusal from a crash')
  assert.ok(!answer.includes('101'), 'no upgrade happened')
})

test('a socket without a Sec-WebSocket-Key is refused in HTTP', () => {
  const ctx = makeHostContext()
  const registry = new DownlinkRegistry()
  installDownlink(ctx, registry)
  const socket = makeSocket()
  ctx.upgrades_()[0].handler({ url: `${WS_PATH}?sessionId=s1`, headers: {} }, socket, Buffer.alloc(0))
  assert.match(String(socket.written_()[0]), /^HTTP\/1\.1 400 Bad Request/u)
})

test('a socket with a sessionId completes the handshake and receives frames', () => {
  const ctx = makeHostContext()
  const registry = new DownlinkRegistry()
  installDownlink(ctx, registry)
  const socket = makeSocket()
  ctx.upgrades_()[0].handler(
    { url: `${WS_PATH}?sessionId=abc`, headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } },
    socket,
    Buffer.alloc(0),
  )

  const handshake = String(socket.written_()[0])
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/u)
  assert.match(handshake, new RegExp(`Sec-WebSocket-Protocol: ${WS_PROTOCOL}`, 'u'))
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/u)

  registry.push('abc', { type: 'STATE_DELTA', surfaceId: 's', delta: [] })
  assert.equal(frameOf(socket).type, 'STATE_DELTA')
  assert.equal(registry.has('abc'), true)
})

test('a text frame encodes short, medium and long payloads', () => {
  for (const size of [10, 200, 70_000]) {
    const socket = makeSocket()
    writeTextFrame(socket, 'x'.repeat(size))
    const buffer = socket.written_()[0]
    assert.equal(buffer[0], 0x81, 'FIN + text opcode')
    const length = buffer[1] & 0x7f
    if (size < 126) assert.equal(length, size)
    else if (size < 65_536) assert.equal(length, 126)
    else assert.equal(length, 127)
  }
})

/* ---------------------------------------------------------------- */
/* Pending correlation                                               */
/* ---------------------------------------------------------------- */

test('an answer resolves its request and names the function', async () => {
  const pending = new PendingActions(1_000)
  const promise = pending.request('card', 'openUrl')
  assert.equal(pending.has('card'), true)
  assert.equal(pending.settle('card', 'https://example.com', 'openUrl'), true)
  assert.equal(await promise, 'https://example.com')
  assert.equal(pending.has('card'), false)
})

test('an answer naming a different function is refused', async () => {
  const pending = new PendingActions(1_000)
  const promise = pending.request('card', 'openUrl')
  assert.equal(pending.settle('card', 'nope', 'scrollTo'), false, 'a crossed reply is dropped')
  assert.equal(pending.has('card'), true, 'the request stays pending')
  pending.settle('card', 'https://example.com', 'openUrl')
  assert.equal(await promise, 'https://example.com')
})

test('a request times out with a precise error', async () => {
  const pending = new PendingActions(20)
  await assert.rejects(pending.request('card', 'copyToClipboard'), (error) => {
    assert.ok(error instanceof ActionTimeoutError)
    assert.match(error.message, /copyToClipboard/u)
    assert.match(error.message, /"card"/u)
    return true
  })
  assert.equal(pending.has('card'), false)
})

test('cancellation settles the request instead of leaking it', async () => {
  const pending = new PendingActions(5_000)
  const controller = new AbortController()
  const promise = pending.request('card', 'validateForm', controller.signal)
  controller.abort(new Error('caller went away'))
  await assert.rejects(promise, /caller went away/u)
  assert.equal(pending.has('card'), false)
})

test('a newer request supersedes the older one for the same surface', async () => {
  const pending = new PendingActions(5_000)
  const first = pending.request('card', 'openUrl')
  const second = pending.request('card', 'scrollTo')
  await assert.rejects(first, /superseded/u)
  pending.settle('card', 'ok', 'scrollTo')
  assert.equal(await second, 'ok')
})

test('dispose fails every pending request', async () => {
  const pending = new PendingActions(5_000)
  const promise = pending.request('card', 'openUrl')
  pending.dispose()
  await assert.rejects(promise, /channel closed/u)
})

test('the default timeout is bounded', () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 30_000)
})

/* ---------------------------------------------------------------- */
/* Uplink allowlist                                                  */
/* ---------------------------------------------------------------- */

test('exactly six renderer functions exist', () => {
  assert.deepEqual(
    [...RENDERER_FUNCTIONS].sort(),
    ['copyToClipboard', 'downloadFile', 'openUrl', 'requestFilePicker', 'scrollTo', 'validateForm'],
  )
  assert.equal(Object.keys(RENDERER_SPECS).length, 6)
  assert.equal(isRendererFunction('openUrl'), true)
  assert.equal(isRendererFunction('evalScript'), false)
  assert.equal(isRendererFunction(undefined), false)
})

test('only the four browser-permission functions need a gesture', () => {
  assert.deepEqual(
    RENDERER_FUNCTIONS.filter((name) => needsGesture(name)).sort(),
    ['copyToClipboard', 'downloadFile', 'openUrl', 'requestFilePicker'],
  )
  assert.equal(needsGesture('validateForm'), false)
  assert.equal(needsGesture('scrollTo'), false)
})

test('a function outside the allowlist is refused by name', () => {
  const result = admitRequest({ surfaceId: 'card', functionName: 'readLocalFile', args: {} })
  assert.equal(result.ok, false)
  assert.match(result.message, /not a renderer function/u)
  assert.match(result.message, /openUrl, scrollTo/u, 'the refusal lists the allowlist')
})

test('a gesture-bound function is admitted with its requirement recorded', () => {
  // The Host admits and reports; the browser gates (see executor.test.mjs). The
  // agent's own `gesture` flag is not evidence of anything.
  const withoutFlag = admitRequest({ surfaceId: 'card', functionName: 'openUrl', args: { url: 'https://example.com' } })
  assert.equal(withoutFlag.ok, true)
  assert.equal(withoutFlag.gestureRequired, true)

  const withFlag = admitRequest({
    surfaceId: 'card',
    functionName: 'openUrl',
    args: { url: 'https://example.com' },
    gesture: true,
  })
  assert.equal(withFlag.ok, true)
  assert.equal(withFlag.gestureRequired, true, 'the flag does not satisfy the requirement')
})

test('the pure function answers without a gesture', () => {
  const result = admitRequest({ surfaceId: 'card', functionName: 'validateForm', args: { paths: ['/form/name'] } })
  assert.equal(result.ok, true)
})

test('a malformed request is refused before the function is read', () => {
  for (const payload of [null, 'x', [], { functionName: 'openUrl', gesture: true }]) {
    const result = admitRequest(payload)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'malformed-request')
  }
})

test('arguments are checked against the function schema', () => {
  assert.equal(checkArguments('openUrl', { url: 'https://example.com' }), undefined)
  assert.match(checkArguments('openUrl', {}), /url is required/u)
  assert.match(checkArguments('openUrl', { url: 42 }), /must be a string/u)
  assert.match(checkArguments('openUrl', { url: 'x', extra: 1 }), /not a property/u)
  assert.match(checkArguments('scrollTo', { componentId: 'a', behavior: 'jump' }), /must be one of/u)
  assert.match(checkArguments('openUrl', 'text'), /must be an object/u)
})

/* ---------------------------------------------------------------- */
/* Uplink RPC channel                                                */
/* ---------------------------------------------------------------- */

test('the uplink registers one channel and answers an admitted request', async () => {
  const ctx = makeHostContext()
  const seen = []
  installUplink(ctx, async (surfaceId, functionName, args) => {
    seen.push({ surfaceId, functionName, args })
    return { ok: true }
  })
  assert.equal(ctx.effects_()[0].label, 'a2ui-plus: uplink rpc')
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  assert.equal(typeof handler, 'function', 'the channel carries no slash')

  const response = await handler(
    RPC_ACTION_ENDPOINT,
    { surfaceId: 'card', functionName: 'validateForm', args: { paths: [] } },
    new AbortController().signal,
    {},
  )
  assert.equal(response.ok, true)
  assert.equal(response.value.kind, 'response')
  assert.equal(seen.length, 1)
})

test('the uplink reads the request object straight from the payload', async () => {
  // Regression: Connection hands the handler `message.payload` verbatim, so a
  // client that wrapped its request in `{ args: … }` nested it one level deeper
  // than the Host reads, and every call came back `malformed-request`.
  const ctx = makeHostContext()
  const seen = []
  installUplink(ctx, async (surfaceId, functionName) => {
    seen.push({ surfaceId, functionName })
    return { ok: true }
  })
  const handler = ctx.rpc_().get(RPC_CHANNEL)

  const flat = await handler(
    RPC_ACTION_ENDPOINT,
    { surfaceId: 's1', functionName: 'validateForm', args: { paths: [] } },
    new AbortController().signal,
    {},
  )
  assert.equal(flat.value.kind, 'response', 'a flat request must be understood')
  assert.equal(seen.length, 1)

  const nested = await handler(
    RPC_ACTION_ENDPOINT,
    { args: { surfaceId: 's2', functionName: 'validateForm', args: { paths: [] } } },
    new AbortController().signal,
    {},
  )
  assert.equal(nested.value.kind, 'refused', 'the nested shape is not the protocol')
  assert.equal(nested.value.reason, 'malformed-request')
})

test('the resync endpoint answers with the frames the store built', async () => {
  const ctx = makeHostContext()
  installUplink(ctx, async () => undefined, (sessionId, surfaceIds) => [
    { type: 'ACTIVITY_SNAPSHOT', surfaceId: surfaceIds[0] ?? sessionId, surfaceRevision: 3 },
  ])
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  const answer = await handler('resync', { sessionId: 's1', surfaceIds: ['card'] }, new AbortController().signal, {})
  assert.equal(answer.ok, true)
  assert.equal(answer.value.frames.length, 1)
  assert.equal(answer.value.frames[0].surfaceId, 'card')
})

test('resync never hands a surface to a session that does not own it', async () => {
  // `sessionId` travels in the request body and a Peer carries no session
  // identity, so the enforceable check is surface ownership: a frame is only
  // returned to the session that published it.
  const ctx = makeHostContext()
  const owners = new Map([['mine', 's1'], ['theirs', 's2']])
  installUplink(
    ctx,
    async () => undefined,
    (sessionId, surfaceIds) =>
      surfaceIds
        .filter((surfaceId) => owners.get(surfaceId) === sessionId)
        .map((surfaceId) => ({ type: 'ACTIVITY_SNAPSHOT', surfaceId, surfaceRevision: 1 })),
  )
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  const answer = await handler(
    'resync',
    { sessionId: 's1', surfaceIds: ['mine', 'theirs'] },
    new AbortController().signal,
    {},
  )
  assert.equal(answer.value.frames.length, 1)
  assert.equal(answer.value.frames[0].surfaceId, 'mine')
})

test('resync without a session answers nothing instead of guessing', async () => {
  const ctx = makeHostContext()
  installUplink(ctx, async () => undefined, () => [{ type: 'ACTIVITY_SNAPSHOT', surfaceId: 'x', surfaceRevision: 1 }])
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  const answer = await handler('resync', {}, new AbortController().signal, {})
  assert.deepEqual(answer.value.frames, [])
})

test('the uplink refuses an unknown endpoint and never dispatches', async () => {
  const ctx = makeHostContext()
  let dispatched = 0
  installUplink(ctx, async () => {
    dispatched += 1
    return undefined
  })
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  const response = await handler('other', {}, new AbortController().signal, {})
  assert.equal(response.ok, false)
  assert.equal(dispatched, 0)
})

test('the uplink relays a refusal without dispatching', async () => {
  const ctx = makeHostContext()
  let dispatched = 0
  installUplink(ctx, async () => {
    dispatched += 1
  })
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  const response = await handler(RPC_ACTION_ENDPOINT, { surfaceId: 'card', functionName: 'rm-rf', args: {} }, new AbortController().signal, {})
  assert.equal(response.ok, true)
  assert.equal(response.value.kind, 'refused')
  assert.equal(response.value.reason, 'unknown-function')
  assert.equal(dispatched, 0)
})

test('the uplink reports a missing renderer rather than inventing a result', async () => {
  const ctx = makeHostContext()
  installUplink(ctx, async () => undefined)
  const handler = ctx.rpc_().get(RPC_CHANNEL)
  const response = await handler(RPC_ACTION_ENDPOINT, { surfaceId: 'card', functionName: 'scrollTo', args: { componentId: 'a' } }, new AbortController().signal, {})
  assert.equal(response.value.kind, 'refused')
  assert.equal(response.value.reason, 'renderer-absent')
})

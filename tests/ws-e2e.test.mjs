/**
 * Real-socket E2E: the downlink against a genuine `ws` client.
 *
 * The other transport tests drive the upgrade handler with a stub duplex, which
 * proves the Host's own encoding but not that a real client agrees with it. This
 * file stands up an actual `node:http` server, hands its `upgrade` event to the
 * same handler production uses, and talks to it with `ws` — the client every
 * browser-compatible stack shares. Masking, the subprotocol handshake and the
 * ping/pong exchange are only real here.
 *
 * `ws` is a devDependency on purpose: the plugin's runtime dependencies stay
 * empty, because the Host owns the socket.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'

import { DownlinkRegistry, installDownlink, PING_INTERVAL_MS, WS_PATH, WS_PROTOCOL } from '../lib/host/transport.js'

/**
 * Start a real HTTP server whose upgrade route is the plugin's own handler.
 * @param registry the push registry to attach sockets to.
 * @returns the server, its port, and a closer.
 */
async function startHost(registry) {
  const effects = []
  const ctx = {
    effect(factory, label) {
      const cleanup = factory()
      effects.push({ label, cleanup })
      return cleanup
    },
    logger: { warn() {}, debug() {} },
  }

  const server = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()

  // The route registry the plugin receives from the Host.
  ctx.webServer = {
    registerUpgrade(route) {
      const onUpgrade = (req, socket, head) => route.handler(req, socket, head)
      server.on('upgrade', onUpgrade)
      return () => server.off('upgrade', onUpgrade)
    },
  }
  installDownlink(ctx, registry)

  return {
    port,
    url: (sessionId) => `ws://127.0.0.1:${port}${WS_PATH}?sessionId=${sessionId}`,
    async close() {
      for (const effect of effects) effect.cleanup()
      // Destroy live sockets first: `server.close()` waits for them, and a test
      // that left one open would hang instead of failing.
      server.closeAllConnections?.()
      server.close()
      await once(server, 'close').catch(() => {})
    },
  }
}

/**
 * Open one socket and collect messages from before the handshake completes.
 *
 * The listener is attached at construction time on purpose: the reconnect
 * baseline rides the same packet as the `open` event, so a listener registered
 * after `await once(socket, 'open')` misses it. That ordering is the client's
 * obligation, not a Host defect, and a browser that got it wrong would simply
 * wait for the next push.
 * @param url the downlink URL.
 * @returns the socket, plus `next()` awaiting the next parsed message.
 */
async function openSocket(url) {
  const socket = new WebSocket(url, WS_PROTOCOL)
  const queue = []
  const waiters = []
  socket.on('message', (data) => {
    const parsed = JSON.parse(String(data))
    const waiter = waiters.shift()
    if (waiter === undefined) queue.push(parsed)
    else waiter(parsed)
  })
  const next = (timeoutMs = 2_000) =>
    new Promise((resolve, reject) => {
      if (queue.length > 0) {
        resolve(queue.shift())
        return
      }
      const timer = setTimeout(() => reject(new Error('no message arrived')), timeoutMs)
      waiters.push((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  await once(socket, 'open')
  return { socket, next }
}

test('a real ws client completes the subprotocol handshake', async () => {
  const registry = new DownlinkRegistry()
  const host = await startHost(registry)
  try {
    const socket = new WebSocket(host.url('s1'), WS_PROTOCOL)
    await once(socket, 'open')
    assert.equal(socket.protocol, WS_PROTOCOL, 'the negotiated subprotocol is echoed back')
    socket.close()
    await once(socket, 'close').catch(() => {})
  } finally {
    await host.close()
  }
})

test('a real ws client offering a wrong subprotocol is refused', async () => {
  const registry = new DownlinkRegistry()
  const host = await startHost(registry)
  try {
    const socket = new WebSocket(host.url('s1'), 'a2ui-plus.v0')
    const [error] = await once(socket, 'error').catch(() => [undefined])
    assert.ok(error !== undefined, 'the handshake must fail rather than downgrade')
    socket.terminate()
  } finally {
    await host.close()
  }
})

test('a masked client message is decoded and a ping is answered with a pong', async () => {
  const registry = new DownlinkRegistry()
  const host = await startHost(registry)
  try {
    const socket = new WebSocket(host.url('s1'), WS_PROTOCOL)
    await once(socket, 'open')

    // ws masks client frames for us; the pong proves the masked path and the
    // control-frame answer both work on a real socket.
    const pong = new Promise((resolve) => socket.once('pong', resolve))
    socket.ping(Buffer.from('probe'))
    await pong

    socket.close()
    await once(socket, 'close').catch(() => {})
  } finally {
    await host.close()
  }
})

test('a pushed frame reaches a real client with its revision', async () => {
  const registry = new DownlinkRegistry(() => [
    { type: 'ACTIVITY_SNAPSHOT', surfaceId: 'card', activityType: 'a2ui.surface', messageId: 'card', surfaceRevision: 7, content: {}, replace: true },
  ])
  const host = await startHost(registry)
  try {
    const { socket, next } = await openSocket(host.url('s1'))

    const baseline = await next()
    assert.equal(baseline.type, 'ACTIVITY_SNAPSHOT')
    assert.equal(baseline.surfaceRevision, 7, 'the store revision rides the frame')

    registry.push('s1', { type: 'STATE_DELTA', surfaceId: 'card', surfaceRevision: 8, delta: [] })
    const delta = await next()
    assert.equal(delta.type, 'STATE_DELTA')
    assert.equal(delta.surfaceRevision, 8)

    socket.close()
    await once(socket, 'close').catch(() => {})
  } finally {
    await host.close()
  }
})

test('the baseline provider is consulted per socket, not cached from a previous one', async () => {
  let revision = 1
  const registry = new DownlinkRegistry(() => [
    { type: 'ACTIVITY_SNAPSHOT', surfaceId: 'card', activityType: 'a2ui.surface', messageId: 'card', surfaceRevision: revision, content: {}, replace: true },
  ])
  const host = await startHost(registry)
  try {
    const first = await openSocket(host.url('s1'))
    assert.equal((await first.next()).surfaceRevision, 1)
    first.socket.close()
    await once(first.socket, 'close').catch(() => {})

    // The store moved on while no browser was attached; a reconnect must see the
    // present, not the frame the first socket received.
    revision = 9
    const second = await openSocket(host.url('s1'))
    assert.equal((await second.next()).surfaceRevision, 9)
    second.socket.close()
    await once(second.socket, 'close').catch(() => {})
  } finally {
    await host.close()
  }
})

test('a socket without a sessionId never upgrades', async () => {
  const registry = new DownlinkRegistry()
  const host = await startHost(registry)
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}${WS_PATH}`, WS_PROTOCOL)
    await once(socket, 'error').catch(() => {})
    assert.notEqual(socket.readyState, WebSocket.OPEN, 'the socket must not open')
    socket.terminate()
  } finally {
    await host.close()
  }
})

test('the keepalive interval is short enough for a proxy and long enough to be quiet', () => {
  assert.ok(PING_INTERVAL_MS >= 10_000 && PING_INTERVAL_MS <= 60_000)
})

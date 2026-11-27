/**
 * The browser end of the `/a2ui/ws` downlink.
 *
 * One socket per session, opened lazily when a surface exists and closed with the
 * plugin. It owns four things the store does not:
 *
 * - **Reconnect.** A dropped socket retries with a bounded backoff, and the Host
 *   answers the new socket with a freshly synthesized baseline, so a reconnected
 *   client is correct without replaying anything.
 * - **Baseline reconciliation.** The host sends full snapshots, and the store
 *   drops any snapshot not newer than what it holds. A refresh therefore lands on
 *   the Host's present instead of resurrecting an older transcript copy.
 * - **Heartbeat.** The Host pings; the browser answers with the protocol's own
 *   pong frame, which is the only thing that keeps a reverse proxy from closing
 *   an idle socket.
 * - **Placement downgrade.** A `sidebar` surface on a narrow viewport is reported
 *   as inline, so the caller does not open a tab nobody can see.
 */
import { ClientSurfaceStore, effectivePlacement, isNarrowWidth, isPlainObject, type DownlinkFrame, type Placement } from './surface-store.js'
import type { ExecutionOutcome, RendererExecutor } from './executor.js'
import { WS_PATH, WS_PROTOCOL } from '../shared/wire.js'

/** Backoff between reconnect attempts, in milliseconds. */
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const

/** Cap on one socket's silence before the client treats it as dead. */
export const CLIENT_IDLE_TIMEOUT_MS = 60_000

/** Consecutive unapplicable patches before the client asks for a resync. */
export const RESYNC_AFTER_FAILURES = 3

/** What the client socket needs from the page around it. */
export interface SocketHost {
  /** The page's transport base; defaults to `document.baseURI`. */
  baseUrl?: () => string
  /** The live viewport width. */
  width?: () => number
  /** A `WebSocket` implementation; defaults to the page's own. */
  createSocket?: (url: string, protocols: string[]) => WebSocket
  /** Called when the store changed, and when the connection state flipped. */
  onStateChange?: (state: SocketState) => void
  /** The executor that runs a pushed renderer-function request. */
  executor?: () => RendererExecutor | undefined
  /** Answer one execution back to the Host over the RPC uplink. */
  reply?: (outcome: ExecutionOutcome & { surfaceId: string }) => void
  /**
   * Ask the Host to resend the surfaces this client could not patch.
   *
   * Resolves with the authoritative snapshots, which are adopted exactly like a
   * reconnect baseline.
   */
  resync?: (surfaceIds: string[]) => Promise<DownlinkFrame[]>
}

/** What a caller can observe about the connection. */
export interface SocketState {
  status: 'idle' | 'connecting' | 'open' | 'closed'
  /** The most recent error text, when the last attempt failed. */
  error?: string
  /** Whether a downgrade happened for the last `sidebar` surface. */
  downgraded: boolean
}

/**
 * Build the downlink URL for one session.
 *
 * The WebSocket goes to the injected transport origin rather than the page base,
 * because a desktop shell serves the page from `dsh-app://` and only the injected
 * base reaches the Host's sockets.
 * @param sessionId the session to subscribe to.
 * @param baseUrl the transport base.
 */
export function downlinkUrl(sessionId: string, baseUrl?: string): string {
  const base =
    baseUrl ??
    (typeof globalThis !== 'undefined' && (globalThis as any).__DSH_TRANSPORT__?.streamBaseUrl) ??
    (typeof document !== 'undefined' ? document.baseURI : 'http://127.0.0.1/')
  const url = new URL(WS_PATH.replace(/^\/+/u, ''), base.endsWith('/') ? base : `${base}/`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = new URLSearchParams({ sessionId }).toString()
  return url.href
}

/** The downlink client. */
export class DownlinkClient {
  private readonly store: ClientSurfaceStore
  private readonly host: SocketHost
  private readonly sessionId: string
  private socket: WebSocket | undefined
  private attempt = 0
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private state: SocketState = { status: 'idle', downgraded: false }

  /**
   * @param sessionId the session this socket speaks for.
   * @param store the store frames are applied to.
   * @param host page hooks.
   */
  constructor(sessionId: string, store: ClientSurfaceStore, host: SocketHost = {}) {
    this.sessionId = sessionId
    this.store = store
    this.host = host
  }

  /** Open the socket if it is not already open. */
  connect(): void {
    if (this.closed || this.socket !== undefined) return
    this.setState({ status: 'connecting' })
    const create = this.host.createSocket ?? ((url, protocols) => new WebSocket(url, protocols))
    if (this.host.createSocket === undefined && typeof (globalThis as any).WebSocket !== 'function') {
      // No WebSocket in this shell (a DOM test, a worker): there is nothing to
      // connect and nothing to retry. The store still works from tool results.
      this.setState({ status: 'idle' })
      return
    }
    let socket: WebSocket
    try {
      socket = create(downlinkUrl(this.sessionId, this.host.baseUrl?.()), [WS_PROTOCOL])
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : String(error))
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.setState({ status: 'open' })
      this.armIdleTimer()
    }
    socket.onmessage = (event: MessageEvent) => {
      this.armIdleTimer()
      if (typeof event.data !== 'string') return
      let frame: DownlinkFrame
      try {
        frame = JSON.parse(event.data) as DownlinkFrame
      } catch {
        return
      }
      // A renderer-function request is not surface state: it is work for this
      // page, so it goes to the executor and its answer goes back up the RPC
      // channel. Everything else belongs to the store.
      if (frame.type === 'CUSTOM' && frame.name === 'rendererFunctionRequest') {
        this.runFunctionRequest(frame)
        return
      }
      // The store drops stale revisions itself, so a re-ordered frame is safe.
      const before = this.store.failuresOf(frame.surfaceId)
      this.store.apply(frame)
      if (this.store.failuresOf(frame.surfaceId) >= RESYNC_AFTER_FAILURES && before < RESYNC_AFTER_FAILURES) {
        // Three unapplicable patches in a row means this client's copy has
        // drifted past what a patch can repair; ask for snapshots instead.
        this.requestResync([frame.surfaceId as string])
      }
    }
    socket.onerror = () => {
      this.scheduleRetry('the downlink socket reported an error')
    }
    socket.onclose = () => {
      this.socket = undefined
      this.clearIdleTimer()
      if (this.closed) {
        this.setState({ status: 'closed' })
        return
      }
      this.scheduleRetry('the downlink socket closed')
    }
  }

  /**
   * Ask the Host for authoritative snapshots and adopt them.
   *
   * The call is fire-and-forget from the frame handler's point of view: a
   * transport failure leaves the surface as it was, and the next reconnect
   * baseline repairs it.
   * @param surfaceIds the surfaces to replace.
   */
  requestResync(surfaceIds: string[]): void {
    const ask = this.host.resync
    if (ask === undefined) return
    this.store.clearFailures()
    void ask(surfaceIds)
      .then((frames) => {
        // A resync answer outranks whatever this page holds: the Host built it
        // from the store, so a stale local copy must not reject it.
        for (const frame of frames) this.store.adopt(frame)
      })
      .catch(() => {
        // The socket's own reconnect path is the fallback.
      })
  }

  /**
   * Run one pushed renderer-function request and answer it.
   *
   * The request carries no authority of its own: the executor re-reads user
   * activation, re-checks the URL scheme and asks the user before anything
   * happens. Nothing here trusts the frame's contents.
   * @param frame the `rendererFunctionRequest` frame.
   */
  private runFunctionRequest(frame: DownlinkFrame): void {
    const value = isPlainObject(frame.value) ? (frame.value as Record<string, unknown>) : {}
    const functionName = value.functionName
    const surfaceId = typeof frame.surfaceId === 'string' ? frame.surfaceId : ''
    const executor = this.host.executor?.()
    if (executor === undefined) {
      this.host.reply?.({
        surfaceId,
        kind: 'refused',
        functionName: String(functionName),
        reason: 'not-available',
        message: 'this page has no renderer executor',
      })
      return
    }
    void executor
      .execute(functionName, value.args ?? {})
      .then((outcome) => this.host.reply?.({ ...outcome, surfaceId }))
      .catch((error: unknown) => {
        this.host.reply?.({
          surfaceId,
          kind: 'refused',
          functionName: String(functionName),
          reason: 'not-available',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /**
   * Where a surface of this session should render right now.
   *
   * A downgrade is recorded on the observable state, because the caller that
   * asked for a tab needs to know the tab was not opened.
   * @param requested the placement the call asked for.
   */
  resolvePlacement(requested: Placement): { placement: Placement; downgraded: boolean } {
    const width = this.host.width?.() ?? (typeof window !== 'undefined' ? window.innerWidth : NARROW_FALLBACK)
    const resolved = effectivePlacement(requested, width)
    if (resolved.downgraded) this.setState({ downgraded: true })
    return resolved
  }

  /** The current observable state. */
  getState(): SocketState {
    return this.state
  }

  /** Close the socket and stop retrying. */
  dispose(): void {
    this.closed = true
    this.clearIdleTimer()
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close()
    } catch {
      // A socket already closing is not an error.
    }
    this.setState({ status: 'closed' })
  }

  /** Arm the silence timer that marks a wedged socket dead. */
  private armIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      // A socket that stopped delivering is not usable; dropping it makes the
      // normal reconnect path take over.
      try {
        this.socket?.close()
      } catch {
        // ignore
      }
    }, CLIENT_IDLE_TIMEOUT_MS)
    ;(this.idleTimer as any)?.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  /** Retry with a bounded backoff. */
  private scheduleRetry(reason: string): void {
    this.clearIdleTimer()
    if (this.closed || this.retryTimer !== undefined) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]
    this.attempt += 1
    this.setState({ status: 'closed', error: reason })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.connect()
    }, delay)
    ;(this.retryTimer as any)?.unref?.()
  }

  private setState(next: Partial<SocketState>): void {
    const merged: SocketState = {
      status: next.status ?? this.state.status,
      ...(next.error === undefined ? (this.state.error === undefined ? {} : { error: this.state.error }) : { error: next.error }),
      downgraded: next.downgraded ?? this.state.downgraded,
    }
    if (merged.status === 'open') delete merged.error
    this.state = merged
    try {
      this.host.onStateChange?.(merged)
    } catch {
      // An observer must not break the transport.
    }
  }
}

/** Width assumed when no window exists (tests, SSR). */
const NARROW_FALLBACK = 1280

/** Re-exported so a caller needs one import. */
export { ClientSurfaceStore, effectivePlacement, isNarrowWidth }
export type { DownlinkFrame, Placement }

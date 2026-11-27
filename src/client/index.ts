/**
 * `dsh-a2ui` — browser half entry.
 *
 * Registers one `tool.call.toolview` renderer for the `a2ui` tool, its locale
 * dictionaries, and the renderer stylesheet. Every resource is created inside
 * `ctx.effect`, so disabling the plugin removes the view, the styles and the
 * dictionaries without residue.
 */
import { h } from './h.js'
import { DICTS, NS, en } from './locale.js'
import { CSS } from './styles.js'
import { A2UIToolView, type ClientRuntime } from './tool-view.js'
import { A2uiTurnTail } from './turn-tail.js'
import type { SessionEventSource } from './stream-store.js'
import { ClientSurfaceStore, effectivePlacement } from './surface-store.js'
import { DownlinkClient } from './socket.js'
import { TabRouter, makeTabBody } from './tabs.js'
import { RendererExecutor } from './executor.js'
import { ViewAdapter, type ActionRequest } from './view-adapter.js'
import { RPC_ACTION_ENDPOINT, RPC_CHANNEL } from '../shared/wire.js'

/** Services this plugin needs before it can register anything. */
export const inject = ['slots', 'locale', 'sessions']

/** Stable style element id, also used to avoid double injection on reload. */
const STYLE_ID = 'dsh-a2ui-plus/renderer.css'

interface ClientContext {
  effect: (factory: () => (() => void) | void, label?: string) => void
  slots: {
    inject: (key: string, callback: () => (() => void) | void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  locale: {
    register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void
    bind: (ns: string) => (key: string) => string
    getLocale: () => { id?: string }
  }
  sessions: {
    scope: (sessionId: string) => { get: (name: string) => unknown } | undefined
    binding?: (sessionId: string) => { eventSource?: SessionEventSource } | undefined
  }
  get?: (name: string) => unknown
  inject?: (services: string[], callback: () => void) => unknown
  logger?: { warn?: (message: string) => void }
}

function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-a2ui-plus'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

function toBcp47(id: string | undefined): string {
  if (typeof id !== 'string' || id === '') return 'en-US'
  if (id.toLowerCase().startsWith('zh')) return id.toLowerCase().startsWith('zh-tw') ? 'zh-TW' : 'zh-CN'
  return id
}

/**
 * Send an A2UI action to the agent as an ordinary queued user message.
 *
 * This goes through the session's own Conversation service, so the Host applies
 * its normal admission rules (running turn, queue limits, permissions) exactly
 * as if the user had typed the message.
 */
function makeSendPrompt(ctx: ClientContext): (sessionId: string, text: string) => Promise<void> {
  const scopeOf = (sessionId: string): { get: (name: string) => unknown } | undefined => ctx.sessions.scope(sessionId)
  return async (sessionId, text) => {
    const scope = scopeOf(sessionId)
    if (scope === undefined) throw new Error('this session is not open in the browser')
    // The Conversation service is session-scoped; fall back to the root context
    // so a future profile that registers it globally keeps working.
    const candidates = [scope.get('conversation'), typeof ctx.get === 'function' ? ctx.get('conversation') : undefined]
    const conversation = candidates.find(
      (candidate): candidate is { send: (message: string) => Promise<void> } =>
        candidate !== null && typeof candidate === 'object' && typeof (candidate as { send?: unknown }).send === 'function',
    )
    if (conversation === undefined) {
      throw new Error('the conversation service is unavailable for this session')
    }
    await conversation.send(text)
  }
}

/**
 * Register the A2UI tool view.
 * @param ctx client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-a2ui: styles')
  ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-a2ui: locale')

  const bound = ctx.locale.bind(NS)
  const t = (key: string): string => {
    const value = bound(key)
    if (typeof value === 'string' && value !== '' && value !== key) return value
    return en[key] ?? key
  }
  const runtime: ClientRuntime = {
    t,
    locale: () => toBcp47(ctx.locale.getLocale()?.id),
    sendPrompt: makeSendPrompt(ctx),
    streamSource: (sessionId) => ctx.sessions.binding?.(sessionId)?.eventSource,
  }

  ctx.effect(
    () =>
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: 'a2ui', locale: NS }, (props: Record<string, unknown>) =>
          h(A2UIToolView, { ...props, runtime, mode: 'row' } as never),
        ),
      ),
    'dsh-a2ui: tool view',
  )

  // The turn tail is the card's visible home: it renders after the turn's answer,
  // outside the collapsible process window. Its copy claims the call while it is
  // mounted, and the process row only steps aside for as long as that claim lasts.
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'dsh-a2ui-surfaces', order: 10, locale: NS }, (props: Record<string, unknown>) =>
          h(A2uiTurnTail, { ...props, runtime } as never),
        ),
      ),
    'dsh-a2ui: turn tail',
  )

  // ---- Out-of-turn channel -------------------------------------------
  //
  // One store and one socket per open session. The store is what makes a repeat
  // call update the card in place: the tool view reads its surface by id from
  // here first and only falls back to the transcript copy when the socket has
  // never delivered one (a reloaded page, a profile without the transport).
  const stores = new Map<string, ClientSurfaceStore>()
  const sockets = new Map<string, DownlinkClient>()
  /** The session whose tabs are currently reconciled. */
  let onScreenSession: string | undefined
  /**
   * The store a refused read gets.
   *
   * A view must not branch on "denied" versus "empty" — both mean there is
   * nothing to paint, and an empty store keeps the view's types honest without
   * fabricating a surface.
   */
  const EMPTY_STORE = new ClientSurfaceStore()
  const storeOf = (sessionId: string): ClientSurfaceStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = new ClientSurfaceStore()
      stores.set(sessionId, store)
      // The tab follows the store, not the socket: a `sidebar` surface may be
      // folded from the transcript before the downlink is even open, and the tab
      // must appear then too.
      store.subscribe(() => {
        syncTabs(sessionId)
      })
    }
    return store
  }
  // One executor per page. It is where a gesture is actually checked, because it
  // is the only place a user exists.
  const executor = new RendererExecutor()

  /**
   * Answer the Host over the same channel the request came from.
   *
   * The RPC carrier is the Connection the page already has; a failure is silent
   * because the Host's pending request times out on its own and the surface is
   * still correct.
   */
  const reply = (payload: Record<string, unknown>): void => {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    const call = (connection as { rpc?: { call?: (...args: unknown[]) => Promise<unknown> } } | undefined)?.rpc?.call
    if (typeof call !== 'function') return
    // Connection hands the Host `message.payload` verbatim, so the request
    // object IS the payload — wrapping it in `{ args }` would nest it one level
    // deeper than the Host reads.
    void call.call((connection as never), RPC_CHANNEL, RPC_ACTION_ENDPOINT, payload).catch(() => {})
  }

  /**
   * The title a tab shows for one surface.
   *
   * The surface's own `title` when the call supplied one, otherwise the localized
   * plugin name — never an empty string, because an untitled tab is unclickable.
   * @param surface the stored surface.
   */
  const titleOf = (surface: { title?: string | undefined }): string => {
    const explicit = surface.title
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
    return t('title')
  }

  /**
   * Open, update or forget the tab for every surface a session holds.
   *
   * This is the hook that was missing: the store learned about a `sidebar`
   * surface, and nothing turned that knowledge into a tab. It runs on the store's
   * own subscription rather than on socket state, because a surface may arrive
   * either way (a live `ACTIVITY_SNAPSHOT` or a snapshot folded from the
   * transcript) and the tab must appear in both cases.
   *
   * A downgrade is honoured here: on a narrow viewport `resolvePlacement` returns
   * `inline`, and no tab is opened, which is what keeps the card in the
   * conversation instead of in a column the reader cannot see.
   * @param sessionId the session whose surfaces to sync.
   */
  /**
   * The session the right Sidebar is actually showing.
   *
   * Two sources, in order of authority, because a tab body is mounted without a
   * `sessionId` — measured: the slot hands the view `undefined`, so the view
   * cannot tell which session a tab belongs to and must ask.
   *
   * 1. `ctx.sidebarRight.mounted` — quoted from the installed
   *    `dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:182`:
   *
   *    ```ts
   *    readonly mounted: ObservableSnapshot<SessionId | undefined>;
   *    ```
   *
   *    That is the whole contract this code relies on: a `getSnapshot()` the
   *    `ObservableSnapshot` shape provides, returning a session id or nothing. It
   *    moves only when the on-screen session changes, which is exactly the
   *    identity a visible tab needs.
   * 2. `[data-sidebar-right-session]` — the attribute the Sidebar's own seat
   *    stamps on its panel. Used when the service is absent, which is the case on
   *    a Host without the sidebar plugin.
   *
   * @returns the mounted session id, or `undefined` when nothing is on screen.
   */
  const mountedSession = (): string | undefined => {
    const right = typeof ctx.get === 'function' ? (ctx.get('sidebarRight') as { mounted?: { getSnapshot?: () => unknown } } | undefined) : undefined
    const snapshot = right?.mounted?.getSnapshot?.()
    if (typeof snapshot === 'string' && snapshot !== '') return snapshot
    if (typeof document !== 'undefined') {
      const attribute = document.querySelector('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session')
      if (typeof attribute === 'string' && attribute !== '') return attribute
    }
    return undefined
  }

  /**
   * The session a view should read, from the one place that decides.
   *
   * A tab body is mounted without a `sessionId`, so resolution has to happen
   * somewhere. It happens **here and only here**: an earlier version resolved in
   * both the view and the store accessor, which meant removing either one alone
   * left the other silently covering for it — a bug that a test could not see.
   * @param sessionId the id a caller already has, when it has one.
   * @returns that id when it exists, otherwise the session on screen.
   */
  const sessionFor = (sessionId: string | undefined): string | undefined => {
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
    return mountedSession()
  }

  const syncTabs = (sessionId: string): void => {
    const store = storeOf(sessionId)
    const surfaces = store.list()
    // A tab must never show another session's surface. The store key and the
    // session on screen are compared here rather than trusted: a mismatch means
    // the open would land in a layout nobody is looking at, or worse, paint one
    // conversation's data into another's column.
    const onScreen = mountedSession()
    if (onScreen !== undefined && onScreen !== sessionId) {
      console.warn('[a2ui+] refusing to open tabs for a session that is not on screen', { store: sessionId, onScreen })
      return
    }

    // Forget tabs whose surface is gone or belongs to an older Host store.
    tabs.reconcile(
      surfaces.map((surface) => surface.surfaceId),
      surfaces[0]?.epoch,
    )
    for (const surface of surfaces) {
      if (surface.placement !== 'sidebar') continue
      const resolved = socketOf(sessionId).resolvePlacement('sidebar')
      if (resolved.placement !== 'sidebar') continue
      const title = titleOf(surface)
      if (tabs.tabIdFor(surface.surfaceId) === undefined) {
        try {
          tabs.open(surface.surfaceId, title, { sessionId })
        } catch (err) {
          console.error('[a2ui+] openTab error', err)
        }
      } else {
        // An already-open tab follows the surface rather than opening a second.
        tabs.update(surface.surfaceId, title, { sessionId })
      }
    }
  }

  /**
   * Follow the session on screen.
   *
   * Switching A -> B must do three things: stop treating A's surfaces as open
   * tabs, start following B's store, and open B's tabs. Leaving A's mapping in
   * place would make a later return to A open duplicate tabs, and leaving A's
   * socket attached would keep pushing frames for a conversation nobody sees.
   */
  const followMountedSession = (): void => {
    const next = mountedSession()
    if (next === undefined) return
    if (next === onScreenSession) return
    const previous = onScreenSession
    onScreenSession = next
    // Every view is told first: the adapter releases the old session's
    // subscriptions and drops its surfaces before any tab is reconciled, so no
    // frame from the previous conversation can reach a model that is being painted.
    adapter.onMountedSessionChanged(next)
    if (previous !== undefined) {
      // The previous session keeps its surfaces (its tab may be reopened), but
      // it stops being the session whose tabs are reconciled live.
      tabs.reconcile([], storeOf(previous).list()[0]?.epoch)
    }
    syncTabs(next)
  }

  const socketOf = (sessionId: string): DownlinkClient => {
    let socket = sockets.get(sessionId)
    if (socket === undefined) {
      socket = new DownlinkClient(sessionId, storeOf(sessionId), {
        width: () => (typeof window === 'undefined' ? 1280 : window.innerWidth),
        // The epoch rides into reconcile so a Host restart clears a mapping that
        // describes a store which no longer exists.
        onStateChange: () => syncTabs(sessionId),
        executor: () => executor,
        reply: (outcome) => reply({ sessionId, outcome }),
        resync: async (surfaceIds) => {
          const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
          const call = (connection as { rpc?: { call?: (...args: unknown[]) => Promise<unknown> } } | undefined)?.rpc?.call
          if (typeof call !== 'function') return []
          const result = (await call.call((connection as never), RPC_CHANNEL, 'resync', {
            sessionId,
            surfaceIds,
          })) as { ok?: boolean; value?: { frames?: unknown[] } } | undefined
          const frames = result?.ok === true ? result.value?.frames : undefined
          return Array.isArray(frames) ? (frames as never[]) : []
        },
      })
      sockets.set(sessionId, socket)
    }
    return socket
  }

  const tabs = new TabRouter(ctx as never, undefined)
  // One generic type, registered once; every surface then opens an instance of it.
  tabs.register(
    makeTabBody(undefined, (surfaceId) =>
      h(A2UIToolView, { surfaceId, surfaceOnly: true, runtime, mode: 'tail' } as never),
    ),
    () => t('title'),
    // The sidebar may load after this plugin; wait for it instead of probing once.
    // A context without `inject` (a test stub, an older runtime) falls back to the
    // single probe rather than throwing during apply.
    (services, callback) => {
      const inject = (ctx as unknown as { inject?: (list: string[], cb: () => void) => unknown }).inject
      if (typeof inject !== 'function') return undefined
      return inject.call(ctx, services, callback)
    },
  )

  // A tab body is mounted without a session; resolve the one on screen so its
  // store lookup lands on the data that tab is showing.
  /**
   * The store a surface view may read, or `undefined` when the request is for a
   * session that is not on screen.
   *
   * This is the read half of the cross-session invariant: `syncTabs` refuses to
   * *open* a tab for a foreign session, and this refuses to *paint* one. Both
   * compare the same two values through the same resolver, so a mismatch cannot
   * leak one conversation's surface into another's column by either route.
   */
  const storeFor = (sessionId: string): ClientSurfaceStore | undefined => {
    const onScreen = mountedSession()
    if (onScreen === undefined) {
      // No sidebar on this Host: the conversation path is the only one, and its
      // own session id is the authority.
      return storeOf(sessionId)
    }
    if (onScreen !== sessionId) {
      console.warn('[a2ui+] refusing to read a store for a session that is not on screen', { asked: sessionId, onScreen })
      return undefined
    }
    return storeOf(sessionId)
  }

  /**
   * The one mediator every view reads and sends through.
   *
   * It is constructed here, where the store accessor, the tab router and the
   * prompt path already exist, and it is the only object that subscribes to the
   * store on a view's behalf.
   */
  const adapter = new ViewAdapter({
    storeFor,
    mountedSession,
    send: makeSendPrompt(ctx),
    openTab: (surfaceId, title, sessionId) => {
      // Deduplication is THIS branch, not the framework. Measured 2026-11-27 on
      // better-sidebar 0.33.0: `openTab` only reuses an existing tab when the
      // descriptor supplies `dedupeKey` (or `single`, its sugar) and the seed carries
      // `meta` — `lib/client.js:1886-1901`. This plugin registers neither, so a bare
      // `openTab` seed mints a new tab every time.
      //
      // What the host does provide, measured the same day: the seed's `id` is honoured
      // as the tab identity, so two opens with `a2ui:{surfaceId}` land on one tab.
      // `TabRouter.open` seeds exactly that (tabs.ts:289). So there are two
      // independent guards, and this branch is the first: `tabIdFor` answers from the
      // router's own mapping (tabs.ts:262), which is written on every open (tabs.ts:290)
      // and pruned on reconcile (tabs.ts:361).
      //
      // Falsify: call `tabs.open(surfaceId, …)` twice directly, bypassing this branch.
      // If the sidebar then shows two tabs, the host's id identity has regressed and
      // only this branch is left — see docs/DUAL-VIEW.md, "Who prevents duplicates".
      if (tabs.tabIdFor(surfaceId) === undefined) {
        const outcome = tabs.open(surfaceId, title, { sessionId })
        return outcome.rendered === 'tab'
      }
      tabs.update(surfaceId, title, { sessionId })
      return true
    },
    warn: (message, detail) => {
      console.warn(`[a2ui+] ${message}`, detail ?? {})
    },
  })
  adapter.titleFallback = t('title')
  // The adapter's own subscriptions die with the plugin, not with a view: a view
  // that unmounted mid-frame must not leave the store pointing at it.
  ctx.effect(() => () => adapter.dispose(), 'dsh-a2ui-plus: view adapter')

  runtime.adapter = adapter
  runtime.surfaceStore = (sessionId: string) => storeFor(sessionId) ?? EMPTY_STORE
  runtime.sessionFor = sessionFor
  runtime.seedSurface = (sessionId, surfaceId, messages, placement, title) => {
    // The store only: seeding must not open a socket, or a transcript replay
    // would start a downlink just to learn what it already knows.
    const store = storeOf(sessionId)
    // A surface the downlink already delivered wins: it carries a real revision
    // and its data model is current.
    if (store.get(surfaceId) !== undefined) return
    store.apply({
      type: 'ACTIVITY_SNAPSHOT',
      surfaceId,
      surfaceRevision: 0,
      activityType: 'a2ui.surface',
      messageId: surfaceId,
      content: { surfaceId, placement, title, messages, dataModel: {}, components: [] },
      replace: true,
    })
  }
  runtime.dispatchAction = (request: ActionRequest) => adapter.dispatch(request)
  runtime.openSurfaceTab = (surfaceId: string) => adapter.openInSidebar(surfaceId)
  runtime.connectDownlink = (sessionId: string) => {
    // The view is the first place a session becomes real in the browser, and it
    // asks through `sessionFor` like every other read. Telling the adapter here is
    // what makes a Host without a Sidebar work: with no mounted-session stream to
    // follow, this is the call that points the mediator at the right store.
    const resolved = sessionFor(sessionId)
    if (resolved !== undefined) adapter.onMountedSessionChanged(resolved)
    socketOf(sessionId).connect()
  }
  ctx.effect(
    () => () => {
      for (const socket of sockets.values()) socket.dispose()
      for (const store of stores.values()) store.clear()
      sockets.clear()
      stores.clear()
    },
    'dsh-a2ui-plus: downlink clients',
  )

  // Two read-only handles for an end-to-end test to observe the real page.
  //
  // They expose decisions the plugin already makes — not new capabilities: the
  // executor still re-checks activation per call, and the placement resolver is
  // the same function the sidebar path uses. Without them a browser test could
  // only inspect pixels and would have to guess at the gate's verdict.
  // The Sidebar's own snapshot is the trigger for a session switch: it moves only
  // when the on-screen session changes, which is exactly when tabs must follow.
  if (typeof ctx.get === 'function') {
    ctx.inject?.(['sidebarRight'], () => {
      const right = ctx.get?.('sidebarRight') as { mounted?: { subscribe?: (listener: () => void) => () => void } } | undefined
      const mounted = right?.mounted
      const subscribe = mounted?.subscribe
      if (mounted === undefined || typeof subscribe !== 'function') return
      ctx.effect(() => subscribe.call(mounted, followMountedSession), 'a2ui-plus: follow mounted session')
      followMountedSession()
    })
  }

  const observability = globalThis as {
    __a2uiPlusExecutor?: RendererExecutor
    __a2uiPlusPlacement?: (requested: 'inline' | 'sidebar') => { placement: string; downgraded: boolean }
    __a2uiPlusStore?: (sessionId: string) => ClientSurfaceStore
    __a2uiPlusMountedSession?: () => string | undefined
    __a2uiPlusTabs?: TabRouter
    __a2uiPlusAdapter?: ViewAdapter
  }
  observability.__a2uiPlusExecutor = executor
  observability.__a2uiPlusPlacement = (requested) => {
    const width = typeof window === 'undefined' ? 1280 : window.innerWidth
    return effectivePlacement(requested, width)
  }
  // Observation only: the store and the router, so an end-to-end test can inject
  // a snapshot and see what the real sidebar does with it. Neither grants a
  // capability the plugin does not already have.
  observability.__a2uiPlusStore = (sessionId: string) => storeOf(sessionId)
  observability.__a2uiPlusMountedSession = mountedSession
  observability.__a2uiPlusTabs = tabs
  observability.__a2uiPlusAdapter = adapter
}

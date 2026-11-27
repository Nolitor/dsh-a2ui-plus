/**
 * The single mediator between the surface store and every view that paints it.
 *
 * Why this layer exists. Two views render one surface — the conversation card and
 * the Sidebar tab — and before this file each of them read the store itself and
 * sent actions itself. That produced exactly the defects this module removes:
 *
 * - A `sidebar` surface painted nowhere in the conversation (the card was
 *   replaced by an empty notice), because the inline view had no model of its own
 *   and its only source was the tool call's durable copy.
 * - One click could enqueue twice, once per view, with nothing comparing the two.
 * - A session switch left each view to notice on its own.
 *
 * So the store is subscribed here, once per surface and per session, and each view
 * receives a *derived model*: the tab gets the full surface, the card gets a
 * condensed one (title, summary rows) plus the id it needs to open its tab. Views
 * never touch the store and never send anything themselves.
 *
 * Everything is scoped: `subscribeInline`/`subscribeFull` take a surface id, an
 * action goes through one `dispatch`, and a mounted-session change tears every
 * subscription down before it can paint another conversation's data.
 */
import { ClientSurfaceStore, effectivePlacement, type ClientSurface, type Placement } from './surface-store.js'
import { validateToolArguments, applyMessageBatch, type SurfaceState } from '../shared/validate.js'
import { estimateExpansion } from '../shared/budget.js'
import { pointerGet } from '../shared/json.js'

/** Window in which a repeat of the same action is treated as a double click. */
export const ACTION_DEDUPE_MS = 200

/** Rows an inline summary shows before it says how many it left out. */
export const INLINE_ROW_LIMIT = 4

/** One row of the condensed inline model. */
export interface InlineRow {
  id: string
  /** What the row says, already resolved against the data model. */
  label: string
  /** The value beside it, when the component has one. */
  value?: string
}

/**
 * The condensed model the conversation card renders.
 *
 * Deliberately *not* a `SurfaceState`: the card is a summary, so it must not be
 * able to render the full graph by accident. `full` is the one surface it may
 * paint, and only when the placement actually is inline.
 */
export interface InlineModel {
  surfaceId: string
  /** The call or surface title, never empty once a surface exists. */
  title: string
  placement: Placement
  /** True while the surface belongs to a tab: the card then summarises. */
  condensed: boolean
  /** Number of components the surface declares, the card's own proof it is not empty. */
  componentCount: number
  /** Up to `INLINE_ROW_LIMIT` resolved rows, for the summary. */
  rows: InlineRow[]
  /** How many components the summary left out. */
  hiddenRows: number
  /** The store revision this model reflects. */
  revision: number
  /** The full surface, only when it may be painted in place. */
  full?: SurfaceState
}

/** The full model the Sidebar tab renders. */
export interface FullModel {
  surfaceId: string
  title: string
  placement: Placement
  revision: number
  /** The surface as stored, ready for the ordinary validator. */
  surface: ClientSurface
}

/** One action, as either view produces it. */
export interface ActionRequest {
  surfaceId: string
  /** The component the user clicked. */
  sourceComponentId: string
  /** The action name (`action.event.name`). */
  actionId: string
  /** The already-formatted message the agent receives. */
  text: string
  /** The session that owns the surface. */
  sessionId: string
}

/** What a dispatch produced. */
export type DispatchOutcome =
  | { kind: 'sent' }
  /** The same click arrived again inside the dedupe window; nothing was sent. */
  | { kind: 'duplicate' }
  /** The action named a session that is not the mounted one. */
  | { kind: 'cross-session' }
  | { kind: 'failed'; message: string }

/** What the adapter needs from the page. */
export interface ViewAdapterHost {
  /** The store for one session, or `undefined` when it is not on screen. */
  storeFor: (sessionId: string) => ClientSurfaceStore | undefined
  /** The session the right Sidebar is showing. */
  mountedSession: () => string | undefined
  /** Deliver an action message to the agent. */
  send: (sessionId: string, text: string) => Promise<void>
  /** Open (or focus) the tab that holds a surface. */
  openTab: (surfaceId: string, title: string, sessionId: string) => boolean
  /** A clock, so the dedupe window is testable without waiting. */
  now?: () => number
  /** Where refusals are reported. */
  warn?: (message: string, detail?: Record<string, unknown>) => void
}

/** Text of a dynamic string property, resolved against a data model. */
function textOf(value: unknown, model: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    const pointer = value.startsWith('/') ? value : undefined
    if (pointer === undefined) return value
    const resolved = pointerGet(model, pointer)
    return resolved.found ? String(resolved.value ?? '') : ''
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const pointer = record['@path'] ?? record.path
    if (typeof pointer === 'string') {
      const resolved = pointerGet(model, pointer.startsWith('/') ? pointer : `/${pointer}`)
      if (!resolved.found) return ''
      const resolvedValue = resolved.value
      return typeof resolvedValue === 'string' || typeof resolvedValue === 'number' ? String(resolvedValue) : ''
    }
  }
  return ''
}

/** Components whose label/value pair makes a good summary row. */
const SUMMARY_COMPONENTS = new Set(['Stat', 'Text', 'Progress'])

/**
 * Build the summary rows for one surface: label/value pairs, in declaration order.
 *
 * Exported because the card has two possible sources — the store (through
 * `inlineModelOf`) and, before the store knows the surface, the tool call's own
 * durable messages. Both must summarise identically or the card would change its
 * mind the moment a frame arrived.
 * @param state the folded surface.
 * @param limit how many rows to keep.
 */
export function summaryOf(state: SurfaceState, limit: number = INLINE_ROW_LIMIT): { rows: InlineRow[]; hidden: number } {
  const rows: InlineRow[] = []
  let candidates = 0
  for (const id of state.order) {
    const component = state.components.get(id)
    if (component === undefined) continue
    const name = String(component.component ?? '')
    if (!SUMMARY_COMPONENTS.has(name)) continue
    const label = textOf(component.label ?? component.title ?? component.text, state.dataModel)
    const value = textOf(component.value ?? component.delta ?? component.unit, state.dataModel)
    if (label === '' && value === '') continue
    candidates += 1
    if (rows.length >= limit) continue
    rows.push({ id, label, ...(value === '' ? {} : { value }) })
  }
  return { rows, hidden: Math.max(0, candidates - rows.length) }
}

/** The stored component map as a `SurfaceState`, for summary-only use. */
function stateFromStored(surface: ClientSurface): SurfaceState {
  const components = new Map<string, any>()
  for (const [id, component] of surface.components) components.set(id, component)
  return {
    surfaceId: surface.surfaceId,
    catalogId: 'dsh-a2ui/catalog/v1',
    components,
    order: [...components.keys()],
    dataModel: surface.dataModel as never,
    sendDataModel: false,
  }
}

/**
 * Derive the inline model from a stored surface.
 *
 * The fold runs the ordinary validator over the surface's own messages, so a card
 * and a tab cannot disagree about whether a payload is renderable: the same check
 * that guards the Host guards the summary.
 * @param surface the stored surface.
 * @param width the viewport width, for the placement downgrade.
 * @param fallbackTitle the localized plugin name.
 */
export function inlineModelOf(surface: ClientSurface, width: number, fallbackTitle: string): InlineModel {
  const effective = effectivePlacement(surface.placement, width)
  const title = surface.title !== undefined && surface.title !== '' ? surface.title : fallbackTitle
  const base: InlineModel = {
    surfaceId: surface.surfaceId,
    title,
    placement: effective.placement,
    condensed: effective.placement === 'sidebar',
    componentCount: surface.components.size,
    rows: [],
    hiddenRows: 0,
    revision: surface.revision,
  }
  if (Array.isArray(surface.messages) && surface.messages.length > 0) {
    const validation = validateToolArguments({ messages: surface.messages })
    if (validation.ok) {
      const folded = applyMessageBatch(new Map<string, SurfaceState>(), validation.messages)
      const state = folded.surfaces.get(surface.surfaceId)
      if (state !== undefined && estimateExpansion(state).reason === undefined) {
        const summary = summaryOf(state)
        return {
          ...base,
          componentCount: state.components.size,
          rows: summary.rows,
          hiddenRows: summary.hidden,
          // A condensed card must not carry the graph: the tab owns the full paint.
          ...(base.condensed ? {} : { full: state }),
        }
      }
    }
  }
  // The messages do not fold into a renderable surface (or there are none). The
  // card still summarises from the stored components, which is what keeps it from
  // being empty when a tab owns the surface's declaration.
  const summary = summaryOf(stateFromStored(surface))
  return { ...base, rows: summary.rows, hiddenRows: summary.hidden }
}

/**
 * The view mediator.
 *
 * One instance per page. It owns the store subscriptions, the derived models and
 * the only path an action takes out of the renderer.
 */
export class ViewAdapter {
  private readonly host: ViewAdapterHost
  private readonly now: () => number
  /** surface id -> the store it is subscribed to, with its disposer. */
  private readonly subscriptions = new Map<string, { sessionId: string; store: ClientSurfaceStore; dispose: () => void }>()
  /** Session the models and subscriptions belong to. */
  private sessionId: string | undefined
  /** Set once disposed: nothing may resubscribe afterwards. */
  private disposed = false
  /** Dedupe key -> last dispatch time. */
  private readonly lastDispatch = new Map<string, number>()
  /** Session id -> surface ids it has held, so a switch can prove nothing leaked. */
  private readonly surfaceOwners = new Map<string, Set<string>>()
  private readonly inlineListeners = new Map<string, Set<() => void>>()
  private readonly fullListeners = new Map<string, Set<() => void>>()
  private readonly changeListeners = new Set<() => void>()
  /** The localized plugin name, set once by the entry. */
  titleFallback = 'Generative UI'
  /** Bumped on every notification; see `viewTick`. */
  private tick = 0

  constructor(host: ViewAdapterHost) {
    this.host = host
    this.now = host.now ?? (() => Date.now())
  }

  /** The session the adapter is currently modelling. */
  currentSession(): string | undefined {
    return this.sessionId
  }

  /**
   * A counter that changes on every notification.
   *
   * A view renders from this instead of from a store revision: it is bumped for a
   * frame *and* for a session switch, which is what makes a switched session
   * repaint even when its surface ids happen to be unchanged.
   */
  viewTick(): number {
    return this.tick
  }

  /**
   * Point the adapter at the session on screen.
   *
   * A switch must tear down before it builds up: every subscription from the
   * previous session is released *and* that session's surfaces are forgotten, so
   * nothing derived from conversation A can be painted in conversation B, not even
   * for the frame in which the two stores overlap.
   * @param sessionId the session now on screen, or `undefined` for none.
   */
  onMountedSessionChanged(sessionId: string | undefined): void {
    if (this.disposed) return
    const next = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
    if (next === this.sessionId) return
    const previous = this.sessionId
    this.releaseAll()
    // An undefined mounted session is the empty store by definition: there is
    // nothing on screen, so nothing may be rendered from it.
    this.sessionId = next
    if (previous !== undefined) this.surfaceOwners.delete(previous)
    this.lastDispatch.clear()
    if (this.sessionId !== undefined) this.trackKnownSurfaces(this.sessionId)
    this.notifyAll()
  }

  /** The surface ids a session has held here (used to prove nothing leaked). */
  surfacesOf(sessionId: string): string[] {
    return [...(this.surfaceOwners.get(sessionId) ?? [])]
  }

  /** Read the condensed model for one surface. */
  inlineModel(surfaceId: string): InlineModel | undefined {
    const surface = this.surfaceOf(surfaceId)
    if (surface === undefined) return undefined
    return inlineModelOf(surface, this.width(), this.titleFallback)
  }

  /** Read the full model for one surface (the tab's input). */
  fullModel(surfaceId: string): FullModel | undefined {
    const surface = this.surfaceOf(surfaceId)
    if (surface === undefined) return undefined
    return {
      surfaceId: surface.surfaceId,
      title: surface.title !== undefined && surface.title !== '' ? surface.title : this.titleFallback,
      placement: surface.placement,
      revision: surface.revision,
      surface,
    }
  }

  /** Subscribe to one surface's condensed model. */
  subscribeInline(surfaceId: string, listener: () => void): () => void {
    this.ensure(surfaceId)
    return this.addListener(this.inlineListeners, surfaceId, listener)
  }

  /** Subscribe to one surface's full model. */
  subscribeFull(surfaceId: string, listener: () => void): () => void {
    this.ensure(surfaceId)
    return this.addListener(this.fullListeners, surfaceId, listener)
  }

  /** Subscribe to any change (the card's render counter). */
  subscribeAny(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  /**
   * Send one action to the agent. This is the only exit for a click.
   *
   * Two guards, in this order: a cross-session action is refused outright, and a
   * repeat of the same surfaceId + sourceComponentId + actionId inside
   * `ACTION_DEDUPE_MS` is dropped as a double click. Both views funnel through here,
   * so clicking the same button in the card and in the tab within the window reaches
   * the agent once.
   * @param request the action, already formatted.
   */
  async dispatch(request: ActionRequest): Promise<DispatchOutcome> {
    if (this.disposed) return { kind: 'failed', message: 'the renderer is shutting down' }
    if (this.sessionId === undefined || request.sessionId !== this.sessionId) {
      // Either the surface belongs to a conversation that is not on screen, or the
      // adapter has not been pointed at a session yet.
      return { kind: 'cross-session' }
    }
    const key = `${request.surfaceId}|${request.sourceComponentId}|${request.actionId}`
    const at = this.now()
    const last = this.lastDispatch.get(key)
    if (last !== undefined && at - last < ACTION_DEDUPE_MS) return { kind: 'duplicate' }
    this.lastDispatch.set(key, at)
    try {
      await this.host.send(request.sessionId, request.text)
      return { kind: 'sent' }
    } catch (error) {
      this.lastDispatch.delete(key)
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Open (or focus) the tab for a surface.
   *
   * A no-op when the surface belongs to a session that is not on screen: the tab
   * would land in a column nobody is looking at.
   * @param surfaceId the surface to show in the side column.
   */
  openInSidebar(surfaceId: string): boolean {
    const model = this.fullModel(surfaceId)
    if (model === undefined || this.sessionId === undefined) return false
    return this.host.openTab(surfaceId, model.title, this.sessionId)
  }

  /** Release every subscription and stop waking anything (plugin teardown). */
  dispose(): void {
    this.disposed = true
    this.releaseAll()
    this.inlineListeners.clear()
    this.fullListeners.clear()
    this.changeListeners.clear()
    this.lastDispatch.clear()
    this.surfaceOwners.clear()
    this.sessionId = undefined
  }

  /** The surface a model read should paint, or `undefined` off-session. */
  private surfaceOf(surfaceId: string): ClientSurface | undefined {
    if (this.sessionId === undefined) return undefined
    const store = this.host.storeFor(this.sessionId)
    if (store === undefined) return undefined
    return store.get(surfaceId)
  }

  /** Subscribe to a surface's store notifications if not already. */
  private ensure(surfaceId: string): void {
    if (this.disposed || this.sessionId === undefined) return
    const store = this.host.storeFor(this.sessionId)
    if (store === undefined) return
    const existing = this.subscriptions.get(surfaceId)
    if (existing !== undefined) {
      // Same store, same session: nothing to do. A different store means the
      // session was rebuilt, so the old subscription is stale by identity.
      if (existing.store === store && existing.sessionId === this.sessionId) return
      existing.dispose()
    }
    const owner = this.sessionId
    const dispose = store.subscribeSurface(surfaceId, () => {
      // A frame for a session that is no longer on screen must not paint, even if a
      // listener were somehow still attached.
      if (this.sessionId !== owner) return
      this.notifySurface(surfaceId)
    })
    this.subscriptions.set(surfaceId, { sessionId: owner, store, dispose })
    this.track(surfaceId, owner)
  }

  /** Record that a session holds a surface (used to prove nothing leaked). */
  private track(surfaceId: string, sessionId: string): void {
    let owned = this.surfaceOwners.get(sessionId)
    if (owned === undefined) {
      owned = new Set()
      this.surfaceOwners.set(sessionId, owned)
    }
    owned.add(surfaceId)
  }

  /** Remember every surface the session's store already holds. */
  private trackKnownSurfaces(sessionId: string): void {
    const store = this.host.storeFor(sessionId)
    if (store === undefined) return
    for (const surface of store.list()) this.track(surface.surfaceId, sessionId)
  }

  private releaseAll(): void {
    for (const subscription of this.subscriptions.values()) {
      try {
        subscription.dispose()
      } catch {
        // A disposer that throws must not strand the rest.
      }
    }
    this.subscriptions.clear()
  }

  private addListener(map: Map<string, Set<() => void>>, surfaceId: string, listener: () => void): () => void {
    let set = map.get(surfaceId)
    if (set === undefined) {
      set = new Set()
      map.set(surfaceId, set)
    }
    set.add(listener)
    return () => {
      const current = map.get(surfaceId)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) map.delete(surfaceId)
    }
  }

  private notifySurface(surfaceId: string): void {
    this.tick += 1
    if (this.sessionId !== undefined) this.track(surfaceId, this.sessionId)
    for (const map of [this.inlineListeners, this.fullListeners]) {
      for (const listener of [...(map.get(surfaceId) ?? [])]) this.call(listener)
    }
    for (const listener of [...this.changeListeners]) this.call(listener)
  }

  private notifyAll(): void {
    this.tick += 1
    for (const map of [this.inlineListeners, this.fullListeners]) {
      for (const set of map.values()) for (const listener of [...set]) this.call(listener)
    }
    for (const listener of [...this.changeListeners]) this.call(listener)
  }

  private call(listener: () => void): void {
    try {
      listener()
    } catch {
      // One broken subscriber must not stop the others.
    }
  }

  private width(): number {
    return typeof window === 'undefined' ? 1280 : window.innerWidth
  }
}


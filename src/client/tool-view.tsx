/**
 * The `tool.call.toolview` component for the `a2ui` tool.
 *
 * It turns the tool call's own arguments (or, once settled, the durable `meta`
 * copy) into surfaces, renders them, and routes user actions back to the agent
 * as a normal queued user message. Nothing is persisted in plugin memory: a
 * reopened conversation re-renders from the session log alone, and no action is
 * ever replayed on load.
 */
import * as React from 'react'
import { h } from './h.js'
import type { A2UIComponent, SurfaceState, SurfaceTouch } from '../shared/validate.js'
import { validateToolArguments, applyMessageBatch } from '../shared/validate.js'
import { COMPONENT_BY_NAME } from '../shared/catalog.js'
import type { JsonValue } from '../shared/json.js'
import { interactionFor, modelFor, setInteractionState, stateKey, storeVersion, subscribeStore, writeModel } from './model-store.js'
import type { Violation } from '../shared/schema.js'
import { FUNCTIONS } from '../shared/functions.js'
import { estimateExpansion } from '../shared/budget.js'
import { foldStreaming } from '../shared/stream.js'
import { watchStream, type SessionEventSource } from './stream-store.js'
import { A2UISurface } from './surface.js'
import type { InteractionState, Scope, SurfaceView } from './context.js'
import { useClaimCopy, useCopyClaimed } from './claims-react.js'
import { resolveValue, type ResolveContext } from '../shared/binding.js'
import { buildAction } from './action.js'
import type { ActionRequest, DispatchOutcome, InlineModel, ViewAdapter } from './view-adapter.js'

/** What the plugin needs from the browser shell (locale + prompt delivery). */
export interface ClientRuntime {
  t: (key: string) => string
  locale: () => string
  sendPrompt: (sessionId: string, text: string) => Promise<void>
  streamSource?: (sessionId: string) => SessionEventSource | undefined
  /**
   * The live surface store for a session.
   *
   * Present when the out-of-turn transport is installed. A view reads its surface
   * from here first, which is what makes a repeat call update the card in place
   * instead of rendering a second copy beside it.
   */
  surfaceStore?: (sessionId: string) =>
    | {
        get: (surfaceId: string) =>
          | { revision: number; dataModel: unknown; messages?: unknown[]; placement?: 'inline' | 'sidebar'; title?: string }
          | undefined
        subscribe?: (listener: () => void) => () => void
        currentRevision?: () => number
      }
    | undefined
  /** Open the downlink for a session (idempotent). */
  connectDownlink?: (sessionId: string) => void
  /**
   * The view mediator.
   *
   * Present when the out-of-turn layer is installed. A view reads its derived
   * model from here and sends its actions here; it never subscribes to the store
   * and never queues a message itself.
   */
  adapter?: ViewAdapter
  /**
   * Send one action through the mediator's single dispatch path.
   *
   * Both views (the card and the tab) call this, which is what makes one click
   * reach the agent once even when it is repeated in the other view.
   */
  dispatchAction?: (request: ActionRequest) => Promise<DispatchOutcome>
  /**
   * Open or focus the Sidebar tab for one surface.
   *
   * `openTab` seeded with `a2ui:{surfaceId}` is the only sidebar call this plugin
   * makes; a second call focuses the existing tab rather than creating another.
   */
  openSurfaceTab?: (surfaceId: string) => boolean
  /**
   * The session a view should read, resolved in one place.
   *
   * `sessionId` wins when the slot supplied one; otherwise this falls back to the
   * session the right Sidebar is showing. A tab body is mounted without a
   * `sessionId`, which is why the fallback exists at all.
   */
  sessionFor?: (sessionId: string | undefined) => string | undefined
  /**
   * Fold one tool result's messages into the store if that surface is absent.
   *
   * Idempotent: a surface the downlink already delivered is left alone, so a
   * later frame stays authoritative.
   */
  seedSurface?: (
    sessionId: string,
    surfaceId: string,
    messages: unknown[],
    placement: 'inline' | 'sidebar',
    title: string | undefined,
  ) => void
}

interface ToolBlockLike {
  kind?: string
  phase?: string
  callId?: string
  name?: string
  argsRaw?: string
  call?: { name?: string; argsRaw?: string } | null
  content?: unknown
  isError?: boolean
  error?: unknown
  meta?: Record<string, unknown>
  args?: { get?: (key: string) => unknown } | unknown
}

export interface ToolViewProps {
  callId: string
  toolName: string
  phase?: 'preparing' | 'start' | 'result'
  block?: ToolBlockLike
  sessionId?: string
  runtime: ClientRuntime
  /**
   * Which host is rendering: the process row (`row`) or the turn tail (`tail`).
   * A `tail` copy claims itself, and the `row` copy degrades to a one-line
   * pointer only while that claim exists — so the interface can never disappear.
   */
  mode?: 'row' | 'tail'
  /** Force the one-line pointer (used by the render harness). */
  compact?: boolean
  /**
   * Render only the named surface, reading it live from the socket store.
   *
   * This is the sidebar tab's mode: a tab owns one surface, so it must not fold a
   * tool call's whole batch and must follow `STATE_DELTA` as it arrives.
   */
  surfaceOnly?: boolean
  /** The surface to render when `surfaceOnly` is set. */
  surfaceId?: string
}

interface Payload {
  title?: string
  presentation?: unknown
  messages: unknown[]
  /** Set when a live surface is expected but has not arrived yet. */
  pending?: boolean
  origin: 'meta' | 'args' | 'none'
  /** Set when the payload could not be read at all. */
  readError?: string
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const entry of content) {
    if (entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text') {
      const value = (entry as Record<string, unknown>).text
      if (typeof value === 'string') parts.push(value)
    }
  }
  return parts.join('\n')
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Read the A2UI payload from whichever stage the call is in. */
function readPayload(props: ToolViewProps): Payload {
  const block = props.block
  if (block === undefined) return { messages: [], origin: 'none' }
  const meta = block.meta
  if (meta !== undefined && meta !== null && meta.kind === 'a2ui' && Array.isArray(meta.messages)) {
    return {
      messages: meta.messages as unknown[],
      title: typeof meta.title === 'string' ? meta.title : undefined,
      presentation: meta.presentation,
      origin: 'meta',
    }
  }
  const raw = props.phase === 'result' ? block.call?.argsRaw ?? block.argsRaw : block.argsRaw
  const parsed = parseJson(raw)
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.messages)) {
      return {
        messages: record.messages,
        title: typeof record.title === 'string' ? record.title : undefined,
        presentation: record.presentation,
        origin: 'args',
      }
    }
  }
  if (meta !== undefined && meta !== null && meta.messagesOmitted === true) {
    return { messages: [], origin: 'none', readError: 'the replay copy was omitted because the payload exceeded the meta budget' }
  }
  return { messages: [], origin: 'none' }
}

interface RenderedSurface {
  state: SurfaceState
  created: boolean
  componentCount: number
}

interface Analysis {
  ok: boolean
  errors: Violation[]
  warnings: string[]
  surfaces: RenderedSurface[]
  updatedOnly: string[]
  deleted: string[]
}

function analyse(payload: Payload): Analysis {
  if (payload.messages.length === 0) {
    return { ok: true, errors: [], warnings: [], surfaces: [], updatedOnly: [], deleted: [] }
  }
  const validation = validateToolArguments({ messages: payload.messages, presentation: payload.presentation })
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings, surfaces: [], updatedOnly: [], deleted: [] }
  }
  const folded = applyMessageBatch(new Map<string, SurfaceState>(), validation.messages)
  const surfaces: RenderedSurface[] = []
  const updatedOnly: string[] = []
  const deleted: string[] = []
  for (const touch of folded.touches) {
    const state = folded.surfaces.get(touch.surfaceId)
    if (touch.deleted) {
      deleted.push(touch.surfaceId)
      continue
    }
    if (state === undefined) continue
    if (touch.created) {
      // The Host applies the same budget; re-checking here keeps an old or
      // foreign payload from expanding into a huge tree.
      const estimate = estimateExpansion(state)
      if (estimate.reason !== undefined) {
        return { ok: false, errors: [{ path: `/surfaces/${touch.surfaceId}${estimate.path ?? ''}`, message: estimate.reason }], warnings: validation.warnings, surfaces: [], updatedOnly: [], deleted: [] }
      }
      surfaces.push({ state, created: true, componentCount: state.components.size })
    } else if (touch.changedComponentIds.length > 0 || touch.dataModelChanged) {
      updatedOnly.push(touch.surfaceId)
    }
  }
  return { ok: true, errors: [], warnings: validation.warnings, surfaces, updatedOnly, deleted }
}

/**
 * The condensed card the conversation shows for one surface.
 *
 * A `sidebar` surface is not hidden from the conversation, and it is not painted
 * there in full either: the card carries the title, a few resolved rows and the
 * count, plus the control that puts the full interface in the side column. This is
 * what replaced the empty notice — the card is derived from the same store the tab
 * reads, so it can never disagree with it and can never be empty while the surface
 * exists.
 *
 * @param props.model the derived summary.
 * @param props.t the localized strings.
 * @param props.onOpenSidebar opens (or focuses) the tab.
 */
function InlineSummary(props: {
  model: InlineModel
  t: (key: string) => string
  onOpenSidebar: () => void
}): ReturnType<typeof h> {
  const { model, t } = props
  const rows: Array<ReturnType<typeof h>> = model.rows.map((row) =>
    h(
      'div',
      { key: row.id, className: 'a2ui-inline-row' },
      h('span', { className: 'a2ui-inline-row-label' }, row.label),
      row.value === undefined ? null : h('span', { className: 'a2ui-inline-row-value' }, row.value),
    ),
  )
  if (model.hiddenRows > 0) {
    rows.push(h('div', { key: 'more', className: 'a2ui-inline-more' }, t('inlineMoreRows').replace('{count}', String(model.hiddenRows))))
  }
  return h(
    'div',
    { className: 'a2ui-root', 'data-a2ui-inline': 'summary' },
    h(
      'div',
      { className: 'a2ui-card' },
      h(
        'div',
        { className: 'a2ui-card-head' },
        sparkle('a2ui-card-spark'),
        h('span', { className: 'a2ui-card-title' }, model.title),
        h('span', { className: 'a2ui-inline-count' }, t('inlineComponents').replace('{count}', String(model.componentCount))),
      ),
      h(
        'div',
        { className: 'a2ui-card-body' },
        rows.length === 0 ? null : h('div', { className: 'a2ui-inline-rows' }, ...rows),
        h(
          'button',
          { type: 'button', className: 'a2ui-btn a2ui-inline-open', onClick: props.onOpenSidebar },
          t('openInSidebar'),
        ),
      ),
    ),
  )
}

function sparkle(className: string): ReturnType<typeof h> {
  return h(
    'span',
    { className, 'aria-hidden': true },
    h(
      'svg',
      { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: 'M7 1.9l1.4 3.6 3.6 1.4-3.6 1.4L7 11.9 5.6 8.3 2 6.9l3.6-1.4L7 1.9z' }),
      h('path', { d: 'M12.6 10.6l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5z' }),
    ),
  )
}

function Notice(props: { title: string; body?: string; error?: boolean }): ReturnType<typeof h> {
  return h(
    'div',
    { className: `a2ui-notice${props.error === true ? ' a2ui-notice-error' : ''}`, role: props.error === true ? 'alert' : 'status' },
    h('div', null, h('div', { className: 'a2ui-notice-title' }, props.title), props.body === undefined || props.body === '' ? null : h('div', { className: 'a2ui-notice-body' }, props.body)),
  )
}

function formatViolations(errors: Violation[]): string {
  return errors
    .slice(0, 10)
    .map((error) => `${error.path === '' ? 'arguments' : error.path}: ${error.message}`)
    .join('\n')
}

const emptyStream = {
  subscribe: () => () => {},
  getSnapshot: () => undefined,
  getServerSnapshot: () => undefined,
}

function useStreamedArguments(source: SessionEventSource | undefined, callId: string): string | undefined {
  const stream = React.useMemo(() => source === undefined ? emptyStream : watchStream(source, callId), [source, callId])
  return React.useSyncExternalStore(stream.subscribe, stream.getSnapshot, stream.getServerSnapshot)
}

/** Placeholder body shown until the first component (and its root) arrives. */
function Skeleton(): ReturnType<typeof h> {
  return h(
    'div',
    { className: 'a2ui-skel', 'aria-hidden': true },
    h('span', { className: 'a2ui-skel-line a2ui-skel-w70' }),
    h('span', { className: 'a2ui-skel-line a2ui-skel-w92' }),
    h('span', { className: 'a2ui-skel-line a2ui-skel-w60' }),
    h('span', { className: 'a2ui-skel-block' }),
  )
}

/**
 * Preview-only error boundary.
 *
 * The streaming fold validates every closed component, so a preview should never
 * throw; this is the backstop that keeps a slip in one renderer from blanking the
 * whole slot. It is deliberately *not* wrapped around the settled card: a real
 * result must keep surfacing its own errors.
 *
 * The class is created on first render rather than at module load, so merely
 * loading the bundle never depends on `React.Component` being present.
 */
interface PreviewBoundaryProps {
  readonly text: string
  readonly children?: unknown
}

type PreviewBoundaryType = new (props: PreviewBoundaryProps) => React.Component<PreviewBoundaryProps, { failed: boolean }>

let previewBoundaryType: PreviewBoundaryType | undefined

function previewBoundary(): PreviewBoundaryType {
  if (previewBoundaryType !== undefined) return previewBoundaryType
  class PreviewBoundary extends React.Component<PreviewBoundaryProps, { failed: boolean }> {
    override state = { failed: false }

    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true }
    }

    override componentDidUpdate(previous: PreviewBoundaryProps): void {
      // A new fragment may well fix whatever threw: recover instead of staying
      // blank for the rest of the call.
      if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false })
    }

    override render(): React.ReactNode {
      return this.state.failed ? Skeleton() : (this.props.children as React.ReactNode)
    }
  }
  previewBoundaryType = PreviewBoundary as unknown as PreviewBoundaryType
  return previewBoundaryType
}

/** Props of the card drawn while the arguments are still arriving. */
interface StreamingCardProps {
  callId: string
  title?: string
  compactPresentation: boolean
  surfaces: readonly SurfaceState[]
  text: string
  locale: string
  now: number
  t: (key: string) => string
}

/**
 * The card shown during `preparing`.
 *
 * Its body is inert: the preview renders unvalidated components, so Tab, Enter,
 * Space and the mouse must not reach a control before the call settles. `inert`
 * is set through the DOM because React 18 does not type it; a host that rejects
 * the attribute simply loses the extra guard, since submit/write are also stubs
 * here and the settled card is what can actually act.
 */
function StreamingCard(props: StreamingCardProps): ReturnType<typeof h> {
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const node = bodyRef.current
    if (node === null) return undefined
    node.setAttribute('inert', '')
    return () => node.removeAttribute('inert')
  }, [])

  const view = (state: SurfaceState): SurfaceView => ({
    surfaceId: state.surfaceId,
    callId: props.callId,
    state,
    // The streamed data model is authoritative for this frame; edits and actions
    // belong to the settled card.
    model: state.dataModel,
    locale: props.locale,
    now: props.now,
    interaction: { state: 'idle' },
    t: props.t,
    streaming: true,
    setValue: () => {},
    submit: () => {},
    runLocal: () => {},
  })

  const bodies: Array<ReturnType<typeof h>> =
    props.surfaces.length === 0
      ? [h('div', { key: 'skeleton', className: 'a2ui-stack' }, Skeleton())]
      : props.surfaces.map((state) =>
          h(
            'div',
            { key: state.surfaceId, className: 'a2ui-stack' },
            props.surfaces.length > 1 ? h('span', { className: 'a2ui-caption' }, state.surfaceId) : null,
            h(A2UISurface, { view: view(state) }),
          ),
        )

  return h(
    'div',
    { className: 'a2ui-root' },
    h(
      'div',
      {
        className: props.compactPresentation ? 'a2ui-compact a2ui-card-streaming' : 'a2ui-card a2ui-card-streaming',
        'aria-busy': true,
      },
      h(
        'div',
        { className: props.compactPresentation ? 'a2ui-compact-head' : 'a2ui-card-head' },
        props.compactPresentation ? null : sparkle('a2ui-card-spark'),
        props.title === undefined ? null : h('span', { className: 'a2ui-card-title' }, props.title),
        h('span', { className: 'a2ui-card-state' }, props.t('streaming')),
      ),
      h(
        'div',
        { className: props.compactPresentation ? 'a2ui-compact-body' : 'a2ui-card-body', ref: bodyRef },
        h(previewBoundary(), { text: props.text }, h('div', { className: 'a2ui-stack' }, ...bodies)),
      ),
    ),
  )
}

/** Build the user message that carries an A2UI action to the agent. */
export { formatActionPrompt } from './action.js'

function openExternal(url: string): void {
  if (!/^https?:\/\//iu.test(url)) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Render one `a2ui` tool call.
 *
 * A tool call is a self-contained surface snapshot: the renderer folds that
 * call's messages only, which keeps rendering deterministic and replay-safe.
 * Cross-call updates therefore arrive as a later card (see README, "Known
 * limitations").
 */
/**
 * Build the payload for one live surface.
 *
 * The surface store holds the patched data model and the declared messages; the
 * fold below then runs the ordinary validator over them, so a tab and a card
 * cannot disagree about whether a payload is renderable.
 * @param surfaceId the surface to project.
 * @param surface the live copy, when the store has one.
 */
function surfacePayload(
  surfaceId: string,
  surface: { revision: number; dataModel: unknown; messages?: unknown[] } | undefined,
): Payload {
  if (surface === undefined) {
    // A tab can open before its first snapshot arrives (the reader clicked
    // "open" while the socket was still connecting). `pending` renders the
    // skeleton instead of the "nothing to show" state, which would read as a
    // failure.
    return { messages: [], origin: 'none', pending: true }
  }
  // The surface's own messages carry its component tree. Rebuilding a
  // `createSurface` from the data model alone produced an empty declaration, so
  // the tab rendered nothing — the components have to come from here.
  if (Array.isArray(surface.messages) && surface.messages.length > 0) {
    return { messages: surface.messages, origin: 'meta' }
  }
  return { messages: [], origin: 'none', pending: true }
}

/**
 * Subscribe to one session's live surface store.
 *
 * Returns a counter that changes when a frame landed, which is all React needs to
 * re-read the surface. A missing store (a profile without the transport) keeps the
 * transcript copy as the only source.
 * @param runtime client runtime carrying the store accessor.
 * @param sessionId the session to follow.
 */
function useSurfaceVersion(runtime: ClientRuntime, sessionId: string | undefined): number {
  const store = sessionId === undefined ? undefined : runtime.surfaceStore?.(sessionId)
  return React.useSyncExternalStore(
    (listener: () => void) => {
      if (store === undefined || typeof store.subscribe !== 'function') return () => {}
      return store.subscribe(listener)
    },
    () => (store === undefined ? 0 : store.currentRevision?.() ?? 0),
    () => 0,
  )
}

export function A2UIToolView(props: ToolViewProps): ReturnType<typeof h> | null {
  const { runtime, sessionId } = props
  const mode = props.mode ?? 'row'
  const t = runtime.t
  // A sidebar tab owns one surface and follows the socket; a conversation card
  // owns a whole call and folds its own messages. Both read through `payload` so
  // everything below renders one shape.
  const surfaceOnly = props.surfaceOnly === true && props.surfaceId !== undefined
  // The downlink has to be opened by someone, and this view is the first place a
  // session is real in the browser. `connect()` is idempotent, so a row, a tail
  // and a tab for the same session share one socket.
  // A sidebar tab body is mounted with no `sessionId` (measured: the slot passes
  // `undefined`), so the view resolves the session on screen itself instead of
  // rendering nothing. Inside the conversation the prop is set and wins.
  // The plugin resolves this in exactly one place (`sessionFor`); the view does
  // not re-implement the chain, because two resolutions meant a test could pass
  // while either one was missing.
  const resolvedSessionId = runtime.sessionFor?.(sessionId) ?? sessionId
  // The tab is mounted without a session, so its own id is the resolved one. The
  // dispatch guard compares against the adapter's session, which is the same value.
  React.useEffect(() => {
    if (resolvedSessionId !== undefined) runtime.connectDownlink?.(resolvedSessionId)
  }, [resolvedSessionId, runtime])

  // Seed the store from the call's own durable copy when the downlink has not
  // delivered the surface (a reloaded transcript, a profile without the
  // transport, or the moment before the socket opens). Without this the store —
  // and therefore the tab — exists only when a live frame happens to arrive.
  React.useEffect(() => {
    if (resolvedSessionId === undefined || props.phase !== 'result' || surfaceOnly) return
    const store = runtime.surfaceStore?.(resolvedSessionId)
    const seed = runtime.seedSurface
    if (store === undefined || seed === undefined) return
    const block = props.block
    const meta = (block?.meta ?? {}) as { kind?: unknown; messages?: unknown; title?: unknown; placement?: unknown }
    if (meta.kind !== 'a2ui' || !Array.isArray(meta.messages)) return
    const placement = meta.placement === 'sidebar' ? 'sidebar' : 'inline'
    for (const surface of ((block?.meta as { surfaces?: unknown })?.surfaces ?? []) as Array<{ surfaceId?: string; deleted?: boolean }>) {
      if (typeof surface.surfaceId !== 'string' || surface.deleted === true) continue
      seed(resolvedSessionId, surface.surfaceId, meta.messages as unknown[], placement, typeof meta.title === 'string' ? meta.title : undefined)
    }
  }, [resolvedSessionId, props.phase, props.block, surfaceOnly, runtime])
  const surfaceVersion = useSurfaceVersion(runtime, resolvedSessionId)
  const liveSurface = surfaceOnly ? runtime.surfaceStore?.(resolvedSessionId ?? '')?.get(props.surfaceId as string) : undefined
  // The surface ids this call produced, from its durable copy. A `sidebar` call
  // lists them there, which is how the conversation knows what to summarise.
  const callSurfaceIds = React.useMemo(() => {
    const ids = ((props.block?.meta ?? {}) as { surfaces?: unknown }).surfaces
    if (!Array.isArray(ids)) return [] as string[]
    const out: string[] = []
    for (const entry of ids) {
      const id = typeof entry === 'string' ? entry : (entry as { surfaceId?: string } | undefined)?.surfaceId
      if (typeof id === 'string' && id !== '') out.push(id)
    }
    return out
  }, [props.block])

  // The adapter's own counter: it moves for a frame *and* for a session switch, so
  // a switched conversation repaints even when the surface ids are unchanged.
  const adapterTick = React.useSyncExternalStore(
    (listener: () => void) => (runtime.adapter === undefined ? () => {} : runtime.adapter.subscribeAny(listener)),
    () => runtime.adapter?.viewTick() ?? 0,
    () => 0,
  )
  const inlineModels = React.useMemo(() => {
    void adapterTick
    void surfaceVersion
    const adapter = runtime.adapter
    if (surfaceOnly || adapter === undefined) return [] as InlineModel[]
    const models: InlineModel[] = []
    for (const surfaceId of callSurfaceIds) {
      const model = adapter.inlineModel(surfaceId)
      if (model !== undefined) models.push(model)
    }
    return models
  }, [surfaceOnly, runtime, callSurfaceIds, adapterTick, surfaceVersion])
  // A surface owned by a tab still renders here — as the condensed card. Painting
  // the full graph twice is what this replaces: the tab follows deltas, the card
  // summarises the same store, and the control below puts the tab on screen.
  // Only a `sidebar` placement takes the condensed path. An `inline` surface keeps
  // rendering its own graph here, exactly as before: this change adds the missing
  // card, it does not reroute the one that already worked.
  const condensed = inlineModels.find((model) => model.condensed)

  const payload = React.useMemo(() => {
    if (surfaceOnly) return surfacePayload(props.surfaceId as string, liveSurface)
    if (condensed !== undefined) return { messages: [], origin: 'none' as const, pending: false }
    return readPayload(props)
  }, [surfaceOnly, props.surfaceId, surfaceVersion, props.block, props.phase, condensed])
  const analysis = React.useMemo(() => analyse(payload), [payload])
  const now = React.useMemo(() => Date.now(), [props.callId])

  // While the call is being prepared the arguments arrive as raw fragments, so
  // the card is drawn from what has already closed (see `shared/stream.ts`).
  const preparing = props.phase === 'preparing'
  const source = preparing && resolvedSessionId !== undefined ? runtime.streamSource?.(resolvedSessionId) : undefined
  const streamedText = useStreamedArguments(source, props.callId)
  const streamed = React.useMemo(
    () => (streamedText === undefined || streamedText === '' ? undefined : foldStreaming(streamedText)),
    [streamedText],
  )

  // The tail copy claims the call; the row copy steps aside only while that
  // claim is held, and automatically restores the card when the tail unmounts.
  const isErrorResult = props.phase === 'result' && props.block?.isError === true
  const claimedElsewhere = useCopyClaimed(resolvedSessionId, props.callId)
  useClaimCopy(resolvedSessionId, props.callId, mode === 'tail' && !isErrorResult)
  const compact = props.compact ?? (mode === 'row' && claimedElsewhere && props.phase === 'result')

  // Edits and action state live in a store keyed by session + call + surface, so
  // the row and the turn tail show the same values when the card changes hands.
  React.useSyncExternalStore(subscribeStore, storeVersion, storeVersion)
  /** One in-flight send per (surface, component): a double click enqueues once. */
  const inFlight = React.useRef<Set<string>>(new Set())
  const keyFor = React.useCallback((surfaceId: string) => stateKey(resolvedSessionId, props.callId, surfaceId), [resolvedSessionId, props.callId])

  const locale = runtime.locale()

  const setValue = React.useCallback(
    (surfaceId: string, pointer: string, value: JsonValue) => {
      writeModel(keyFor(surfaceId), pointer, value)
    },
    [keyFor],
  )

  const setInteraction = React.useCallback(
    (surfaceId: string, state: InteractionState) => {
      setInteractionState(keyFor(surfaceId), state)
    },
    [keyFor],
  )

  const submit = React.useCallback(
    (
      surfaceId: string,
      scope: Scope,
      component: A2UIComponent,
      name: string,
      contextSpec: Record<string, unknown>,
      userMessage?: string,
    ) => {
      // The tab has no `sessionId` prop; the resolved one is what its store and its
      // action belong to, so that is what the guard must use.
      if (resolvedSessionId === undefined) {
        setInteraction(surfaceId, { state: 'error', message: t('sendFailed') })
        return
      }
      const requestKey = `${surfaceId}\u0000${component.id}`
      if (inFlight.current.has(requestKey)) return
      inFlight.current.add(requestKey)
      // The scope carries the template row, so a row button resolves its own item.
      const outcome = buildAction({
        surfaceId,
        component,
        name,
        contextSpec,
        dataModel: modelFor(keyFor(surfaceId), {}),
        item: scope.item,
        index: scope.index,
        locale,
        now: Date.now(),
        userMessage,
      })
      if (outcome.kind === 'refused') {
        inFlight.current.delete(requestKey)
        setInteraction(surfaceId, outcome.state)
        return
      }
      setInteraction(surfaceId, { state: 'sending' })
      // One exit for every action, whichever view produced it. The mediator owns the
      // 200ms idempotency window and the cross-session refusal, so a click repeated
      // in the card and in the tab reaches the agent once.
      const dispatch =
        runtime.dispatchAction === undefined
          ? (request: ActionRequest): Promise<DispatchOutcome> =>
              runtime.sendPrompt(request.sessionId, request.text).then(
                () => ({ kind: 'sent' as const }),
                (cause: unknown) => ({ kind: 'failed' as const, message: cause instanceof Error ? cause.message : String(cause) }),
              )
          : runtime.dispatchAction
      void dispatch({
        surfaceId,
        sourceComponentId: component.id,
        actionId: name,
        text: outcome.text,
        sessionId: resolvedSessionId as string,
      }).then((result) => {
        if (result.kind === 'sent') {
          setInteraction(surfaceId, { state: 'sent' })
          return
        }
        // A duplicate is not a failure: the first click already sent it, so the card
        // shows the same "sent" state instead of inviting a third click.
        if (result.kind === 'duplicate') {
          setInteraction(surfaceId, { state: 'sent' })
          return
        }
        // A refused or failed send becomes editable again so the user can retry.
        inFlight.current.delete(requestKey)
        const message =
          result.kind === 'cross-session'
            ? t('crossSessionAction')
            : result.kind === 'failed'
              ? result.message
              : t('sendFailed')
        setInteraction(surfaceId, { state: 'error', message })
      })
    },
    [keyFor, locale, runtime, resolvedSessionId, setInteraction, t],
  )

  const runLocal = React.useCallback(
    (surfaceId: string, scope: Scope, component: A2UIComponent, call: unknown) => {
      const resolveContext: ResolveContext = {
        dataModel: modelFor(keyFor(surfaceId), {}),
        item: scope.item,
        index: scope.index,
        locale,
        now: Date.now(),
      }
      const record = call as Record<string, unknown>
      const name = (record['@call'] ?? record.call) as string | undefined
      if (name === undefined) return
      const result = resolveValue(call, resolveContext)
      if (result !== null && typeof result === 'object' && '__a2uiOpenUrl' in (result as object)) {
        openExternal(String((result as Record<string, unknown>).__a2uiOpenUrl))
        return
      }
      if (name === 'openUrl') return
      // Any other local function only affects local state, which the data model
      // already owns; there is nothing further to do.
      void component
      void FUNCTIONS
    },
    [keyFor, locale],
  )

  const makeView = (surface: SurfaceState): SurfaceView => ({
    surfaceId: surface.surfaceId,
    callId: props.callId,
    state: surface,
    model: modelFor(keyFor(surface.surfaceId), surface.dataModel),
    locale,
    now,
    interaction: interactionFor(keyFor(surface.surfaceId)),
    t,
    setValue: (pointer, value) => setValue(surface.surfaceId, pointer, value),
    submit: (scope, component, name, context, userMessage) => submit(surface.surfaceId, scope, component, name, context, userMessage),
    runLocal: (scope, component, call) => runLocal(surface.surfaceId, scope, component, call),
  })

  // Stage: the arguments are still arriving. The card grows out of what has
  // already closed, never turns into an error notice (a half-written payload is
  // unfinished, not wrong) and never lets a control be operated.
  if (preparing) {
    const compactPresentation = streamed?.presentation === 'compact'
    return h(StreamingCard, {
      callId: props.callId,
      title: streamed?.title ?? (compactPresentation ? undefined : t('rendering')),
      compactPresentation,
      surfaces: streamed === undefined || streamed.stopped ? [] : streamed.surfaces,
      text: streamedText ?? '',
      locale,
      now,
      t,
    })
  }

  const header = h(
    'div',
    { className: 'a2ui-card-head' },
    sparkle('a2ui-card-spark'),
    h('span', { className: 'a2ui-card-title' }, payload.title ?? t('title')),
  )

  if (isErrorResult) {
    if (mode === 'tail') return null
    const errorText = textOfContent(props.block?.content).trim()
    const reason = errorText.split(/\r?\n/u, 1)[0] || payload.title || t('title')
    return h(
      'div',
      { className: 'a2ui-root' },
      h(
        'details',
        { className: 'a2ui-failure' },
        h(
          'summary',
          { className: 'a2ui-pointer' },
          h('span', { className: 'a2ui-pointer-text' }, reason),
          h('span', { className: 'a2ui-pointer-meta' }, t('failedCompact')),
        ),
        h('pre', { className: 'a2ui-notice-body a2ui-failure-details' }, errorText || t('failedGeneric')),
      ),
    )
  }

  if (!analysis.ok) {
    return h(
      'div',
      { className: 'a2ui-root' },
      h(
        'div',
        { className: 'a2ui-card' },
        header,
        h('div', { className: 'a2ui-card-body' }, Notice({ title: t('invalid'), body: `${t('invalidHint')}\n${formatViolations(analysis.errors)}`, error: true })),
      ),
    )
  }

  // A surface that lives in a tab renders here as its condensed card, never as an
  // empty notice: the reader sees that the interface exists, what it contains, and
  // the control that puts it in the side column.
  if (condensed !== undefined && !surfaceOnly) {
    return h(InlineSummary, {
      model: condensed,
      t,
      onOpenSidebar: () => {
        runtime.openSurfaceTab?.(condensed.surfaceId)
      },
    })
  }

  if (payload.messages.length === 0) {
    // A live surface that has not arrived yet shows the skeleton, not the
    // "nothing to show" notice: the reader asked to open a tab, the socket is
    // still connecting, and a failure message would be a lie.
    if (payload.pending === true) {
      return h(
        'div',
        { className: 'a2ui-root', 'data-a2ui-pending': 'true' },
        h(
          'div',
          { className: 'a2ui-card' },
          header,
          h(
            'div',
            { className: 'a2ui-card-body' },
            h('div', { className: 'a2ui-skeleton', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, [
              h('div', { className: 'a2ui-skeleton-line a2ui-skeleton-title' }),
              h('div', { className: 'a2ui-skeleton-line' }),
              h('div', { className: 'a2ui-skeleton-line' }),
              h('div', { className: 'a2ui-skeleton-line a2ui-skeleton-short' }),
              h('span', { className: 'a2ui-skeleton-label' }, t('rendering')),
            ]),
          ),
        ),
      )
    }
    return h(
      'div',
      { className: 'a2ui-root' },
      h('div', { className: 'a2ui-card' }, header, h('div', { className: 'a2ui-card-body' }, Notice({ title: t('empty'), body: payload.readError }))),
    )
  }

  const bodies: Array<ReturnType<typeof h>> = []
  for (const surface of analysis.surfaces) {
    const view = makeView(surface.state)
    const interaction = view.interaction
    bodies.push(
      h(
        'div',
        { key: surface.state.surfaceId, className: 'a2ui-stack' },
        analysis.surfaces.length > 1
          ? h('span', { className: 'a2ui-caption' }, surface.state.surfaceId)
          : null,
        h(A2UISurface, { view }),
        interaction.state === 'sent'
          ? h('div', { className: 'a2ui-notice', role: 'status' }, t('sent'))
          : interaction.state === 'sending'
            ? h('div', { className: 'a2ui-notice', role: 'status' }, t('sending'))
            : interaction.state === 'error'
              ? Notice({ title: t('sendFailed'), body: interaction.message, error: true })
              : null,
      ),
    )
  }
  for (const surfaceId of analysis.updatedOnly) {
    bodies.push(
      h('div', { key: `u-${surfaceId}`, className: 'a2ui-notice', role: 'status' }, h('div', null, h('div', { className: 'a2ui-notice-title' }, `${t('updated')}: ${surfaceId}`), h('div', { className: 'a2ui-notice-body' }, t('updatedOnlyHint')))),
    )
  }
  for (const surfaceId of analysis.deleted) {
    bodies.push(h('div', { key: `d-${surfaceId}`, className: 'a2ui-notice', role: 'status' }, `${t('updated')}: ${surfaceId} deleted`))
  }

  if (bodies.length === 0) {
    bodies.push(Notice({ title: t('updatedOnly'), body: t('updatedOnlyHint') }))
  }

  // The turn tail owns the card once it is mounted; keep the process row to a
  // single line so the same interface is never drawn twice. If the tail is
  // unmounted for any reason the claim disappears and this row draws the card
  // again, which is what makes "the interface can never vanish" true.
  if (mode === 'row' && compact && analysis.surfaces.length > 0) {
    const count = analysis.surfaces.reduce((total, surface) => total + surface.componentCount, 0)
    return h(
      'div',
      { className: 'a2ui-root' },
      h(
        'div',
        { className: 'a2ui-pointer' },
        sparkle('a2ui-pointer-icon'),
        h('span', { className: 'a2ui-pointer-text' }, payload.title ?? t('title')),
        h('span', { className: 'a2ui-pointer-meta' }, `${count} · ${t('atTurnTail')}`),
      ),
    )
  }

  if (payload.presentation === 'compact' && analysis.surfaces.length > 0) {
    const title = payload.title?.trim()
    return h('div', { className: 'a2ui-root' },
      h('div', { className: 'a2ui-compact' },
        title ? h('div', { className: 'a2ui-compact-head' }, h('span', { className: 'a2ui-card-title' }, title)) : null,
        h('div', { className: 'a2ui-compact-body a2ui-stack' }, ...bodies),
      ),
    )
  }

  return h(
    'div',
    { className: 'a2ui-root' },
    h('div', { className: 'a2ui-card' }, header, h('div', { className: 'a2ui-card-body' }, h('div', { className: 'a2ui-stack' }, ...bodies))),
  )
}

/** Exported for tests: which component names does the renderer know? */
export const KNOWN_COMPONENTS = [...COMPONENT_BY_NAME.keys()]

export type { SurfaceTouch }

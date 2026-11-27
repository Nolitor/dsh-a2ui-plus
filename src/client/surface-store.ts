/**
 * The browser's copy of the surfaces, fed by the `/a2ui/ws` downlink.
 *
 * Why this exists rather than reading the tool call again: a surface can change
 * after its call settled — a later `updateDataModel`, a revision bump from the
 * Host — and the transcript is immutable. The socket is the only live source.
 *
 * Three rules keep it honest:
 *
 * - **Latest revision wins.** A frame whose `surfaceRevision` is not newer than
 *   the one held is dropped. That is what makes a re-ordered or duplicated frame
 *   harmless, and it is why the Host stamps a real number.
 * - **A snapshot replaces, a delta patches.** Applying an RFC 6902 patch is the
 *   renderer's job here, not the Host's, so the browser and the store cannot
 *   disagree about the result only because one of them skipped a step.
 * - **Placement decides where it renders.** A `sidebar` surface belongs to a tab;
 *   everything else stays in the conversation. Below 768px the tab is refused and
 *   the surface renders inline instead.
 */
import { isPlainObject } from '../shared/json.js'

export { isPlainObject }

/** One patched surface as the browser holds it. */
export interface ClientSurface {
  surfaceId: string
  /** The title the call supplied, when it did; a tab falls back to the plugin name. */
  title: string | undefined
  /** The A2UI messages the surface was declared with. */
  messages: unknown[]
  /** The current data model. */
  dataModel: unknown
  /** Components keyed by id. */
  components: Map<string, unknown>
  placement: 'inline' | 'sidebar'
  /** The store revision this copy reflects. */
  revision: number
  /** The Host store lifetime this copy came from. */
  epoch: string | undefined
  /** Whether the surface is still open (a remove operation closes it). */
  open: boolean
}

/** A frame as the Host sends it. */
export interface DownlinkFrame {
  type: string
  surfaceId?: string
  surfaceRevision?: number
  /** Identity of the Host store lifetime; a change invalidates every revision. */
  surfaceEpoch?: string
  delta?: unknown[]
  content?: Record<string, unknown>
  name?: string
  value?: unknown
  [key: string]: unknown
}

/** One RFC 6902 operation, as far as this store reads them. */
interface PatchOperation {
  op: string
  path: string
  value?: unknown
  from?: string
}

/** Where a surface renders. */
export type Placement = 'inline' | 'sidebar'

/** Narrow viewport rule, matching the Host-side plugin and DSH itself. */
export const NARROW_MAX_WIDTH = 768

/** Whether a viewport width is narrow. */
export function isNarrowWidth(width: number): boolean {
  return width < NARROW_MAX_WIDTH
}

/**
 * Decide where a surface actually renders.
 *
 * A `sidebar` request on a narrow viewport degrades to inline: a phone has no
 * side column to put it in, and a tab the reader cannot see is a tab that does
 * not exist. The caller reports the downgrade so the tool result can say so.
 * @param requested what the call asked for.
 * @param width the current viewport width.
 */
export function effectivePlacement(requested: Placement, width: number): { placement: Placement; downgraded: boolean } {
  if (requested === 'sidebar' && isNarrowWidth(width)) return { placement: 'inline', downgraded: true }
  return { placement: requested, downgraded: false }
}

/** Escape one JSON Pointer token. */
export function escapePointer(segment: string): string {
  return segment.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

/** Unescape one JSON Pointer token. */
export function unescapePointer(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
}

/** Split a pointer into unescaped segments. The root is `[]`. */
export function segmentsOf(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return []
  return pointer.slice(1).split('/').map(unescapePointer)
}

/**
 * Apply one RFC 6902 operation to a document, copy-on-write.
 *
 * Only the operations the Host emits are supported — `add`, `replace`, `remove`.
 * `test` is absent on purpose: it is a patch-verification primitive that the
 * surface protocol never produces, and keeping a branch nothing can reach makes
 * the patcher look more capable than it is.
 * @param document the document to patch.
 * @param operation the operation to apply.
 * @returns the patched document.
 * @throws when the pointer does not resolve for a `replace`/`remove`/`test`.
 */
export function applyOperation(document: unknown, operation: PatchOperation): unknown {
  const segments = segmentsOf(operation.path)
  if (segments.length === 0) {
    if (operation.op === 'remove') throw new Error('cannot remove the document root')
    if (operation.op === 'add' || operation.op === 'replace') return operation.value
    throw new Error(`unsupported operation "${operation.op}"`)
  }

  // The wrapper exists so a root-level write can replace the document through
  // the same path as any other write; the result is read back from it.
  const root: any = { value: document }
  let cursor: any = document === undefined || document === null ? undefined : document
  if (cursor === undefined) {
    cursor = {}
    root.value = cursor
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    let next = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment]
    if (next === undefined) {
      if (operation.op === 'add') {
        next = /^\d+$/u.test(segments[index + 1]) ? [] : {}
        if (Array.isArray(cursor)) cursor[Number(segment)] = next
        else cursor[segment] = next
      } else {
        throw new Error(`path "${operation.path}" does not resolve`)
      }
    }
    cursor = next
  }

  const last = segments[segments.length - 1]
  if (Array.isArray(cursor)) {
    if (last === '-') {
      if (operation.op !== 'add') throw new Error(`"${operation.op}" cannot append`)
      cursor.push(operation.value)
      return root.value
    }
    const index = Number(last)
    if (!Number.isInteger(index) || index < 0) throw new Error(`array index "${last}" is not an integer`)
    if (operation.op === 'add') cursor.splice(index, 0, operation.value)
    else if (operation.op === 'replace') {
      if (index >= cursor.length) throw new Error(`index ${index} is outside the array for "${operation.path}"`)
      cursor[index] = operation.value
    } else if (operation.op === 'remove') {
      if (index >= cursor.length) throw new Error(`index ${index} is outside the array for "${operation.path}"`)
      cursor.splice(index, 1)
    } else throw new Error(`unsupported operation "${operation.op}"`)
    return root.value
  }

  if (typeof cursor !== 'object' || cursor === null) throw new Error(`path "${operation.path}" does not resolve`)
  if (operation.op === 'add' || operation.op === 'replace') cursor[last] = operation.value
  else if (operation.op === 'remove') {
    if (!Object.hasOwn(cursor, last)) throw new Error(`path "${operation.path}" does not resolve`)
    delete cursor[last]
  } else throw new Error(`unsupported operation "${operation.op}"`)
  return root.value
}

/**
 * The client surface store.
 *
 * Subscribers are notified once per applied frame, never once per surface, so a
 * batch that touches three surfaces still causes one render.
 */
export class ClientSurfaceStore {
  private readonly surfaces = new Map<string, ClientSurface>()
  private readonly listeners = new Set<() => void>()
  /** One listener set per surface, so a frame wakes only the views that paint it. */
  private readonly surfaceListeners = new Map<string, Set<() => void>>()
  /** Consecutive unapplicable patches per surface; reset by any successful apply. */
  private readonly failures = new Map<string, number>()
  private revision = 0

  /**
   * How many patches in a row failed for one surface.
   *
   * A single failure is ordinary — a frame can arrive for a surface this page has
   * not been sent yet. Three in a row means the local copy has drifted, and only
   * a snapshot can repair it.
   * @param surfaceId the surface to inspect.
   */
  failuresOf(surfaceId: string | undefined): number {
    if (surfaceId === undefined) return 0
    return this.failures.get(surfaceId) ?? 0
  }

  /** Clear the failure count for a surface (a snapshot arrived, or a resync was asked). */
  clearFailures(surfaceId?: string): void {
    if (surfaceId === undefined) {
      this.failures.clear()
      return
    }
    this.failures.delete(surfaceId)
  }

  /** The newest revision applied, from any surface. */
  currentRevision(): number {
    return this.revision
  }

  /** One surface, or `undefined` when it is not held. */
  get(surfaceId: string): ClientSurface | undefined {
    return this.surfaces.get(surfaceId)
  }

  /** Every held surface, newest change first. */
  list(): ClientSurface[] {
    return [...this.surfaces.values()].sort((left, right) => right.revision - left.revision)
  }

  /** Subscribe to applied frames (every surface). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Subscribe to ONE surface's changes.
   *
   * The whole-store subscription above is what a view used to take, and it meant
   * every frame for every surface re-rendered every card and every tab. A view
   * knows exactly which surface it paints, so it says so here instead.
   * @param surfaceId the surface to follow.
   * @param listener notified when that surface is created, patched or removed.
   */
  subscribeSurface(surfaceId: string, listener: () => void): () => void {
    let set = this.surfaceListeners.get(surfaceId)
    if (set === undefined) {
      set = new Set()
      this.surfaceListeners.set(surfaceId, set)
    }
    set.add(listener)
    return () => {
      const current = this.surfaceListeners.get(surfaceId)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.surfaceListeners.delete(surfaceId)
    }
  }

  /**
   * Apply one downlink frame.
   * @param frame the frame received from the Host.
   * @returns whether the frame changed anything (a stale frame changes nothing).
   */
  apply(frame: DownlinkFrame): boolean {
    if (typeof frame !== 'object' || frame === null) return false
    if (frame.type === 'ACTIVITY_SNAPSHOT') return this.applySnapshot(frame)
    if (frame.type === 'STATE_DELTA') return this.applyDelta(frame)
    if (frame.type === 'CUSTOM') return this.applyCustom(frame)
    return false
  }

  /** Replace one surface from a snapshot. */
  private applySnapshot(frame: DownlinkFrame): boolean {
    const content = isPlainObject(frame.content) ? (frame.content as Record<string, unknown>) : {}
    const surfaceId = typeof frame.surfaceId === 'string' ? frame.surfaceId : typeof content.surfaceId === 'string' ? content.surfaceId : undefined
    if (surfaceId === undefined) return false

    const revision = typeof frame.surfaceRevision === 'number' ? frame.surfaceRevision : this.revision + 1
    const epoch = typeof frame.surfaceEpoch === 'string' ? frame.surfaceEpoch : undefined
    const current = this.surfaces.get(surfaceId)
    // A new epoch means the Host rebuilt its store (a restart), so its revisions
    // are unrelated to the ones held here: the snapshot is the new baseline no
    // matter how its number compares. Without this check a restart would leave
    // every surface frozen at whatever revision the old process reached.
    const epochChanged = epoch !== undefined && current !== undefined && current.epoch !== epoch
    if (!epochChanged && current !== undefined && revision <= current.revision) return false

    const messages = Array.isArray(content.messages) ? content.messages : []
    const components = new Map<string, unknown>()
    if (Array.isArray(content.components)) {
      for (const component of content.components) {
        if (isPlainObject(component) && typeof (component as Record<string, unknown>).id === 'string') {
          components.set((component as Record<string, unknown>).id as string, component)
        }
      }
    }
    this.failures.delete(surfaceId)
    this.surfaces.set(surfaceId, {
      surfaceId,
      // The Host carries the call's title in the snapshot content so a tab that
      // restores after a reload keeps the name the user saw.
      title: typeof content.title === 'string' && content.title !== '' ? content.title : undefined,
      messages,
      dataModel: content.dataModel ?? {},
      components,
      placement: content.placement === 'sidebar' ? 'sidebar' : 'inline',
      revision,
      epoch,
      open: true,
    })
    this.revision = epochChanged ? revision : Math.max(this.revision, revision)
    this.notify(surfaceId)
    return true
  }

  /** Patch one surface from a delta. */
  private applyDelta(frame: DownlinkFrame): boolean {
    const surfaceId = typeof frame.surfaceId === 'string' ? frame.surfaceId : undefined
    if (surfaceId === undefined) return false
    const revision = typeof frame.surfaceRevision === 'number' ? frame.surfaceRevision : this.revision + 1
    const current = this.surfaces.get(surfaceId)
    if (current === undefined) return false
    // A delta from a different store lifetime describes a document this client
    // never had; it is dropped and the resync path supplies a snapshot.
    const epoch = typeof frame.surfaceEpoch === 'string' ? frame.surfaceEpoch : undefined
    if (epoch !== undefined && current.epoch !== undefined && epoch !== current.epoch) {
      this.failures.set(surfaceId, this.failuresOf(surfaceId) + 1)
      return false
    }
    if (revision <= current.revision) return false

    const operations = Array.isArray(frame.delta) ? (frame.delta as PatchOperation[]) : []
    let document: any = {
      surfaces: {
        [surfaceId]: {
          messages: current.messages,
          dataModel: current.dataModel,
          components: Object.fromEntries(current.components),
          placement: current.placement,
        },
      },
    }
    let removed = false
    try {
      for (const operation of operations) {
        if (typeof operation !== 'object' || operation === null) continue
        if (operation.op === 'remove' && operation.path === `/surfaces/${escapePointer(surfaceId)}`) {
          removed = true
          break
        }
        document = applyOperation(document, operation)
      }
    } catch (error) {
      // A patch the client cannot apply leaves the surface as it was; the next
      // snapshot repairs it. Throwing here would take the whole socket down.
      // The count is what tells the socket to stop waiting for a lucky patch.
      this.failures.set(surfaceId, this.failuresOf(surfaceId) + 1)
      void error
      return false
    }
    this.failures.delete(surfaceId)

    if (removed) {
      this.surfaces.delete(surfaceId)
      this.revision = Math.max(this.revision, revision)
      this.notify(surfaceId)
      return true
    }

    const next = document.surfaces[surfaceId]
    if (!isPlainObject(next)) return false
    const components = new Map<string, unknown>()
    if (isPlainObject(next.components)) {
      for (const [id, component] of Object.entries(next.components as Record<string, unknown>)) components.set(id, component)
    }
    this.surfaces.set(surfaceId, {
      ...current,
      messages: Array.isArray(next.messages) ? (next.messages as unknown[]) : current.messages,
      dataModel: next.dataModel,
      components,
      revision,
    })
    this.revision = Math.max(this.revision, revision)
    this.notify(surfaceId)
    return true
  }

  /** Handle one application frame (a deletion, or a renderer request). */
  private applyCustom(frame: DownlinkFrame): boolean {
    if (frame.name === 'surfaceDeleted' && typeof frame.surfaceId === 'string') {
      const removed = this.surfaces.delete(frame.surfaceId)
      if (removed) this.notify(frame.surfaceId)
      return removed
    }
    return false
  }

  /**
   * Adopt one frame unconditionally.
   *
   * Used for a resync answer and for a baseline: the Host built it from its own
   * store, so it is the truth regardless of the revision this page happens to
   * hold. A stale revision here would keep exactly the drift the resync exists to
   * repair.
   * @param frame the authoritative frame.
   * @returns whether anything changed.
   */
  adopt(frame: DownlinkFrame): boolean {
    if (typeof frame !== 'object' || frame === null) return false
    if (typeof frame.surfaceId === 'string') this.failures.delete(frame.surfaceId)
    return this.apply({ ...frame, surfaceRevision: Number.MAX_SAFE_INTEGER })
  }

  /** Drop every surface (socket replacement or plugin teardown). */
  clear(): void {
    if (this.surfaces.size === 0) return
    this.surfaces.clear()
    this.notify()
  }

  /** Wake the listeners of one surface. */
  private notifySurface(surfaceId: string): void {
    const listeners = this.surfaceListeners.get(surfaceId)
    if (listeners === undefined) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }

  /**
   * Wake subscribers.
   * @param surfaceId the surface that changed, when one did; its per-surface
   *   listeners are woken too. Omitted for a wholesale clear.
   */
  private notify(surfaceId?: string): void {
    if (surfaceId !== undefined) this.notifySurface(surfaceId)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }
}

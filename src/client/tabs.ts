/**
 * The sidebar half of the plugin: one generic tab type, plus the per-surface
 * instances the Host's placement asks for.
 *
 * Three separate jobs, deliberately kept apart:
 *
 * - **The registry** (`registerTab`, once) declares the type: what it is called,
 *   what it renders, where it sits in the `+` menu. It is registered at apply time
 *   and removed by its own disposer, so an unload unregisters the type.
 * - **Instance opening** (`openTab`) is per surface: the id is
 *   `a2ui:{surfaceId}`, so a surface can be found again from its id alone and a
 *   second open focuses the existing tab instead of minting a duplicate.
 * - **In-place updates** (`updateTab`) carry the title, badge and state after a
 *   `STATE_DELTA`. This is what keeps the sidebar from accumulating one tab per
 *   revision.
 *
 * The plugin does not require `betterSidebar`: a profile without it keeps the
 * conversation card and simply never opens a tab.
 */
import { h } from './h.js'
import type { ClientSurfaceStore } from './surface-store.js'

/** The one tab type this plugin registers. */
export const TAB_ID = 'a2ui-generic'

/** Prefix every per-surface tab id carries. */
export const TAB_ID_PREFIX = 'a2ui:'

/** Tabs known per session, so a fresh page can reconcile what it restored. */
export const TAB_MAP_KEY = 'dsh-a2ui-plus:tabs'

/**
 * The Host store lifetime the persisted mapping belongs to.
 *
 * A Host restart rebuilds every surface id from scratch, so a mapping written
 * before the restart names tabs whose surfaces no longer exist. Recording the
 * epoch alongside the mapping is what lets a page tell "these tabs are still
 * mine" from "these tabs are leftovers".
 */
export const TAB_EPOCH_KEY = 'dsh-a2ui-plus:epoch'

/** The tab id for one surface. */
export function tabIdOf(surfaceId: string): string {
  return `${TAB_ID_PREFIX}${surfaceId}`
}

/** Whether a tab id belongs to a surface instance (not the generic type). */
export function isSurfaceTabId(tabId: unknown): tabId is string {
  return typeof tabId === 'string' && tabId.startsWith(TAB_ID_PREFIX)
}

/** The surface a tab id names. */
export function surfaceIdOf(tabId: string): string {
  return tabId.slice(TAB_ID_PREFIX.length)
}

/** What the tab system must provide for this module to register anything. */
export interface SidebarLike {
  registerTab: (descriptor: Record<string, unknown>) => () => void
  openTab: (seed: Record<string, unknown>, scope?: { sessionId: string; cwd?: string }) => void
  updateTab?: (tabId: string, patch: { title?: string; meta?: unknown }, sessionId?: string) => void
  getTabs?: () => readonly unknown[]
}

/** What the tab module needs from the page. */
export interface TabContext {
  effect: (factory: () => (() => void) | void, label?: string) => unknown
  get?: (name: string) => unknown
  slots?: unknown
  sessions?: unknown
  logger?: { warn?: (message: string) => void }
}

/** A tiny key/value facade over `localStorage` that survives its absence. */
export interface TabMapStorage {
  read: () => Record<string, string>
  write: (value: Record<string, string>) => void
  /** The store epoch the persisted mapping was written under. */
  readEpoch: () => string | undefined
  /** Record the store epoch the mapping belongs to. */
  writeEpoch: (epoch: string) => void
  /** Forget both the mapping and its epoch. */
  clear: () => void
}

/**
 * The persisted surface → tab mapping.
 *
 * Written so a refresh can tell the Host "these surfaces are already open as
 * tabs", which is what lets the reconnect baseline reconcile instead of opening a
 * second set. Storage failures are swallowed: a browser in private mode must
 * still render.
 * @param storage the storage to use; defaults to `localStorage`.
 */
export function tabMapStorage(storage?: Storage | null): TabMapStorage {
  const fallback = (): Storage | null => {
    if (storage !== undefined) return storage
    try {
      return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
    } catch {
      return null
    }
  }
  return {
    read() {
      const target = fallback()
      if (target === null) return {}
      try {
        const raw = target.getItem(TAB_MAP_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
        const out: Record<string, string> = {}
        for (const [surfaceId, tabId] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof tabId === 'string' && tabId !== '') out[surfaceId] = tabId
        }
        return out
      } catch {
        return {}
      }
    },
    write(value) {
      const target = fallback()
      if (target === null) return
      try {
        target.setItem(TAB_MAP_KEY, JSON.stringify(value))
      } catch {
        // Quota or a locked store: the mapping is an optimisation, not truth.
      }
    },
    readEpoch() {
      const target = fallback()
      if (target === null) return undefined
      try {
        const raw = target.getItem(TAB_EPOCH_KEY)
        return raw === null || raw === '' ? undefined : raw
      } catch {
        return undefined
      }
    },
    writeEpoch(epoch) {
      const target = fallback()
      if (target === null) return
      try {
        target.setItem(TAB_EPOCH_KEY, epoch)
      } catch {
        // Same reasoning as `write`.
      }
    },
    clear() {
      const target = fallback()
      if (target === null) return
      try {
        target.removeItem(TAB_MAP_KEY)
        target.removeItem(TAB_EPOCH_KEY)
      } catch {
        // Same reasoning as `write`.
      }
    },
  }
}

/** What one open request produced. */
export interface OpenOutcome {
  /** `tab` when a sidebar tab now holds the surface, `inline` when it does not. */
  rendered: 'tab' | 'inline'
  /** The tab id, when one was opened. */
  tabId?: string
  /** Why the request fell back to inline. */
  reason?: 'narrow' | 'unavailable' | 'refused'
}

/**
 * Manage the tab type and its per-surface instances.
 *
 * One instance lives for the plugin's lifetime: the registry, the storage and the
 * index of open tabs all belong to it, so two surfaces can never disagree about
 * which tab id is theirs.
 */
export class TabRouter {
  private readonly ctx: TabContext
  private readonly storage: TabMapStorage
  private readonly store: ClientSurfaceStore | undefined
  private index: Record<string, string>
  private registered = false

  /**
   * @param ctx client plugin context.
   * @param store the surface store the tab bodies read.
   * @param storage persisted mapping override (tests).
   */
  constructor(ctx: TabContext, store?: ClientSurfaceStore, storage?: Storage | null) {
    this.ctx = ctx
    this.store = store
    this.storage = tabMapStorage(storage)
    this.index = this.storage.read()
  }

  /** The tab system, when the profile has it. */
  private service(): SidebarLike | undefined {
    const candidate = typeof this.ctx.get === 'function' ? this.ctx.get('betterSidebar') : undefined
    const usable =
      candidate === undefined || candidate === null
        ? undefined
        : typeof (candidate as SidebarLike).registerTab === 'function' && typeof (candidate as SidebarLike).openTab === 'function'
          ? (candidate as SidebarLike)
          : undefined
    return usable
  }

  /**
   * Wait for `betterSidebar` and register the one tab type this plugin owns.
   *
   * Readiness is waited for rather than probed once: a profile loads plugins in
   * an order this package does not control, so `betterSidebar` may not exist when
   * `apply()` runs. Probing once and giving up silently is how the tab type went
   * missing on a live host — the plugin loaded, the sidebar never listed it.
   *
   * Idempotent: a second call is a no-op, so a re-mount cannot register twice and
   * start throwing on the duplicate id.
   * @param renderBody the component a tab renders.
   * @param title a thunk evaluated in the active locale.
   * @param inject the Cordis `ctx.inject` that waits for a service list.
   */
  register(
    renderBody: (props: Record<string, unknown>) => unknown,
    title: () => string,
    inject?: (services: string[], callback: () => void) => unknown,
  ): boolean {
    if (this.registered) return false
    this.registered = true

    const register = (): boolean => {
      const service = this.service()
      if (service === undefined) return false
      this.ctx.effect(
        () =>
          service.registerTab({
            id: TAB_ID,
            title,
            // Single instance per surface is expressed by the seeded id, not here:
            // `single` would collapse every surface into one tab.
            icon: undefined,
            order: 60,
            component: renderBody,
          }),
        'a2ui-plus: sidebar tab type',
      )
      return true
    }

    if (register()) return true
    if (inject === undefined) return false
    // The sidebar is not loaded yet: register the moment it arrives.
    inject(['betterSidebar'], () => {
      register()
    })
    return true
  }

  /** The tab id a surface is already open under, if the index knows one. */
  tabIdFor(surfaceId: string): string | undefined {
    return this.index[surfaceId]
  }

  /** Every surface currently mapped to a tab. */
  mapped(): Record<string, string> {
    return { ...this.index }
  }

  /**
   * Open (or focus) the tab for one surface.
   *
   * `scope` is passed so the tab lands in the surface's own session even when the
   * reader is looking at another conversation — the Host supports that, and the
   * alternative would be mounting a tab nobody asked to see.
   * @param surfaceId the surface to place.
   * @param title the tab title.
   * @param scope the session that owns it.
   */
  open(surfaceId: string, title: string, scope: { sessionId: string; cwd?: string }): OpenOutcome {
    const service = this.service()
    if (service === undefined) return { rendered: 'inline', reason: 'unavailable' }

    const tabId = tabIdOf(surfaceId)
    // The seed id is advisory *for the body*, which reads `meta.surfaceId` because the
    // sidebar can re-mint ids — so the surface identity rides `meta` (persisted with
    // the record) for a reload to find it again.
    //
    // For DEDUPLICATION the seed id is load-bearing, and this is the one place that
    // sets it. Measured 2026-11-27 on dsh-better-sidebar 0.33.0: `openTab` reuses an
    // open tab only when the descriptor carries `dedupeKey`/`single` AND the seed
    // carries `meta` (lib/client.js:1886-1901), and this plugin registers neither
    // (tabs.ts descriptor below). Two opens with the same `seed.id` were observed to
    // land on ONE tab with the plugin guard bypassed (duplicates: 1).
    //
    // THIS INVARIANT IS MEASURED, NOT TESTED. The browser measurement cannot be
    // replayed by the unit suite, because the host's tab store is not present there.
    // If the host stops honouring seed.id, the symptom is N>1 tabs for one surfaceId.
    // Detection: press `[사이드바에서 열기]` twice. Fix: re-verify dsh-better-sidebar's
    // openTab dedup semantics before assuming the plugin guard is sufficient.
    // The half this repo owns — that every open forwards `tabIdOf(surfaceId)`
    // untouched, from exactly one builder — IS tested: tests/tabs.test.mjs,
    // "every open forwards the same seed id the mapping records" and
    // "the seed id is written in exactly one place in the client source".
    service.openTab({ type: TAB_ID, id: tabId, title, meta: { surfaceId } }, scope)
    this.index = { ...this.index, [surfaceId]: tabId }
    this.storage.write(this.index)
    return { rendered: 'tab', tabId }
  }

  /**
   * Reflect a surface change in its tab, in place.
   *
   * This is the whole anti-duplication story: a `STATE_DELTA` for an open surface
   * updates its title and badge instead of opening another tab.
   * @param surfaceId the changed surface.
   * @param title the new title, or `undefined` to keep the current one.
   * @param scope the owning session.
   * @returns whether a tab was updated.
   */
  update(surfaceId: string, title: string | undefined, scope?: { sessionId: string; cwd?: string }): boolean {
    const service = this.service()
    if (service === undefined || typeof service.updateTab !== 'function') return false
    const tabId = this.index[surfaceId] ?? tabIdOf(surfaceId)
    const surface = this.store?.get(surfaceId)
    service.updateTab(
      tabId,
      {
        ...(title === undefined ? {} : { title }),
        ...(surface === undefined ? {} : { meta: { surfaceId, revision: surface.revision } }),
      },
      scope?.sessionId,
    )
    return true
  }

  /**
   * Forget a surface's tab (the surface was deleted).
   * @param surfaceId the removed surface.
   */
  forget(surfaceId: string): void {
    if (this.index[surfaceId] === undefined) return
    const next = { ...this.index }
    delete next[surfaceId]
    this.index = next
    this.storage.write(this.index)
  }

  /**
   * Reconcile the persisted mapping against the surfaces the Host reports.
   *
   * A mapping entry with no matching surface is stale (the tab outlived its
   * surface across a refresh), and it is dropped. A surface with no entry is
   * simply not open yet; this method does not open anything, because a baseline
   * may legitimately arrive before the reader asks to see anything.
   * @param surfaceIds the surfaces currently known.
   * @returns the embeddings that were dropped.
   */
  /**
   * Reconcile the persisted mapping against the surfaces the Host reports.
   *
   * Two independent rules, applied in this order:
   *
   * 1. **Epoch.** If the Host's store epoch differs from the recorded one, every
   *    mapping entry predates that store and none of them can be trusted: the map
   *    is cleared wholesale and the recorded epoch is updated. This is the path a
   *    server restart takes.
   * 2. **Membership.** Within one epoch, an entry whose surface the Host no longer
   *    reports is stale and is dropped.
   *
   * Neither rule opens a tab. A baseline may arrive before the reader asks to see
   * anything, and opening on its own would put windows on screen unprompted.
   * @param surfaceIds the surfaces currently known.
   * @param epoch the Host store epoch, when one is known.
   * @returns the surface ids whose mapping was dropped.
   */
  reconcile(surfaceIds: readonly string[], epoch?: string): string[] {
    if (epoch !== undefined) {
      const recorded = this.storage.readEpoch()
      if (recorded !== undefined && recorded !== epoch) {
        const dropped = Object.keys(this.index)
        this.index = {}
        this.storage.write(this.index)
        this.storage.writeEpoch(epoch)
        return dropped
      }
      if (recorded === undefined) this.storage.writeEpoch(epoch)
    }

    const known = new Set(surfaceIds)
    const dropped = Object.keys(this.index).filter((surfaceId) => !known.has(surfaceId))
    if (dropped.length === 0) return []
    const next = { ...this.index }
    for (const surfaceId of dropped) delete next[surfaceId]
    this.index = next
    this.storage.write(this.index)
    return dropped
  }
}

/** The tab body: one surface, read live from the store. */
export function makeTabBody(store: ClientSurfaceStore | undefined, render: (surfaceId: string, props: Record<string, unknown>) => unknown) {
  return (props: Record<string, unknown>): unknown => {
    const surfaceId = surfaceIdOfTab(props?.tab)
    if (surfaceId === undefined) return null
    return render(surfaceId, props)
  }
}

/**
 * Which surface a sidebar tab instance shows.
 *
 * Three sources, in order of authority:
 *
 * 1. `tab.meta.surfaceId` — what `openTab` recorded, and the only one that
 *    survives a reload because the record persists `meta`.
 * 2. `tab.path` — the same value when a host passes it through as component state.
 * 3. `tab.id` — only when the host kept the seeded `a2ui:{surfaceId}` id; the
 *    plugin's own sidebar re-mints ids (`tab3`), so this applies elsewhere.
 * @param tab the sidebar tab record handed to a body.
 * @returns the surface id, or `undefined` when the tab is not a surface tab.
 */
export function surfaceIdOfTab(tab: unknown): string | undefined {
  if (typeof tab !== 'object' || tab === null) return undefined
  const record = tab as { id?: unknown; path?: unknown; meta?: unknown }
  const meta = record.meta
  if (typeof meta === 'object' && meta !== null) {
    const fromMeta = (meta as { surfaceId?: unknown }).surfaceId
    if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta
  }
  if (typeof record.path === 'string' && record.path !== '') return record.path
  return isSurfaceTabId(record.id) ? surfaceIdOf(record.id as string) : undefined
}

/** Re-exported so the client entry needs one import. */
export { h }

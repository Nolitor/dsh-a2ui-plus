/**
 * Edit state shared by the two hosts of one surface.
 *
 * A card is rendered twice: as a row inside the turn's process window and again
 * at the turn tail. They are separate React trees, so edits kept in component
 * state are lost the moment the visible copy changes hands (the reviewer saw
 * `user edit → initial`). The model and the action state therefore live here,
 * keyed by session + call + surface, and both hosts subscribe to the same entry.
 *
 * The store is a bounded cache: entries are keyed by session, so two sessions can
 * never see each other's edits, and the oldest entry is evicted once the cap is
 * reached. `resetSession` is exposed for tests and for an explicit cleanup.
 */
import type { JsonValue } from '../shared/json.js'
import { pointerWrite } from '../shared/json.js'
import type { InteractionState } from './context.js'

/** Entries kept before the oldest is dropped. */
const MAX_ENTRIES = 200

export interface SurfaceEntry {
  model: JsonValue
  interaction: InteractionState
}

const entries = new Map<string, SurfaceEntry>()
let version = 0
const listeners = new Set<() => void>()

/** Key for one card's editable state. */
export function stateKey(sessionId: string | undefined, callId: string, surfaceId: string): string {
  return `${sessionId ?? '-'}\u0000${callId}\u0000${surfaceId}`
}

function notify(): void {
  version += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* one bad subscriber must not stop the others */
    }
  }
}

/** Subscribe to any change; returns the unsubscribe function. */
export function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Monotonic change counter, for `useSyncExternalStore`. */
export function storeVersion(): number {
  return version
}

function evict(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()
    if (oldest.done === true) return
    entries.delete(oldest.value)
  }
}

/**
 * The current model for a card, seeded from the surface's data model on first
 * use so both hosts start from the same base.
 */
export function modelFor(key: string, seed: JsonValue): JsonValue {
  const existing = entries.get(key)
  if (existing !== undefined) return existing.model
  entries.set(key, { model: seed, interaction: { state: 'idle' } })
  evict()
  return seed
}

/** The current action state for a card. */
export function interactionFor(key: string): InteractionState {
  return entries.get(key)?.interaction ?? { state: 'idle' }
}

/**
 * Apply a local edit.
 * @returns `ok`, `unchanged`, or `refused` when the path is not writable.
 */
export function writeModel(key: string, pointer: string, value: JsonValue): 'ok' | 'unchanged' | 'refused' {
  const entry = entries.get(key)
  if (entry === undefined) return 'refused'
  const result = pointerWrite(entry.model, pointer, value)
  if (result.status === 'ok') {
    entry.model = result.value
    notify()
  }
  return result.status
}

/** Replace the interaction state shown for a card. */
export function setInteractionState(key: string, state: InteractionState): void {
  const entry = entries.get(key)
  if (entry === undefined) return
  if (entry.interaction.state === state.state && entry.interaction.message === state.message) return
  entry.interaction = state
  notify()
}

/** Drop every entry belonging to one session. */
export function resetSession(sessionId: string): void {
  const prefix = `${sessionId}\u0000`
  let changed = false
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) {
      entries.delete(key)
      changed = true
    }
  }
  if (changed) notify()
}

/** Drop everything (tests). */
export function resetAll(): void {
  if (entries.size === 0) return
  entries.clear()
  notify()
}

/** Number of live entries (tests). */
export function entryCount(): number {
  return entries.size
}

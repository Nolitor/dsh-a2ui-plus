/**
 * The Session event window is the authority for live tool arguments. A
 * preparing card borrows that window without retaining or opening a Session.
 * The window reports withdrawals too, even when there is no tool result.
 */
import { isPlainObject } from '../shared/json.js'

export const MAX_STREAM_CHARS = 256 * 1024
export const MAX_STREAM_TOTAL_CHARS = 1024 * 1024
export const MAX_STREAM_ENTRIES = 32

interface SessionEventEntry {
  readonly type: 'transient' | 'event'
  readonly event: {
    readonly type: string
    readonly seq: number
    readonly data: {
      readonly attemptId?: string
      readonly chunk?: unknown
      readonly callId?: unknown
      readonly message?: unknown
    }
  }
}

interface SessionEventWindow {
  readonly entries: readonly SessionEventEntry[]
  readonly revision: number
  readonly change:
    | { readonly kind: 'replace' | 'append' | 'prepend'; readonly entries: readonly SessionEventEntry[] }
    | { readonly kind: 'settle-assistant'; readonly attemptId: string }
}

export interface SessionEventSource {
  getSnapshot(): SessionEventWindow
  subscribe(listener: () => void): () => void
}

interface PreviewArguments {
  readonly attemptId: string
  readonly seq: number
  readonly text: string
}

interface PreviewReader {
  notify(): void
}

// Reader identity includes the event source of the exact Session binding and
// the call. A subscriber in another Session cannot read or overwrite it.
const cache = new Map<PreviewReader, PreviewArguments>()
const changed = new Set<PreviewReader>()
let totalChars = 0
let pendingNotify = false

function notifyReaders(): void {
  pendingNotify = false
  const readers = [...changed]
  changed.clear()
  for (const reader of readers) reader.notify()
}

function scheduleNotify(): void {
  if (pendingNotify || changed.size === 0) return
  pendingNotify = true
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(notifyReaders)
  else if (typeof setTimeout === 'function') setTimeout(notifyReaders, 16)
  else notifyReaders()
}

/** Release a copy of the arguments on eviction and unmount alike. */
function remove(reader: PreviewReader): void {
  const previous = cache.get(reader)
  if (previous === undefined) return
  cache.delete(reader)
  totalChars -= previous.text.length
}

function publish(reader: PreviewReader, next: PreviewArguments | undefined): void {
  const previous = cache.get(reader)
  if (next === previous) return
  remove(reader)
  if (next !== undefined) {
    cache.set(reader, next)
    totalChars += next.text.length
  }
  if (next?.text !== previous?.text) changed.add(reader)
  while (cache.size > MAX_STREAM_ENTRIES || totalChars > MAX_STREAM_TOTAL_CHARS) {
    const oldest = cache.keys().next().value as PreviewReader
    remove(oldest)
    changed.add(oldest)
  }
  scheduleNotify()
}

function foldEntries(
  entries: readonly SessionEventEntry[],
  callId: string,
  previous?: PreviewArguments,
): PreviewArguments | undefined {
  let current = previous
  for (const { type, event } of entries) {
    if (event.seq <= (current?.seq ?? -Infinity)) continue
    const data = event.data
    if (type === 'event') {
      if (current === undefined) continue
      if (event.type === 'tool/call' && data.callId === callId) current = undefined
      const message = data.message
      if (event.type === 'tool/result' && isPlainObject(message) && isPlainObject(message.source) && message.source.callId === callId) {
        current = undefined
      }
      continue
    }
    if (event.type !== 'assistant/live-chunk' || typeof data.attemptId !== 'string') continue
    const chunk = data.chunk
    if (!isPlainObject(chunk) || chunk.type !== 'tool-call-delta' || chunk.id !== callId) continue

    const previous = current
    const matchingAttempt = previous !== undefined && previous.attemptId === data.attemptId
    if (typeof chunk.name === 'string' && chunk.name !== '') {
      if (chunk.name !== 'a2ui') {
        if (matchingAttempt) current = undefined
        continue
      }
    } else if (!matchingAttempt) {
      // An unnamed delta belongs only to an already identified attempt.
      continue
    }

    const prefix = matchingAttempt ? previous.text : ''
    const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    current = {
      attemptId: data.attemptId,
      seq: event.seq,
      text: prefix + delta.slice(0, MAX_STREAM_CHARS - prefix.length),
    }
  }
  return current
}

/** Follow one preparing call while its card is mounted. */
export function watchStream(source: SessionEventSource, callId: string) {
  const listeners = new Set<() => void>()
  const reader: PreviewReader = {
    notify() {
      for (const listener of listeners) listener()
    },
  }
  let revision: number | undefined
  let unsubscribe: (() => void) | undefined

  const accept = () => {
    const window = source.getSnapshot()
    if (window.revision === revision) return
    const previousRevision = revision
    revision = window.revision
    const current = cache.get(reader)
    const { change } = window
    if (previousRevision === undefined || window.revision !== previousRevision + 1 || change.kind === 'replace' || change.kind === 'prepend') {
      publish(reader, foldEntries(window.entries, callId))
    } else if (change.kind === 'append') {
      publish(reader, foldEntries(change.entries, callId, current))
    } else if (change.kind === 'settle-assistant' && change.attemptId === current?.attemptId) {
      publish(reader, undefined)
    }
  }

  return {
    getSnapshot: () => cache.get(reader)?.text,
    getServerSnapshot: () => foldEntries(source.getSnapshot().entries, callId)?.text,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (unsubscribe === undefined) {
        unsubscribe = source.subscribe(accept)
        accept()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        unsubscribe?.()
        unsubscribe = undefined
        revision = undefined
        changed.delete(reader)
        remove(reader)
      }
    },
  }
}

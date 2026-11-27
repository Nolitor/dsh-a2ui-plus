/**
 * Transcript lookup used by the turn-tail entry.
 *
 * The turn tail renders in the main conversation column, after the turn's
 * answer, and is therefore never folded with the "process" area. To draw the
 * surfaces a turn produced it needs that turn's `tool-call` nodes, which the
 * slot exposes through the standard `useChat` store (`nodes` map + `order`).
 *
 * Kept as pure functions so the selection logic is unit-testable without a
 * browser: a wrong guess about the store shape must fail a test, not a page.
 */
import { isPlainObject } from '../shared/json.js'

/** The block a `tool.call.toolview` receives (start, preparing, or result). */
export interface ToolBlockLike {
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
}

export type ToolPhase = 'preparing' | 'start' | 'result'

/** Minimal Chat node shape needed by the lookup (subset of `ChatNode`). */
export interface ChatNodeLike {
  kind?: string
  anchorSeq?: number
  visibility?: string
  location?: { kind?: string; turn?: { turn?: number } }
  data?: { root?: ToolBlockLike }
}

export interface A2uiRootEntry {
  key: string
  root: ToolBlockLike
  phase: ToolPhase
}

/** Node phase, mirroring how the Chat tool node reports its current stage. */
export function toolPhaseOf(root: ToolBlockLike | undefined): ToolPhase {
  if (root === undefined) return 'preparing'
  if (root.kind !== undefined) return 'result'
  return root.phase === 'preparing' ? 'preparing' : 'start'
}

/** The wire tool name of a block, whichever stage it is in. */
export function blockToolName(root: ToolBlockLike | undefined): string | undefined {
  if (root === undefined) return undefined
  return root.name ?? root.call?.name
}

/** Turn number a node belongs to, or `undefined` when it is not turn-scoped. */
export function nodeTurn(node: ChatNodeLike | undefined): number | undefined {
  const location = node?.location
  if (location === undefined) return undefined
  if (location.kind !== 'turn' && location.kind !== 'step') return undefined
  return location.turn?.turn
}

function lookup(nodes: unknown, key: string): ChatNodeLike | undefined {
  if (nodes === null || nodes === undefined) return undefined
  const candidate = nodes as { get?: (key: string) => unknown }
  if (typeof candidate.get === 'function') return candidate.get(key) as ChatNodeLike | undefined
  return (nodes as Record<string, ChatNodeLike>)[key]
}

/**
 * Whether a tool root belongs to this plugin.
 *
 * Matching by wire name covers the default `a2ui` call. The presentation-meta
 * fallback covers a renamed `toolName`: the row view is registered under the
 * default name and so will not exist, but a settled result still carries
 * `meta.kind === 'a2ui'`, and the turn tail can render that card.
 *
 * @param root tool root lifecycle value.
 * @param toolName configured wire name.
 */
export function isA2uiRoot(root: ToolBlockLike | undefined, toolName = 'a2ui'): boolean {
  if (root === undefined) return false
  if (blockToolName(root) === toolName) return true
  const meta = (root as { meta?: unknown }).meta
  return isPlainObject(meta) && meta.kind === 'a2ui'
}

/**
 * Collect the `a2ui` roots from one turn's `tool-call` node data.
 *
 * This is the change *signal*: `ChatSnapshot.nodes.turnDataSource(turn,
 * 'tool-call')` is documented as identity-stable and "changes only with its
 * members". It cannot supply visibility (its payload is only `{root}`), so the
 * turn tail reads the nodes themselves and uses this array purely to know when
 * to re-read.
 *
 * @param entries `turnDataSource` payloads (`{ root }`), in anchor order.
 * @param toolName wire tool name, default `a2ui`.
 */
export function rootsFromToolData(entries: readonly unknown[] | undefined, toolName = 'a2ui'): A2uiRootEntry[] {
  if (!Array.isArray(entries)) return []
  const out: A2uiRootEntry[] = []
  for (const [index, entry] of entries.entries()) {
    if (!isPlainObject(entry)) continue
    const root = (entry as { root?: ToolBlockLike }).root
    if (!isA2uiRoot(root, toolName)) continue
    out.push({ key: root?.callId ?? `tool-${index}`, root: root as ToolBlockLike, phase: toolPhaseOf(root) })
  }
  return out
}

/**
 * Collect this turn's `a2ui` cards from its ordered node keys.
 *
 * `turnDataSource` includes hidden nodes, so visibility is applied here from the
 * node itself — the same rule the transcript uses — and the root is read fresh so
 * a start → result update is reflected.
 *
 * @param turnNumber the turn being rendered.
 * @param keys ordered node keys for that turn (`locations.getTurn`).
 * @param nodes key → node reader.
 * @param toolName configured wire name.
 */
export function rootsFromTurnNodes(
  turnNumber: number | undefined,
  keys: readonly string[] | undefined,
  nodes: unknown,
  toolName = 'a2ui',
): A2uiRootEntry[] {
  if (turnNumber === undefined || !Array.isArray(keys)) return []
  const out: A2uiRootEntry[] = []
  for (const key of keys) {
    const node = lookup(nodes, key)
    if (node?.kind !== 'tool-call') continue
    if (node.visibility === 'hidden') continue
    const root = node.data?.root
    if (!isA2uiRoot(root, toolName)) continue
    out.push({ key, root: root as ToolBlockLike, phase: toolPhaseOf(root) })
  }
  return out
}

/**
 * Collect the `a2ui` calls of one turn, in transcript order.
 * @param order node keys in render order.
 * @param nodes key → node store.
 * @param turnNumber the turn being rendered; `undefined` yields an empty result.
 * @param toolName wire tool name, default `a2ui`.
 */
export function collectA2uiRoots(
  order: readonly string[] | undefined,
  nodes: unknown,
  turnNumber: number | undefined,
  toolName = 'a2ui',
): A2uiRootEntry[] {
  if (turnNumber === undefined || !Array.isArray(order)) return []
  const entries: A2uiRootEntry[] = []
  for (const key of order) {
    const node = lookup(nodes, key)
    if (node?.kind !== 'tool-call' || node.visibility === 'hidden') continue
    if (nodeTurn(node) !== turnNumber) continue
    const root = node.data?.root
    if (!isA2uiRoot(root, toolName)) continue
    entries.push({ key, root: root as ToolBlockLike, phase: toolPhaseOf(root) })
  }
  return entries
}

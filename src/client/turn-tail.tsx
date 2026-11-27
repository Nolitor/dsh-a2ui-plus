/**
 * `conversation.chat.turnTail` entry: the A2UI card in the main conversation.
 *
 * Why this slot: a `tool.call.toolview` lives inside the turn's "process" window,
 * which DSH folds for every completed turn that is no longer the newest
 * (`ChatNodeSeat`: `defaultOpen = bottom && deferCollapse`, hidden by
 * `processMember && !processOpen`). The turn tail renders after the turn's
 * answer, outside that window, which is exactly how the shipped action cards
 * keep their card visible.
 *
 * Data source: `ChatSnapshot.nodes.turnDataSource(turn, 'tool-call')`, the
 * documented per-turn observable whose array "changes only with its members".
 * That is what makes a running call update in place when its result arrives,
 * instead of freezing on the first published payload.
 */
import * as React from 'react'
import { h } from './h.js'
import type { ClientRuntime } from './tool-view.js'
import { A2UIToolView } from './tool-view.js'
import { collectA2uiRoots, rootsFromTurnNodes, type A2uiRootEntry } from './surfaces.js'

type Selector = (state: unknown) => unknown

interface SnapshotSource<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

interface ChatStoreLike {
  turnDataSource?: (turn: number, kind: string) => SnapshotSource<readonly unknown[]>
  get?: (key: string) => unknown
}

interface ChatSnapshotLike {
  order?: readonly string[]
  nodes?: ChatStoreLike
  /** Ordered node keys per turn; the source of visibility-correct cards. */
  locations?: { getTurn?: (turn: number) => readonly string[] }
}

export interface TurnTailProps {
  turn?: { turn?: number; status?: string }
  seq?: number
  sessionId?: string
  runtime: ClientRuntime
  /** Chat store hooks supplied by the slot runtime. */
  useChat?: (selector: Selector) => unknown
  useConversation?: (selector: Selector) => unknown
}

const EMPTY: readonly unknown[] = []

/**
 * Render every `a2ui` surface produced by one completed turn.
 *
 * The per-turn observable is preferred; the `order` + `nodes` walk stays as a
 * fallback for a Host whose snapshot predates `turnDataSource`.
 */
export function A2uiTurnTail(props: TurnTailProps): ReturnType<typeof h> | null {
  const { turn, sessionId, runtime } = props
  const useChat = props.useChat
  const turnNumber = turn?.turn

  const store = useChat?.((state) => (state as ChatSnapshotLike).nodes) as ChatStoreLike | undefined
  const source = React.useMemo(() => {
    if (store === undefined || turnNumber === undefined) return undefined
    try {
      return store.turnDataSource?.(turnNumber, 'tool-call')
    } catch {
      return undefined
    }
  }, [store, turnNumber])

  const subscribe = React.useCallback(
    (listener: () => void) => (source === undefined ? () => {} : source.subscribe(listener)),
    [source],
  )
  const getSnapshot = React.useCallback(() => (source === undefined ? EMPTY : source.getSnapshot()), [source])
  // The third argument keeps server-side rendering (and the render harness) working.
  const turnToolData = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // `turnDataSource` includes hidden nodes, so the cards come from the turn's
  // ordered node keys instead, read fresh on every notification.
  const turnKeys = useChat?.((state) => {
    const locations = (state as ChatSnapshotLike).locations
    return typeof locations?.getTurn === 'function' && turnNumber !== undefined ? locations.getTurn(turnNumber) : undefined
  }) as readonly string[] | undefined

  // Fallback reader for a Host without `locations`/`turnDataSource`.
  const order = (useChat?.((state) => (state as ChatSnapshotLike).order) ?? []) as string[]
  const nodes = store

  const entries: A2uiRootEntry[] = React.useMemo(() => {
    void turnToolData
    const roots = turnKeys === undefined
      ? collectA2uiRoots(order, nodes, turnNumber, 'a2ui')
      : rootsFromTurnNodes(turnNumber, turnKeys, nodes, 'a2ui')
    return roots.filter(({ phase, root }) => phase !== 'result' || root.isError !== true)
  }, [turnKeys, turnToolData, order, nodes, turnNumber])

  if (entries.length === 0) return null

  return h(
    'div',
    { className: 'a2ui-tail' },
    ...entries.map((entry) =>
      h(A2UIToolView, {
        key: entry.key,
        // The call id is what the row copy uses, so both hosts claim the same id.
        callId: entry.root.callId ?? entry.key,
        toolName: 'a2ui',
        phase: entry.phase,
        block: entry.root,
        sessionId,
        mode: 'tail',
        runtime,
      }),
    ),
  )
}

/**
 * Copy claims: which rendered copy of a surface currently exists elsewhere.
 *
 * The card is rendered from two hosts — the process row (`tool.call.toolview`)
 * and the turn tail (`conversation.chat.turnTail`). Only one copy should be
 * visible at a time, but a copy must never *vanish*: the turn tail can be
 * unmounted by the transcript (paging, a new turn, an aborted turn), and losing
 * the interface entirely is the worst possible outcome.
 *
 * So the tail *claims* a copy while it is mounted; the process row renders the
 * full card unless a claim exists. When the tail unmounts, its cleanup releases
 * the claim and the process row restores the card by itself.
 *
 * State is per browser tab and per session, never persisted: replay always
 * starts from "no claims", which is the safe direction.
 */

interface ClaimKey {
  sessionId: string
  callId: string
}

const claims = new Map<string, Map<string, number>>()
const listeners = new Set<() => void>()

function keyOf(sessionId: string | undefined, callId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof callId !== 'string' || callId === '') return undefined
  return `${sessionId}\u0000${callId}`
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A subscriber that throws must not break the claim/release that is in
      // progress, nor the other subscribers.
    }
  }
}

/** Whether another host currently renders this call's card. */
export function isCopyClaimed(sessionId: string | undefined, callId: string | undefined): boolean {
  const key = keyOf(sessionId, callId)
  if (key === undefined) return false
  const [session, call] = key.split('\u0000') as [string, string]
  return (claims.get(session)?.get(call) ?? 0) > 0
}

/**
 * Claim a rendered copy.
 * @returns idempotent disposer that releases the claim once.
 */
export function claimCopy(sessionId: string | undefined, callId: string | undefined): () => void {
  const key = keyOf(sessionId, callId)
  if (key === undefined) return () => {}
  const [session, call] = key.split('\u0000') as [string, string]
  const perSession = claims.get(session) ?? new Map<string, number>()
  perSession.set(call, (perSession.get(call) ?? 0) + 1)
  claims.set(session, perSession)
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    const current = claims.get(session)
    if (current === undefined) return
    const next = (current.get(call) ?? 0) - 1
    if (next > 0) current.set(call, next)
    else current.delete(call)
    if (current.size === 0) claims.delete(session)
    notify()
  }
}

/** Subscribe to claim changes (used by the hook below). */
export function subscribeClaims(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test/debug helper: drop every claim. */
export function resetClaims(): void {
  claims.clear()
  notify()
}

/** Every live claim, for diagnostics. */
export function listClaims(): ClaimKey[] {
  const out: ClaimKey[] = []
  for (const [sessionId, perSession] of claims) {
    for (const [callId, count] of perSession) {
      for (let index = 0; index < count; index += 1) out.push({ sessionId, callId })
    }
  }
  return out
}

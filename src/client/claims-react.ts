/** React bindings for the copy-claim registry. */
import * as React from 'react'
import { claimCopy, isCopyClaimed, subscribeClaims } from './claims.js'

/** Whether another host is currently showing this call's card. */
export function useCopyClaimed(sessionId: string | undefined, callId: string | undefined): boolean {
  const read = React.useCallback(() => isCopyClaimed(sessionId, callId), [sessionId, callId])
  const [claimed, setClaimed] = React.useState(read)
  React.useEffect(() => {
    setClaimed(read())
    return subscribeClaims(() => setClaimed(read()))
  }, [read])
  return claimed
}

/** Claim a copy while mounted; the cleanup restores the other host's card. */
export function useClaimCopy(sessionId: string | undefined, callId: string | undefined, enabled: boolean): void {
  React.useEffect(() => {
    if (!enabled) return undefined
    return claimCopy(sessionId, callId)
  }, [sessionId, callId, enabled])
}

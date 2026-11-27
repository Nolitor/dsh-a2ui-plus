/**
 * Correlating an agent's `callRendererFunction` with the renderer's answer.
 *
 * The call is a request/response pair that crosses two channels: the request goes
 * down the WebSocket as a `CUSTOM` frame, the answer comes back up the same
 * socket as another `CUSTOM` frame. This module owns the gap between them — the
 * pending map, the timeout, and cancellation — and nothing else.
 *
 * Why not answer over RPC: the renderer already holds the socket, and a function
 * call is not initiated by the browser. Making the browser open a request it did
 * not start would turn a push into a poll.
 */
/** Largest answer accepted from a renderer, in characters of JSON. */
export const MAX_RESULT_CHARS = 65_536;
/** Default time a request waits for its renderer before it fails. */
export const DEFAULT_TIMEOUT_MS = 5_000;
/** Why a request failed. */
export class ActionTimeoutError extends Error {
    code = 'renderer-timeout';
    constructor(surfaceId, functionName, timeoutMs) {
        super(`the renderer did not answer ${functionName} for surface "${surfaceId}" within ${timeoutMs}ms`);
        this.name = 'ActionTimeoutError';
    }
}
/** Correlated renderer requests, keyed by surface. */
export class PendingActions {
    pending = new Map();
    timeoutMs;
    /**
     * @param timeoutMs how long one request may wait for its renderer answer.
     */
    constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    }
    /**
     * Start waiting for one answer.
     * @param surfaceId the surface whose renderer owns the function.
     * @param functionName the function the answer must name.
     * @param signal caller cancellation.
     * @returns the renderer's answer value.
     */
    request(surfaceId, functionName, signal) {
        // A second request for the same surface replaces the first: one renderer can
        // only be answering one call at a time, and the older promise must not hang.
        this.settle(surfaceId, new Error(`superseded by a newer ${functionName} request for surface "${surfaceId}"`));
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, functionName };
            entry.timer = setTimeout(() => {
                this.pending.delete(surfaceId);
                reject(new ActionTimeoutError(surfaceId, functionName, this.timeoutMs));
            }, this.timeoutMs);
            // A pending request must never keep the Host process alive on its own.
            entry.timer.unref?.();
            if (signal !== undefined) {
                if (signal.aborted) {
                    clearTimeout(entry.timer);
                    reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
                    return;
                }
                entry.signal = signal;
                entry.onAbort = () => {
                    this.pending.delete(surfaceId);
                    clearTimeout(entry.timer);
                    reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
                };
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            this.pending.set(surfaceId, entry);
        });
    }
    /**
     * Deliver one renderer answer.
     *
     * A reply that names a different function than the pending request is refused
     * rather than delivered — that is how a crossed or replayed answer is caught.
     * @param surfaceId the surface the answer belongs to.
     * @param functionName the function the renderer claims it ran.
     * @param value the answer value.
     * @returns whether a pending request consumed it.
     */
    settle(surfaceId, value, functionName) {
        const entry = this.pending.get(surfaceId);
        if (entry === undefined)
            return false;
        if (functionName !== undefined && functionName !== entry.functionName)
            return false;
        this.pending.delete(surfaceId);
        if (entry.timer !== undefined)
            clearTimeout(entry.timer);
        if (entry.signal !== undefined && entry.onAbort !== undefined) {
            entry.signal.removeEventListener('abort', entry.onAbort);
        }
        if (value instanceof Error)
            entry.reject(value);
        else
            entry.resolve(value);
        return true;
    }
    /** Whether a surface has a request waiting. */
    has(surfaceId) {
        return this.pending.has(surfaceId);
    }
    /** Fail every pending request (plugin teardown or socket loss). */
    dispose(reason = new Error('the renderer channel closed')) {
        for (const surfaceId of [...this.pending.keys()])
            this.settle(surfaceId, reason);
        this.pending.clear();
    }
}

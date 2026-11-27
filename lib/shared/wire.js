/**
 * Wire constants both halves must agree on.
 *
 * Kept in `shared/` rather than `host/` because the browser half imports them:
 * pulling `host/transport.js` into the client bundle would drag `node:crypto`
 * with it.
 */
/** RPC channel carrying renderer requests. No `/` allowed by Connection. */
export const RPC_CHANNEL = '/a2ui-plus';
/** RPC endpoint for a renderer function request. */
export const RPC_ACTION_ENDPOINT = 'action';
/** WebSocket path for the Host -> renderer downlink. */
export const WS_PATH = '/a2ui/ws';
/** Subprotocol negotiated on the downlink; versioned so a stale browser is refused. */
export const WS_PROTOCOL = 'a2ui-plus.v1';
/** Every subprotocol this Host accepts, in preference order. */
export const WS_PROTOCOLS = [WS_PROTOCOL];

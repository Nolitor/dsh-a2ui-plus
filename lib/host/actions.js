/**
 * The renderer-function channel: the uplink half of `callRendererFunction`.
 *
 * A2UI 1.0 lets the agent ask the renderer to run a function locally and receive
 * its answer (`callRendererFunction` → `rendererFunctionResponse`). Upstream
 * `dsh-a2ui` rejects both messages because it had no carrier for the reply; this
 * module is that carrier, and the allowlist here is what keeps the security
 * posture equal to the one upstream chose.
 *
 * Two invariants matter more than the feature:
 *
 * - **Only six function names exist, ever.** The agent names a function; if it is
 *   not in {@link RENDERER_FUNCTIONS} the request is refused before any renderer
 *   sees it. There is no dispatch by arbitrary string.
 * - **The Host never vouches for a gesture.** It reports `gestureRequired` and
 *   forwards; the gate itself is `client/executor.ts`, which reads
 *   `navigator.userActivation.isActive` and asks the user to confirm. An earlier
 *   version accepted the agent's own `gesture: true` flag here, which let the
 *   model authorize its own browser actions — the flag is now ignored.
 *
 * The Host's share of the admission is therefore name, argument shape and surface
 * ownership. Execution, scheme admission and the gesture gate are the browser's.
 */
import { RPC_ACTION_ENDPOINT, RPC_CHANNEL } from './transport.js';
import { RENDERER_FUNCTION_CAPABILITIES } from '../shared/catalog.js';
/**
 * The renderer-side functions an agent may call.
 *
 * Derived from the catalog table so the name the model is told about and the name
 * the Host accepts are one declaration. Adding a function is a change in one place.
 */
export const RENDERER_FUNCTIONS = RENDERER_FUNCTION_CAPABILITIES.map((entry) => entry.name);
/** The allowlist, with the argument shape each function accepts. */
export const RENDERER_SPECS = Object.freeze({
    openUrl: {
        kind: 'gesture',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'An http(s) URL.' } },
            required: ['url'],
            additionalProperties: false,
        },
    },
    scrollTo: {
        kind: 'local',
        parameters: {
            type: 'object',
            properties: {
                componentId: { type: 'string', description: 'A component id inside the same surface.' },
                behavior: { type: 'string', enum: ['auto', 'smooth'] },
            },
            required: ['componentId'],
            additionalProperties: false,
        },
    },
    copyToClipboard: {
        kind: 'gesture',
        parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
        },
    },
    downloadFile: {
        kind: 'gesture',
        parameters: {
            type: 'object',
            properties: {
                filename: { type: 'string' },
                text: { type: 'string' },
                mimeType: { type: 'string' },
            },
            required: ['filename', 'text'],
            additionalProperties: false,
        },
    },
    validateForm: {
        kind: 'pure',
        parameters: {
            type: 'object',
            properties: {
                surfaceId: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
        },
    },
    requestFilePicker: {
        kind: 'gesture',
        parameters: {
            type: 'object',
            properties: {
                accept: { type: 'string', description: 'A MIME type or extension list such as ".csv".' },
                multiple: { type: 'boolean' },
            },
            additionalProperties: false,
        },
    },
});
/** One refused request: a name outside the allowlist or a bad argument shape. */
export const REFUSAL = Object.freeze({
    /** The function is not in {@link RENDERER_FUNCTIONS}. */
    unknownFunction: 'unknown-function',
    /** Arguments did not match the function's schema. */
    invalidArguments: 'invalid-arguments',
    /** The function needs a user gesture and none was offered. */
    gestureRequired: 'gesture-required',
    /** The request was malformed before the function was even read. */
    malformedRequest: 'malformed-request',
    /** The renderer that owns the surface is not attached. */
    rendererAbsent: 'renderer-absent',
});
/** Whether a name is on the allowlist. */
export function isRendererFunction(name) {
    return typeof name === 'string' && RENDERER_FUNCTIONS.includes(name);
}
/** Whether a function may run without a user gesture. */
export function needsGesture(name) {
    return RENDERER_SPECS[name].kind === 'gesture';
}
/**
 * Whether the catalog and the Host agree.
 *
 * Asserted by the tests, and cheap enough to keep: a divergence here would let the
 * model call something the Host refuses, or miss something it allows.
 */
export function capabilitiesMatch() {
    const advertised = RENDERER_FUNCTION_CAPABILITIES.map((entry) => `${entry.name}:${entry.kind}`).sort();
    const accepted = Object.keys(RENDERER_SPECS)
        .map((name) => `${name}:${RENDERER_SPECS[name].kind}`)
        .sort();
    return advertised.length === accepted.length && advertised.every((entry, index) => entry === accepted[index]);
}
export function admitRequest(payload) {
    if (typeof payload !== 'object' || payload === null) {
        return { ok: false, reason: REFUSAL.malformedRequest, message: 'the request must be an object' };
    }
    const request = payload;
    const surfaceId = request.surfaceId;
    if (typeof surfaceId !== 'string' || surfaceId === '') {
        return { ok: false, reason: REFUSAL.malformedRequest, message: 'surfaceId must be a non-empty string' };
    }
    const functionName = request.functionName;
    if (!isRendererFunction(functionName)) {
        return {
            ok: false,
            reason: REFUSAL.unknownFunction,
            message: `"${String(functionName)}" is not a renderer function; the allowlist is ${RENDERER_FUNCTIONS.join(', ')}`,
        };
    }
    const args = request.args ?? {};
    const violation = checkArguments(functionName, args);
    if (violation !== undefined) {
        return { ok: false, reason: REFUSAL.invalidArguments, message: violation };
    }
    // NOTE: `request.gesture` is deliberately ignored here.
    //
    // It is a field the *agent* writes into its own request, so treating it as
    // proof of a user gesture let the model authorize itself. The gesture gate now
    // lives in the browser (`client/executor.ts`), which reads
    // `navigator.userActivation.isActive` and asks the user to confirm. The Host
    // admits the request and reports the requirement; it never vouches for it.
    return { ok: true, surfaceId, functionName, args, gestureRequired: needsGesture(functionName) };
}
/**
 * Check one argument object against a function's schema.
 *
 * Deliberately small: required keys, declared keys, and primitive types. A full
 * JSON Schema engine would be a dependency for six fixed shapes.
 * @param name the admitted function.
 * @param args the arguments to check.
 * @returns a violation message, or `undefined` when they fit.
 */
export function checkArguments(name, args) {
    const schema = RENDERER_SPECS[name].parameters;
    if (typeof args !== 'object' || args === null || Array.isArray(args))
        return 'args must be an object';
    const record = args;
    const declared = schema.properties ?? {};
    for (const key of schema.required ?? []) {
        if (!Object.hasOwn(record, key))
            return `args.${key} is required`;
    }
    for (const [key, value] of Object.entries(record)) {
        const property = declared[key];
        if (property === undefined)
            return `args.${key} is not a property of ${name}`;
        if (value === undefined || value === null)
            continue;
        if (property.type === 'string' && typeof value !== 'string')
            return `args.${key} must be a string`;
        if (property.type === 'boolean' && typeof value !== 'boolean')
            return `args.${key} must be a boolean`;
        if (property.type === 'array' && !Array.isArray(value))
            return `args.${key} must be an array`;
        if (property.enum !== undefined && !property.enum.includes(value)) {
            return `args.${key} must be one of ${property.enum.join(', ')}`;
        }
    }
    return undefined;
}
/** RPC endpoint a browser calls when its patched copy has drifted. */
export const RPC_RESYNC_ENDPOINT = 'resync';
/**
 * Install the uplink RPC channel.
 * @param ctx Host plugin context carrying `connection`.
 * @param dispatch performs one admitted function against the owning renderer.
 */
export function installUplink(ctx, dispatch, resync) {
    const rpc = ctx.connection?.rpc;
    if (rpc === undefined || typeof rpc.handle !== 'function') {
        ctx.logger?.warn?.('a2ui-plus: connection.rpc is unavailable, the renderer-function uplink stays off');
        return;
    }
    ctx.effect(() => rpc.handle(RPC_CHANNEL, async (endpoint, payload, signal) => {
        if (endpoint === RPC_RESYNC_ENDPOINT) {
            // The browser could not patch its copy. The answer is authoritative
            // snapshots, built from the store now, so the client adopts them the
            // same way it adopts a reconnect baseline.
            if (resync === undefined) {
                return { ok: false, error: { code: 'not-supported', message: 'resync is not installed', details: {} } };
            }
            const request = (payload ?? {});
            const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
            if (sessionId === '') {
                return { ok: true, value: { frames: [] } };
            }
            const surfaceIds = Array.isArray(request.surfaceIds)
                ? request.surfaceIds.filter((entry) => typeof entry === 'string')
                : [];
            return { ok: true, value: { frames: resync(sessionId, surfaceIds) } };
        }
        if (endpoint !== RPC_ACTION_ENDPOINT) {
            return { ok: false, error: { code: 'not-found', message: `unknown endpoint ${endpoint}`, details: {} } };
        }
        const admitted = admitRequest(payload);
        if (!admitted.ok) {
            // Narrowing needs `strict`, which this package builds without; the
            // union member is read explicitly rather than by discriminant flow.
            const refusal = admitted;
            return { ok: true, value: { kind: 'refused', reason: refusal.reason, message: refusal.message } };
        }
        try {
            const value = await dispatch(admitted.surfaceId, admitted.functionName, admitted.args, signal);
            if (value === undefined) {
                return {
                    ok: true,
                    value: { kind: 'refused', reason: REFUSAL.rendererAbsent, message: 'no renderer is attached to that surface' },
                };
            }
            return { ok: true, value: { kind: 'response', functionName: admitted.functionName, value } };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: { code: 'internal', message, details: {} } };
        }
    }), 'a2ui-plus: uplink rpc');
}
/** Channel constants re-exported so the browser half and tests share one value. */
export { RPC_ACTION_ENDPOINT, RPC_CHANNEL };

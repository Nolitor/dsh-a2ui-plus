/**
 * The transport between the browser half and the Host half.
 *
 * Two channels, because they carry different traffic:
 *
 * - **Uplink** — `ctx.connection.rpc.handle(CHANNEL, handler)`: one request, one
 *   answer. A renderer asks the Host to run one whitelisted function and waits
 *   for its response. The channel name may not contain `/` (Connection validates
 *   `/^\/[A-Za-z0-9._~-]+$/u`), so it is `/a2ui-plus` with endpoint `action`.
 * - **Downlink** — `ctx.webServer.registerUpgrade({ path: WS_PATH })`: a
 *   server-push WebSocket, the same shape `dsh-better-sidebar` uses for its
 *   `sidebar_open` queue. Routine state never travels over RPC, so a surface can
 *   update several times a second without a request per change.
 *
 * Both registrations return a disposer and both are installed through
 * `ctx.effect`, so unloading the plugin leaves no listener, socket or route
 * behind.
 *
 * **Reconnect baseline.** A socket that attaches is handed a snapshot synthesized
 * from the Host's current state at attach time — not the last frame this registry
 * happened to send. A late or returning browser therefore starts from the same
 * picture the store holds now, and the revision it carries is the store's real
 * revision rather than a transport counter.
 *
 * **Keepalive.** A reverse proxy drops an idle socket, so the Host pings on an
 * interval and answers a client ping with a pong. A socket that never answers is
 * reaped.
 */
import { createHash } from 'node:crypto';
import { WS_PATH, WS_PROTOCOL, WS_PROTOCOLS } from '../shared/wire.js';
export { RPC_CHANNEL, RPC_ACTION_ENDPOINT, WS_PATH, WS_PROTOCOL } from '../shared/wire.js';
/** Interval between Host pings, in milliseconds. */
export const PING_INTERVAL_MS = 25_000;
/** How long a socket may stay silent before it is reaped. */
export const SOCKET_IDLE_TIMEOUT_MS = 90_000;
/**
 * Per-session push registry.
 *
 * One session can have more than one attachment (two tabs, or the side card and
 * the conversation). A frame fans out to every one of them.
 */
export class DownlinkRegistry {
    attachments = new Map();
    baseline;
    /**
     * @param baseline synthesizes the reconnect snapshot. Omitted, a new socket
     *   receives nothing until the next push.
     */
    constructor(baseline) {
        this.baseline = baseline;
    }
    /** Replace the baseline provider (the Surface Store arrives after the registry). */
    setBaselineProvider(provider) {
        this.baseline = provider;
    }
    /**
     * Attach one browser and hand it the current state.
     * @param sessionId the session this socket speaks for.
     * @param attachment the send/close pair owning the socket.
     * @returns the detach function.
     */
    attach(sessionId, attachment) {
        let set = this.attachments.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.attachments.set(sessionId, set);
        }
        set.add(attachment);
        // The baseline is read at attach time, so a browser that reconnects after a
        // long gap still starts from the store's present rather than from a queue.
        const frames = this.baseline?.(sessionId) ?? [];
        for (const frame of frames) {
            try {
                attachment.send(frame);
            }
            catch {
                this.attachments.get(sessionId)?.delete(attachment);
                attachment.close();
                return () => { };
            }
        }
        return () => {
            const current = this.attachments.get(sessionId);
            if (current === undefined)
                return;
            current.delete(attachment);
            if (current.size === 0)
                this.attachments.delete(sessionId);
        };
    }
    /**
     * Push one frame to every attached browser of a session.
     * @param sessionId target session.
     * @param frame the frame to deliver. Its `surfaceRevision` comes from the store.
     * @returns how many attachments received it.
     */
    push(sessionId, frame) {
        const set = this.attachments.get(sessionId);
        if (set === undefined)
            return 0;
        for (const attachment of set) {
            try {
                attachment.send(frame);
            }
            catch (error) {
                // A broken socket must not stop the others, and must not keep a dead
                // attachment alive.
                this.attachments.get(sessionId)?.delete(attachment);
                attachment.close();
                void error;
            }
        }
        return set.size;
    }
    /** Whether a session currently has any attached browser. */
    has(sessionId) {
        return (this.attachments.get(sessionId)?.size ?? 0) > 0;
    }
    /** Every session with at least one attachment. */
    sessions() {
        return [...this.attachments.keys()].filter((sessionId) => this.has(sessionId));
    }
    /** Drop every attachment (plugin teardown). */
    dispose() {
        for (const set of this.attachments.values()) {
            for (const attachment of set)
                attachment.close();
        }
        this.attachments.clear();
    }
}
/**
 * Install the downlink WebSocket route.
 *
 * The socket carries no protocol of its own: each message is one JSON frame, and
 * the session is bound by the `sessionId` query parameter, so a socket never
 * needs to name a session again. A socket that omits `sessionId` is refused —
 * routing by "whatever is open" would leak one conversation's surfaces into
 * another.
 * @param ctx Host plugin context carrying `webServer`.
 * @param registry the push registry to attach sockets to.
 */
export function installDownlink(ctx, registry) {
    const server = ctx.webServer;
    if (server === undefined || typeof server.registerUpgrade !== 'function') {
        ctx.logger?.warn?.('a2ui-plus: webServer is unavailable, the sidebar downlink stays off');
        return;
    }
    const live = new Set();
    ctx.effect(() => server.registerUpgrade({
        path: WS_PATH,
        handler: (req, socket) => attachSocket(req, socket, registry, ctx, live),
    }), 'a2ui-plus: downlink websocket');
    ctx.effect(() => () => {
        for (const stop of live)
            stop();
        live.clear();
    }, 'a2ui-plus: downlink keepalive');
}
/**
 * Adopt one upgraded socket.
 *
 * Written against the raw `node:http` upgrade signature so it does not depend on
 * the `ws` package being installed at runtime: a plugin that ships its own
 * WebSocket implementation would add a dependency the Host already carries one
 * for. `ws` is only a devDependency, used by the tests to drive a real client.
 * @param req the upgrade request.
 * @param socket the raw duplex.
 * @param registry session push registry.
 * @param ctx Host plugin context for diagnostics.
 * @param live mutable set of keepalive teardowns, owned by the route.
 */
function attachSocket(req, socket, registry, ctx, live) {
    // A refusal must answer in HTTP before the socket closes, or the client sees a
    // bare reset and cannot tell a rejection from a crash.
    const refuse = (status, reason, message) => {
        try {
            socket.write?.([`HTTP/1.1 ${status} ${reason}`, 'Connection: close', 'Content-Length: 0', '', ''].join('\r\n'));
        }
        catch {
            // A socket that cannot be written is closing anyway.
        }
        socket.destroy?.();
        ctx.logger?.warn?.(`a2ui-plus: downlink socket refused (${message})`);
    };
    const sessionId = sessionIdOf(req?.url);
    if (sessionId === undefined) {
        refuse('400', 'Bad Request', 'no sessionId');
        return;
    }
    const key = req?.headers?.['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') {
        refuse('400', 'Bad Request', 'no Sec-WebSocket-Key');
        return;
    }
    const protocol = negotiateProtocol(req?.headers?.['sec-websocket-protocol']);
    if (protocol === undefined) {
        // A client that asks for a protocol we do not speak is refused at the
        // handshake instead of silently talking a different dialect.
        refuse('400', 'Bad Request', 'unsupported subprotocol');
        return;
    }
    socket.write?.([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        `Sec-WebSocket-Protocol: ${protocol}`,
        '',
        '',
    ].join('\r\n'));
    const send = (frame) => writeTextFrame(socket, JSON.stringify(frame));
    const attachment = { send, close: () => socket.destroy?.() };
    const detach = registry.attach(sessionId, attachment);
    let lastSeen = Date.now();
    let closed = false;
    const stop = () => {
        if (closed)
            return;
        closed = true;
        clearInterval(heartbeat);
        live.delete(stop);
        detach();
    };
    // A reverse proxy drops an idle socket, so the Host speaks first. PONG (0xA) is
    // its own answer; a client PING (0x9) is echoed back as PONG.
    const heartbeat = setInterval(() => {
        if (closed)
            return;
        if (Date.now() - lastSeen > SOCKET_IDLE_TIMEOUT_MS) {
            socket.destroy?.();
            stop();
            return;
        }
        writeControlFrame(socket, 0x9, Buffer.alloc(0));
    }, PING_INTERVAL_MS);
    heartbeat.unref?.();
    live.add(stop);
    socket.on?.('data', (chunk) => {
        lastSeen = Date.now();
        for (const frame of decodeFrames(chunk)) {
            if (frame.opcode === 0x8) {
                // Close: answer it, then stop.
                writeControlFrame(socket, 0x8, Buffer.alloc(0));
                socket.destroy?.();
                stop();
                return;
            }
            if (frame.opcode === 0x9)
                writeControlFrame(socket, 0xa, frame.payload);
            if (frame.opcode === 0xa)
                continue;
            // A downlink pushes only. A text frame from the client is ignored on
            // purpose: the uplink is the RPC channel, not this socket.
        }
    });
    socket.on?.('close', stop);
    socket.on?.('error', stop);
    socket.on?.('end', stop);
}
/**
 * Pick the subprotocol to answer with.
 *
 * A client that offers none is accepted on the current protocol, because the
 * browser `WebSocket` constructor only sends the header when asked and a socket
 * that speaks the only dialect this Host has is not ambiguous. A client that
 * offers subprotocols must include one we speak.
 * @param header the raw `Sec-WebSocket-Protocol` header.
 * @returns the chosen protocol, or `undefined` when nothing is acceptable.
 */
export function negotiateProtocol(header) {
    if (header === undefined || header === null || header === '')
        return WS_PROTOCOL;
    const offered = (Array.isArray(header) ? header.join(',') : String(header))
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
    if (offered.length === 0)
        return WS_PROTOCOL;
    return WS_PROTOCOLS.find((protocol) => offered.includes(protocol));
}
/** Read `sessionId` out of an upgrade request URL. */
export function sessionIdOf(url) {
    if (typeof url !== 'string')
        return undefined;
    const query = url.indexOf('?');
    if (query < 0)
        return undefined;
    const params = new URLSearchParams(url.slice(query + 1));
    const sessionId = params.get('sessionId');
    return sessionId === null || sessionId === '' ? undefined : sessionId;
}
/**
 * RFC 6455 accept value for a client key.
 * @param key the `Sec-WebSocket-Key` header value.
 * @returns the base64 SHA-1 of key + GUID.
 */
export function acceptKey(key) {
    return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}
/**
 * Write one unmasked text frame.
 *
 * Frames above 64 KiB use the 64-bit length form; nothing here fragments, because
 * a baseline snapshot is written whole.
 * @param socket raw duplex.
 * @param text the JSON payload.
 */
export function writeTextFrame(socket, text) {
    writeFrame(socket, 0x1, Buffer.from(text, 'utf8'));
}
/**
 * Write one control frame (ping, pong, close). Control payloads stay under 126
 * bytes, per RFC 6455.
 * @param socket raw duplex.
 * @param opcode the control opcode.
 * @param payload the control payload.
 */
export function writeControlFrame(socket, opcode, payload) {
    writeFrame(socket, opcode, payload);
}
/** Encode and write one unmasked server frame. */
function writeFrame(socket, opcode, payload) {
    const header = [0x80 | opcode];
    if (payload.length < 126)
        header.push(payload.length);
    else if (payload.length < 0x1_0000)
        header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
    else {
        header.push(127, 0, 0, 0, 0, (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff);
    }
    socket.write?.(Buffer.concat([Buffer.from(header), payload]));
}
/**
 * Decode the frames in one client chunk.
 *
 * Client frames are masked, so the mask is applied here rather than trusted away.
 * A partial frame at the end of a chunk is dropped: this socket carries no
 * application data, so nothing here needs reassembly.
 * @param chunk a raw chunk as received from the socket.
 * @returns every complete frame in the chunk.
 */
export function decodeFrames(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const frames = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let cursor = offset + 2;
        if (length === 126) {
            if (cursor + 2 > buffer.length)
                break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        }
        else if (length === 127) {
            if (cursor + 8 > buffer.length)
                break;
            length = Number(buffer.readBigUInt64BE(cursor));
            cursor += 8;
        }
        let mask;
        if (masked) {
            if (cursor + 4 > buffer.length)
                break;
            mask = buffer.subarray(cursor, cursor + 4);
            cursor += 4;
        }
        if (cursor + length > buffer.length)
            break;
        const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
        if (mask !== undefined) {
            for (let index = 0; index < payload.length; index += 1)
                payload[index] ^= mask[index % 4];
        }
        frames.push({ opcode, payload });
        offset = cursor + length;
    }
    return frames;
}

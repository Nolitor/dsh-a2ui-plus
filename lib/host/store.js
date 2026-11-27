/**
 * The Host's authoritative picture of every A2UI surface it has rendered.
 *
 * A surface lives in one namespace, `/surfaces/{surfaceId}`, and the Host — not
 * the browser — decides what each change is:
 *
 * - A new surface, or a full redeclaration, becomes an `ACTIVITY_SNAPSHOT`.
 * - A `updateDataModel` write becomes an RFC 6902 `STATE_DELTA`, built by
 *   comparing the path against the store's own data model: `replace` when the
 *   pointer already resolves, `add` when it does not.
 * - A repeat `updateComponents` becomes a `STATE_DELTA` touching that subtree.
 *
 * Every change bumps one `revision` per session and stamps it on the frame, so a
 * client can drop anything not newer without trusting arrival order. The store —
 * not the transport — owns that number, which is what makes a reconnect baseline
 * carry the store's real revision instead of a transport counter.
 */
/** Largest number of surfaces one session may hold. */
export const MAX_SURFACES_PER_SESSION = 64;
/** Per-session surface store. */
export class SurfaceStore {
    surfaces = new Map();
    revision = 0;
    maxSurfaces;
    /**
     * Identity of this store's lifetime.
     *
     * A Host restart builds a new store, whose revision counter starts at zero
     * again. Without an epoch a browser holding revision 40 would reject the new
     * store's revision 1 snapshot as stale and keep a dead surface forever. The
     * epoch is generated per store instance, so a restart is visible.
     */
    epoch = makeEpoch();
    /**
     * @param maxSurfaces cap on retained surfaces; the oldest is evicted past it.
     */
    constructor(maxSurfaces = MAX_SURFACES_PER_SESSION) {
        this.maxSurfaces = maxSurfaces > 0 ? maxSurfaces : MAX_SURFACES_PER_SESSION;
    }
    /** The session's current revision (0 before anything was applied). */
    currentRevision() {
        return this.revision;
    }
    /** The epoch every frame from this store is stamped with. */
    currentEpoch() {
        return this.epoch;
    }
    /** One surface, or `undefined` when the session never rendered it. */
    get(surfaceId) {
        return this.surfaces.get(surfaceId);
    }
    /** Every surface, oldest change first. */
    list() {
        return [...this.surfaces.values()].sort((left, right) => left.revision - right.revision);
    }
    /** Whether the session holds this surface. */
    has(surfaceId) {
        return this.surfaces.has(surfaceId);
    }
    /**
     * Apply one validated message batch.
     *
     * The batch is folded in order, exactly like the renderer folds it, so the
     * store's state and the card on screen cannot disagree.
     * @param messages the validated A2UI messages of one call.
     * @param placement where the call asked to render.
     * @returns the changes to publish, in application order.
     */
    apply(messages, placement = 'inline') {
        const options = typeof placement === 'string' ? { placement } : placement;
        const where = options.placement ?? 'inline';
        const changes = [];
        for (const message of messages) {
            if (typeof message !== 'object' || message === null)
                continue;
            const entry = message;
            if ('createSurface' in entry && entry.createSurface !== undefined) {
                changes.push(this.create(entry.createSurface, where, options.title));
                continue;
            }
            if ('updateComponents' in entry && entry.updateComponents !== undefined) {
                const change = this.updateComponents(entry.updateComponents);
                if (change !== undefined)
                    changes.push(change);
                continue;
            }
            if ('updateDataModel' in entry && entry.updateDataModel !== undefined) {
                const change = this.updateDataModel(entry.updateDataModel);
                if (change !== undefined)
                    changes.push(change);
                continue;
            }
            if ('deleteSurface' in entry && entry.deleteSurface !== undefined) {
                const change = this.delete(entry.deleteSurface.surfaceId);
                if (change !== undefined)
                    changes.push(change);
            }
        }
        return changes;
    }
    /**
     * Fold one `createSurface`.
     *
     * A redeclaration of a surface the session already holds is a snapshot too: it
     * replaces the whole surface, and only a snapshot can express that without the
     * client first having to reconstruct the old tree.
     */
    create(payload, placement, title) {
        this.revision += 1;
        const state = {
            surfaceId: payload.surfaceId,
            catalogId: typeof payload.catalogId === 'string' ? payload.catalogId : '',
            dataModel: payload.dataModel ?? {},
            components: new Map(),
            root: typeof payload.root === 'string' ? payload.root : undefined,
            placement,
            revision: this.revision,
            ...(typeof title === 'string' && title !== '' ? { title } : {}),
        };
        this.surfaces.set(payload.surfaceId, state);
        this.evict();
        return { surfaceId: payload.surfaceId, kind: 'snapshot', state };
    }
    /** Fold one `updateComponents` into a delta touching only that subtree. */
    updateComponents(payload) {
        const state = this.surfaces.get(payload.surfaceId);
        if (state === undefined)
            return undefined;
        this.revision += 1;
        const delta = [];
        for (const component of payload.components) {
            if (typeof component !== 'object' || component === null)
                continue;
            const record = component;
            const id = record.id;
            if (typeof id !== 'string' || id === '')
                continue;
            delta.push({
                op: state.components.has(id) ? 'replace' : 'add',
                path: `/surfaces/${escapePointer(payload.surfaceId)}/components/${escapePointer(id)}`,
                value: component,
            });
            state.components.set(id, component);
        }
        if (delta.length === 0)
            return undefined;
        state.revision = this.revision;
        return { surfaceId: payload.surfaceId, kind: 'delta', delta };
    }
    /**
     * Fold one `updateDataModel` into a single RFC 6902 operation.
     *
     * The operation is chosen by asking the store whether the pointer resolves:
     * a write to an existing location is `replace`, a write to a new one is `add`.
     * That is the whole difference between the two, and only the store knows which
     * applies.
     */
    updateDataModel(payload) {
        const state = this.surfaces.get(payload.surfaceId);
        if (state === undefined)
            return undefined;
        this.revision += 1;
        const path = normalisePointer(payload.path);
        const target = pointerPath(payload.surfaceId, path);
        // The data model itself always exists, so a root write replaces it rather
        // than adding a property.
        const exists = path === '/' || resolvesTo(state.dataModel, path);
        applyToModel(state, path, payload.value);
        state.revision = this.revision;
        return {
            surfaceId: payload.surfaceId,
            kind: 'delta',
            delta: [{ op: exists ? 'replace' : 'add', path: target, value: payload.value }],
        };
    }
    /** Fold one `deleteSurface`. */
    delete(surfaceId) {
        if (!this.surfaces.has(surfaceId))
            return undefined;
        this.revision += 1;
        this.surfaces.delete(surfaceId);
        return {
            surfaceId,
            kind: 'delta',
            delta: [{ op: 'remove', path: `/surfaces/${escapePointer(surfaceId)}` }],
        };
    }
    /** Keep at most `maxSurfaces`, dropping the least recently changed. */
    evict() {
        if (this.surfaces.size <= this.maxSurfaces)
            return;
        const oldest = this.list();
        for (const surface of oldest.slice(0, this.surfaces.size - this.maxSurfaces)) {
            this.surfaces.delete(surface.surfaceId);
        }
    }
}
/**
 * Frames one session must start from.
 *
 * Synthesized from the store at call time — the store's present, not the last
 * frame a previous socket happened to receive. Each surface carries the store's
 * own revision, so a client that has an older frame drops it.
 * @param store the session's surfaces.
 * @param messagesFor returns the original A2UI messages for a surface, so the
 *   snapshot a renderer receives is the one it would have received live.
 * @returns one `ACTIVITY_SNAPSHOT` per surface.
 */
export function baselineFrames(store, messagesFor) {
    return store.list().map((surface) => ({
        type: 'ACTIVITY_SNAPSHOT',
        surfaceId: surface.surfaceId,
        activityType: 'a2ui.surface',
        messageId: surface.surfaceId,
        surfaceRevision: surface.revision,
        surfaceEpoch: store.currentEpoch(),
        content: {
            surfaceId: surface.surfaceId,
            placement: surface.placement,
            ...(surface.title === undefined ? {} : { title: surface.title }),
            catalogId: surface.catalogId,
            messages: messagesFor(surface.surfaceId) ?? [],
            dataModel: surface.dataModel,
            components: [...surface.components.values()],
        },
        replace: true,
    }));
}
/**
 * Mint one store lifetime identity.
 *
 * Time plus randomness: two Hosts started in the same millisecond must not share
 * an epoch, and the value has to survive a JSON round trip unchanged.
 */
function makeEpoch() {
    const time = Date.now().toString(36);
    const noise = Math.floor(Math.random() * 0xffff_ffff).toString(36);
    return `${time}-${noise}`;
}
/** Escape one JSON Pointer segment (RFC 6901). */
export function escapePointer(segment) {
    return segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
/** Unescape one JSON Pointer segment (RFC 6901). */
export function unescapePointer(segment) {
    return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}
/** A pointer in the store's own form: `/` for the root, otherwise `/a/b`. */
export function normalisePointer(path) {
    if (typeof path !== 'string' || path === '' || path === '/')
        return '/';
    return path.startsWith('/') ? path : `/${path}`;
}
/**
 * The full store-relative pointer for one surface path.
 *
 * A surface's data model lives at `/surfaces/{id}/dataModel`, so the root
 * pointer addresses that property — never the surface object, which also carries
 * the components and the revision.
 */
export function pointerPath(surfaceId, path) {
    const base = `/surfaces/${escapePointer(surfaceId)}/dataModel`;
    return path === '/' ? base : `${base}${path}`;
}
/** Split a JSON Pointer into unescaped segments. The root is `[]`. */
export function pointerSegments(path) {
    if (path === '' || path === '/')
        return [];
    return path.slice(1).split('/').map(unescapePointer);
}
/**
 * Whether a pointer resolves in a document.
 *
 * A missing key, a non-object in the way, or an out-of-range index is unresolved —
 * which is what makes the caller choose `add` instead of `replace`.
 * @param document the document to walk.
 * @param pointer the pointer, in store form.
 */
export function resolvesTo(document, pointer) {
    const segments = pointerSegments(pointer);
    if (segments.length === 0)
        return false;
    let cursor = document;
    for (const segment of segments) {
        if (Array.isArray(cursor)) {
            if (!/^\d+$/u.test(segment))
                return false;
            const index = Number(segment);
            if (index >= cursor.length)
                return false;
            cursor = cursor[index];
            continue;
        }
        if (typeof cursor !== 'object' || cursor === null)
            return false;
        if (!Object.hasOwn(cursor, segment))
            return false;
        cursor = cursor[segment];
    }
    return true;
}
/**
 * Write one value into a surface's data model, following the same pointer rules
 * the delta describes.
 * @param state the surface to mutate.
 * @param pointer the store-form pointer.
 * @param value the value to write.
 */
export function applyToModel(state, pointer, value) {
    const segments = pointerSegments(pointer);
    if (segments.length === 0) {
        state.dataModel = value;
        return;
    }
    let cursor = state.dataModel;
    if (typeof cursor !== 'object' || cursor === null) {
        cursor = {};
        state.dataModel = cursor;
    }
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        const next = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
        if (typeof next !== 'object' || next === null) {
            const created = /^\d+$/u.test(segments[index + 1]) ? [] : {};
            if (Array.isArray(cursor))
                cursor[Number(segment)] = created;
            else
                cursor[segment] = created;
            cursor = created;
            continue;
        }
        cursor = next;
    }
    const last = segments[segments.length - 1];
    if (Array.isArray(cursor) && /^\d+$/u.test(last))
        cursor[Number(last)] = value;
    else if (Array.isArray(cursor) && last === '-')
        cursor.push(value);
    else
        cursor[last] = value;
}

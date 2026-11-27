/**
 * A2UI 1.0 message validation and surface folding.
 *
 * The Host calls {@link validateToolArguments} before accepting a tool call;
 * the browser calls {@link applyMessageBatch} to fold a validated batch into the
 * renderer state. Both share one implementation so the two sides cannot drift.
 */
import { isJsonValue, isPlainObject, MAX_JSON_DEPTH, pointerViolation, pointerWrite } from './json.js';
import { LIMITS, limitMessage } from './limits.js';
import { childReferences } from './graph.js';
import { estimateExpansion } from './budget.js';
import { BASIC_CATALOG_ID, CATALOG_IDS, COMPONENT_BY_NAME, EXTENSION_CATALOG_ID, PROTOCOL_VERSION, accessibilityValidator, componentAllowedIn, metadataValidator, resolveCatalogId, } from './catalog.js';
import { fail } from './schema.js';
export const PRESENTATIONS = ['card', 'compact'];
export function isPresentation(value) {
    return value === 'card' || value === 'compact';
}
/** Messages that change a surface; the function pair is validated but not folded. */
const MESSAGE_KINDS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];
/** Messages carrying a renderer-function request or answer. */
export const FUNCTION_KINDS = ['callRendererFunction', 'agentFunctionResponse'];
const ALL_MESSAGE_KEYS = [
    'createSurface',
    'updateComponents',
    'updateDataModel',
    'deleteSurface',
    'callRendererFunction',
    'agentFunctionResponse',
];
function invalidEnvelope(message, path, out) {
    const keys = Object.keys(message);
    if (!Object.prototype.hasOwnProperty.call(message, 'version')) {
        fail(out, `${path}/version`, 'is required and must be "1.0"');
    }
    else if (message.version !== PROTOCOL_VERSION) {
        fail(out, `${path}/version`, `must be "1.0" (got ${JSON.stringify(message.version)}); v0.8 and v0.9 payloads are not accepted`);
    }
    const unknown = keys.filter((key) => key !== 'version' && !ALL_MESSAGE_KEYS.includes(key));
    if (unknown.length > 0)
        fail(out, path, `has unsupported properties: ${unknown.join(', ')}`);
    const kinds = keys.filter((key) => ALL_MESSAGE_KEYS.includes(key));
    if (kinds.length !== 1) {
        fail(out, path, `must contain exactly one of ${ALL_MESSAGE_KEYS.join(', ')} (got ${kinds.length === 0 ? 'none' : kinds.join(', ')})`);
        return undefined;
    }
    const kind = kinds[0];
    // The function pair is no longer refused outright: this plugin carries the
    // reply channel upstream lacked. What stays narrow is the function *name*, and
    // that check lives in `host/actions.ts`; here the envelope and the name are
    // checked so a model gets a precise path before anything is dispatched.
    if (kind === 'callRendererFunction') {
        checkCallRendererFunction(message[kind], `${path}/${kind}`, out);
        return kind;
    }
    if (kind === 'agentFunctionResponse') {
        checkAgentFunctionResponse(message[kind], `${path}/${kind}`, out);
        return kind;
    }
    return kind;
}
/** The renderer functions a `callRendererFunction` may name. */
const RENDERER_FUNCTION_NAMES = [
    'openUrl',
    'scrollTo',
    'copyToClipboard',
    'downloadFile',
    'validateForm',
    'requestFilePicker',
];
/**
 * Check one `callRendererFunction` envelope.
 *
 * The name is admitted only when it is on the allowlist, so an unknown function
 * is rejected at the model's own call — before the Host opens a channel for it.
 */
function checkCallRendererFunction(value, path, out) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(out, path, 'must be an object');
        return;
    }
    const payload = value;
    for (const key of ['surfaceId', 'functionCallId', 'callFunction']) {
        if (!Object.hasOwn(payload, key))
            fail(out, `${path}/${key}`, 'is required');
    }
    checkSurfaceId(payload.surfaceId, `${path}/surfaceId`, out);
    if (payload.functionCallId !== undefined && (typeof payload.functionCallId !== 'string' || payload.functionCallId === '')) {
        fail(out, `${path}/functionCallId`, 'must be a non-empty string');
    }
    const call = payload.callFunction;
    if (call === undefined)
        return;
    if (call === null || typeof call !== 'object' || Array.isArray(call)) {
        fail(out, `${path}/callFunction`, 'must be an object');
        return;
    }
    const callFunction = call;
    const name = callFunction['@call'];
    if (typeof name !== 'string' || name === '') {
        fail(out, `${path}/callFunction/@call`, 'is required');
        return;
    }
    if (!RENDERER_FUNCTION_NAMES.includes(name)) {
        fail(out, `${path}/callFunction/@call`, `"${name}" is not a renderer function; the allowlist is ${RENDERER_FUNCTION_NAMES.join(', ')}`);
    }
}
/** Check one `agentFunctionResponse` envelope. */
function checkAgentFunctionResponse(value, path, out) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(out, path, 'must be an object');
        return;
    }
    const payload = value;
    for (const key of ['surfaceId', 'functionCallId', 'response']) {
        if (!Object.hasOwn(payload, key))
            fail(out, `${path}/${key}`, 'is required');
    }
    checkSurfaceId(payload.surfaceId, `${path}/surfaceId`, out);
    if (payload.functionCallId !== undefined && (typeof payload.functionCallId !== 'string' || payload.functionCallId === '')) {
        fail(out, `${path}/functionCallId`, 'must be a non-empty string');
    }
}
function checkSurfaceId(value, path, out) {
    if (typeof value !== 'string' || value === '') {
        fail(out, path, 'must be a non-empty string');
        return undefined;
    }
    if (value.length > LIMITS.maxIdLength) {
        fail(out, path, limitMessage('surfaceId length', LIMITS.maxIdLength, value.length));
        return undefined;
    }
    if (!/^[A-Za-z0-9._:-]+$/u.test(value)) {
        fail(out, path, 'must contain only letters, digits, ".", "_", ":" or "-"');
        return undefined;
    }
    return value;
}
function checkCatalogId(value, path, out) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string') {
        fail(out, path, 'must be a string');
        return undefined;
    }
    if (!CATALOG_IDS.has(value)) {
        fail(out, path, `is not a known catalog; use "${BASIC_CATALOG_ID}" or a catalog id listed by a2ui_catalog`);
        return undefined;
    }
    return value;
}
function checkDataModel(value, path, out) {
    if (!isPlainObject(value)) {
        fail(out, path, 'must be a JSON object');
        return;
    }
    if (!isJsonValue(value))
        fail(out, path, 'must be a lossless JSON value');
}
/**
 * Property aliases the published v1.0 catalog examples use.
 *
 * The upstream examples spell some system properties with a leading `@`
 * (`"@checks"`); this renderer's components use the plain name. Both are
 * accepted, an alias and its plain form must agree, and the alias is dropped so
 * the rest of the pipeline only ever sees one shape.
 */
const PROPERTY_ALIASES = [
    ['@checks', 'checks'],
    ['@catalogId', 'catalogId'],
    ['@accessibility', 'accessibility'],
    ['@metadata', 'metadata'],
];
const CSS_JUSTIFY_ALIASES = new Map([
    ['space-around', 'spaceAround'],
    ['space-between', 'spaceBetween'],
    ['space-evenly', 'spaceEvenly'],
]);
function normalizeAliases(component, path, out) {
    if (!isPlainObject(component))
        return component;
    let normalized;
    for (const [alias, name] of PROPERTY_ALIASES) {
        if (!Object.prototype.hasOwnProperty.call(component, alias))
            continue;
        const value = component[alias];
        if (Object.prototype.hasOwnProperty.call(component, name)) {
            if (JSON.stringify(component[name]) !== JSON.stringify(value)) {
                fail(out, `${path}/${alias}`, `conflicts with "${name}"; keep one of them`);
                continue;
            }
            normalized = normalized ?? { ...component };
            delete normalized[alias];
            continue;
        }
        normalized = normalized ?? { ...component };
        delete normalized[alias];
        normalized[name] = value;
    }
    if ((component.component === 'Row' || component.component === 'Column') && typeof component.justify === 'string') {
        const justify = CSS_JUSTIFY_ALIASES.get(component.justify);
        if (justify !== undefined) {
            normalized = normalized ?? { ...component };
            normalized.justify = justify;
        }
    }
    return normalized ?? component;
}
function checkComponentShape(component, path, out) {
    if (!isPlainObject(component)) {
        fail(out, path, 'must be an object');
        return undefined;
    }
    const id = component.id;
    if (typeof id !== 'string' || id === '') {
        fail(out, `${path}/id`, 'must be a non-empty string');
        return undefined;
    }
    if (id.length > LIMITS.maxIdLength) {
        fail(out, `${path}/id`, limitMessage('component id length', LIMITS.maxIdLength, id.length));
        return undefined;
    }
    if (!/^[A-Za-z0-9._:-]+$/u.test(id)) {
        fail(out, `${path}/id`, 'must contain only letters, digits, ".", "_", ":" or "-"');
        return undefined;
    }
    if (typeof component.component !== 'string' || component.component === '') {
        fail(out, `${path}/component`, 'must name the component type (e.g. "Text")');
        return undefined;
    }
    if (component.component === 'Surface') {
        fail(out, `${path}/component`, '"Surface" is the implicit protocol container and must not be declared as a component');
        return undefined;
    }
    return component;
}
/** Property-level validation against the catalog entry. */
function checkComponentProperties(component, catalogId, path, out, isExtensionCatalog) {
    const spec = COMPONENT_BY_NAME.get(component.component);
    if (spec === undefined) {
        const known = [...COMPONENT_BY_NAME.keys()].join(', ');
        fail(out, `${path}/component`, `unknown component "${component.component}". Known components: ${known}`);
        return;
    }
    if (!componentAllowedIn(catalogId, spec.name)) {
        fail(out, `${path}/component`, `"${spec.name}" belongs to the dsh-a2ui extension catalog, not the official basic catalog; set createSurface.catalogId to the extension catalog id`);
        return;
    }
    const common = new Set(['id', 'component', 'catalogId', 'accessibility', 'metadata', 'weight']);
    for (const key of Object.keys(component)) {
        if (common.has(key))
            continue;
        if (!Object.prototype.hasOwnProperty.call(spec.properties, key)) {
            const message = spec.name === 'Text' && key === 'usageHint'
                ? 'is not a property of Text in A2UI 1.0. Use "variant" with "body" or "caption".'
                : `is not a property of ${spec.name}`;
            fail(out, `${path}/${key}`, message);
        }
    }
    if (component.accessibility !== undefined)
        accessibilityValidator(component.accessibility, `${path}/accessibility`, out);
    if (component.metadata !== undefined)
        metadataValidator(component.metadata, `${path}/metadata`, out);
    for (const key of spec.required) {
        if (!Object.prototype.hasOwnProperty.call(component, key))
            fail(out, path, `is missing required property "${key}" for ${spec.name}`);
    }
    const weightValidator = spec.properties.weight;
    if (weightValidator !== undefined && component.weight !== undefined)
        weightValidator(component.weight, `${path}/weight`, out);
    for (const [key, validator] of Object.entries(spec.properties)) {
        if (key === 'weight')
            continue;
        const value = component[key];
        if (value === undefined)
            continue;
        validator(value, `${path}/${key}`, out);
    }
    spec.check?.(component, path, out);
    if (isExtensionCatalog && spec.origin === 'basic')
        return;
}
/**
 * Child references are collected by `graph.ts`, which the render budget also
 * uses; re-exported here for callers that already import from the validator.
 */
export { childReferences };
/**
 * Validate a single component in isolation: shape, catalog and every property.
 *
 * The settled path validates a whole call, which a streaming preview cannot do —
 * a component whose children are still being written is normal there, and the
 * graph is incomplete by definition. What *is* decidable for a closed component
 * object is exactly what this reuses from the settled path, so a preview can
 * never draw a component the settled path would reject.
 *
 * @param value the component value, already recovered from the payload.
 * @param catalogId the catalog the enclosing surface declares.
 * @param path diagnostic path.
 */
export function checkComponentAlone(value, catalogId, path = '/component') {
    const errors = [];
    const normalized = normalizeAliases(value, path, errors);
    const component = checkComponentShape(normalized, path, errors);
    if (component === undefined)
        return { errors };
    const declared = checkCatalogId(component.catalogId, `${path}/catalogId`, errors);
    const resolved = resolveCatalogId(catalogId, declared);
    if (resolved === undefined) {
        fail(errors, path, `cannot resolve catalog "${declared ?? catalogId}"`);
        return { errors };
    }
    checkComponentProperties(component, resolved, path, errors, resolved !== BASIC_CATALOG_ID);
    return errors.length === 0 ? { component, errors } : { errors };
}
function checkGraph(graph) {
    const { components, strict, errors, warnings, pathPrefix } = graph;
    if (components.size === 0)
        return;
    if (!components.has('root')) {
        const message = 'the component tree needs a component with id "root" (createSurface wraps it in the implicit Surface container)';
        if (strict)
            fail(errors, pathPrefix, message);
        else
            warnings.push(`${pathPrefix}: ${message}`);
    }
    for (const component of components.values()) {
        for (const reference of childReferences(component)) {
            if (components.has(reference.id))
                continue;
            const message = `component "${component.id}" references missing child "${reference.id}" in ${reference.field}`;
            if (strict)
                fail(errors, `${pathPrefix}/${component.id}/${reference.field}`, message);
            else
                warnings.push(message);
        }
    }
    // Depth and cycle check from the root (and from every orphan when non-strict).
    const state = new Map();
    let deepest = 0;
    const visit = (id, depth, chain) => {
        if (depth > deepest)
            deepest = depth;
        if (depth > LIMITS.maxDepth) {
            fail(errors, `${pathPrefix}/${id}`, limitMessage('component depth', LIMITS.maxDepth, depth));
            return;
        }
        const status = state.get(id);
        if (status === 'visiting') {
            fail(errors, `${pathPrefix}/${id}`, `circular component reference: ${[...chain, id].join(' -> ')}`);
            return;
        }
        if (status === 'done')
            return;
        state.set(id, 'visiting');
        const component = components.get(id);
        if (component !== undefined) {
            for (const reference of childReferences(component)) {
                if (components.has(reference.id))
                    visit(reference.id, depth + 1, [...chain, id]);
            }
        }
        state.set(id, 'done');
    };
    if (components.has('root'))
        visit('root', 1, []);
    if (!strict) {
        for (const id of components.keys())
            if (!state.has(id))
                visit(id, 1, []);
    }
}
function applyComponents(previous, surfaceId, catalogId, components, sendDataModel, dataModel) {
    const map = new Map(previous?.components ?? []);
    const order = [...(previous?.order ?? [])];
    const changed = [];
    for (const component of components) {
        if (!map.has(component.id))
            order.push(component.id);
        // `updateComponents` replaces the listed component's definition; components
        // not listed keep their previous definition (A2UI 1.0 merge semantics).
        map.set(component.id, component);
        changed.push(component.id);
    }
    return {
        state: {
            surfaceId,
            catalogId,
            components: map,
            order,
            dataModel,
            sendDataModel,
        },
        changed,
    };
}
/**
 * Fold a batch of already shape-checked messages into surface state.
 *
 * @param surfaces current state (not mutated).
 * @param messages validated messages.
 */
export function applyMessageBatch(surfaces, messages, onRefuse) {
    // Every message reads the *latest* state of this batch, so a create followed
    // by an update/data update/delete in the same tool call composes instead of
    // silently losing the earlier message.
    const current = new Map(surfaces);
    const touched = new Map();
    const mark = (surfaceId) => {
        let entry = touched.get(surfaceId);
        if (entry === undefined) {
            entry = { created: false, deleted: false, changed: [], dataModel: false };
            touched.set(surfaceId, entry);
        }
        return entry;
    };
    for (const [messageIndex, message] of messages.entries()) {
        if ('createSurface' in message) {
            const payload = message.createSurface;
            const base = current.get(payload.surfaceId);
            const catalogId = payload.catalogId ?? base?.catalogId ?? '';
            const dataModel = payload.dataModel ?? base?.dataModel ?? {};
            const { state, changed } = applyComponents(base, payload.surfaceId, catalogId, payload.components ?? [], payload.sendDataModel ?? base?.sendDataModel ?? false, dataModel);
            current.set(payload.surfaceId, state);
            const entry = mark(payload.surfaceId);
            entry.created = true;
            // A surface re-created after a delete in the same batch is live again.
            entry.deleted = false;
            entry.changed.push(...changed);
            continue;
        }
        if ('updateComponents' in message) {
            const payload = message.updateComponents;
            const base = current.get(payload.surfaceId);
            const catalogId = base?.catalogId ?? '';
            const { state, changed } = applyComponents(base, payload.surfaceId, catalogId, payload.components, base?.sendDataModel ?? false, base?.dataModel ?? {});
            current.set(payload.surfaceId, state);
            mark(payload.surfaceId).changed.push(...changed);
            continue;
        }
        if ('updateDataModel' in message) {
            const payload = message.updateDataModel;
            const base = current.get(payload.surfaceId);
            if (base === undefined)
                continue;
            const path = payload.path === undefined || payload.path === '/' ? '/' : payload.path;
            const write = pointerWrite(base.dataModel, path, payload.value);
            if (write.status === 'refused' && write.reason !== undefined) {
                // The write is dropped, so the caller must hear about it instead of
                // reporting a successful update that changed nothing.
                onRefuse?.({ messageIndex, surfaceId: payload.surfaceId, path, reason: write.reason });
                continue;
            }
            current.set(payload.surfaceId, { ...base, dataModel: write.value });
            mark(payload.surfaceId).dataModel = true;
            continue;
        }
        if ('deleteSurface' in message) {
            const payload = message.deleteSurface;
            current.delete(payload.surfaceId);
            const entry = mark(payload.surfaceId);
            entry.deleted = true;
            entry.created = false;
            entry.changed = [];
        }
    }
    const touches = [...touched.entries()].map(([surfaceId, entry]) => ({
        surfaceId,
        created: entry.created,
        deleted: entry.deleted,
        changedComponentIds: entry.changed,
        dataModelChanged: entry.dataModel,
    }));
    return { surfaces: current, touches };
}
// `pointerSet` is imported from json.ts above.
/**
 * Validate one `a2ui` tool call's arguments.
 * @param input the raw `arguments` value reported by the model.
 */
export function validateToolArguments(input) {
    const errors = [];
    const warnings = [];
    const surfaces = new Map();
    const messages = [];
    if (!isPlainObject(input)) {
        return { ok: false, errors: [{ path: '', message: 'arguments must be an object' }], warnings, surfaces: [], messages: [], states: new Map() };
    }
    const unknownRoot = Object.keys(input).filter((key) => key !== 'messages' && key !== 'title' && key !== 'presentation' && key !== 'placement');
    if (unknownRoot.length > 0)
        fail(errors, '', `has unsupported properties: ${unknownRoot.join(', ')}`);
    if (input.placement !== undefined && input.placement !== 'inline' && input.placement !== 'sidebar') {
        fail(errors, '/placement', 'must be "inline" or "sidebar"');
    }
    if (input.title !== undefined && typeof input.title !== 'string')
        fail(errors, '/title', 'must be a string');
    if (typeof input.title === 'string' && input.title.length > 200)
        fail(errors, '/title', 'must be at most 200 characters');
    if (input.presentation !== undefined && !isPresentation(input.presentation)) {
        fail(errors, '/presentation', 'must be "card" or "compact"');
    }
    const raw = input.messages;
    if (!Array.isArray(raw)) {
        fail(errors, '/messages', 'is required and must be an array of A2UI 1.0 messages');
        return { ok: false, errors, warnings, surfaces: [], messages: [], states: new Map() };
    }
    if (raw.length === 0)
        fail(errors, '/messages', 'must contain at least one message');
    if (raw.length > LIMITS.maxMessages) {
        fail(errors, '/messages', limitMessage('message count', LIMITS.maxMessages, raw.length));
    }
    // Depth is checked before anything walks the payload: `JSON.stringify` and a
    // recursive validator both overflow on a deeply nested array, so the bound is
    // enforced here, in the same iterative pass that proves it is JSON at all.
    if (!isJsonValue(raw)) {
        fail(errors, '/messages', `must be lossless JSON no deeper than ${MAX_JSON_DEPTH} levels`);
        return { ok: false, errors, warnings, surfaces: [], messages: [], states: new Map() };
    }
    const serialized = safeStringify(raw);
    if (serialized !== undefined && serialized.length > LIMITS.maxPayloadChars) {
        fail(errors, '/messages', limitMessage('payload size in characters', LIMITS.maxPayloadChars, serialized.length));
    }
    // Surface bookkeeping is local to this batch: the Host holds no per-session
    // surface state, so an update may legitimately address a surface an earlier
    // call created. `liveSurfaces` therefore only tracks what this batch made.
    const createdHere = new Set();
    const liveSurfaces = new Map();
    const batchComponents = new Map();
    for (let index = 0; index < raw.length; index += 1) {
        const path = `/messages/${index}`;
        const candidate = raw[index];
        if (!isPlainObject(candidate)) {
            fail(errors, path, 'must be an object');
            continue;
        }
        const kind = invalidEnvelope(candidate, path, errors);
        if (kind === undefined)
            continue;
        const payload = candidate[kind];
        if (!isPlainObject(payload)) {
            fail(errors, `${path}/${kind}`, 'must be an object');
            continue;
        }
        // A renderer-function message touches no surface state: it is an envelope the
        // Host dispatches. Its own check already ran in `invalidEnvelope`, and it must
        // not fall through into the component-graph path below.
        if (FUNCTION_KINDS.includes(kind)) {
            messages.push(candidate);
            continue;
        }
        const allowed = {
            createSurface: ['surfaceId', 'catalogId', 'sendDataModel', 'components', 'dataModel', 'metadata'],
            updateComponents: ['surfaceId', 'components'],
            updateDataModel: ['surfaceId', 'path', 'value'],
            deleteSurface: ['surfaceId'],
        };
        for (const key of Object.keys(payload)) {
            if (!(allowed[kind] ?? []).includes(key))
                fail(errors, `${path}/${kind}`, `has unsupported property "${key}"`);
        }
        const surfaceId = checkSurfaceId(payload.surfaceId, `${path}/${kind}/surfaceId`, errors);
        if (surfaceId === undefined)
            continue;
        const surfaceCatalogId = checkCatalogId(payload.catalogId, `${path}/${kind}/catalogId`, errors);
        if (kind === 'deleteSurface') {
            // Removing the surface also removes this lifecycle's graph, catalog and
            // creation record, so a later create in the same batch starts fresh.
            createdHere.delete(surfaceId);
            liveSurfaces.delete(surfaceId);
            batchComponents.delete(surfaceId);
            messages.push({ version: PROTOCOL_VERSION, deleteSurface: { surfaceId } });
            continue;
        }
        if (kind === 'updateDataModel') {
            if (!Object.prototype.hasOwnProperty.call(payload, 'value')) {
                fail(errors, `${path}/${kind}`, 'is missing required property "value" (use null to delete a key)');
            }
            else if (!isJsonValue(payload.value)) {
                fail(errors, `${path}/${kind}/value`, 'must be a lossless JSON value');
            }
            if (payload.path !== undefined) {
                const violation = pointerViolation(payload.path);
                if (violation !== undefined)
                    fail(errors, `${path}/${kind}/path`, violation);
            }
            messages.push({
                version: PROTOCOL_VERSION,
                updateDataModel: { surfaceId, path: payload.path, value: payload.value },
            });
            continue;
        }
        // createSurface / updateComponents
        // A create must be validated the same way whether or not it inlines
        // components, and a second create for a surface that is still live in this
        // batch is a protocol error rather than a silent merge.
        if (kind === 'createSurface') {
            if (liveSurfaces.has(surfaceId)) {
                fail(errors, `${path}/${kind}/surfaceId`, `surface "${surfaceId}" already exists in this batch; send deleteSurface first, or use updateComponents to change it`);
                continue;
            }
            if (payload.sendDataModel !== undefined && typeof payload.sendDataModel !== 'boolean') {
                fail(errors, `${path}/${kind}/sendDataModel`, 'must be a boolean');
            }
            if (payload.dataModel !== undefined)
                checkDataModel(payload.dataModel, `${path}/${kind}/dataModel`, errors);
            if (payload.metadata !== undefined) {
                if (!isPlainObject(payload.metadata))
                    fail(errors, `${path}/${kind}/metadata`, 'must be an object');
                else if (payload.metadata.extensions !== undefined && !isPlainObject(payload.metadata.extensions)) {
                    fail(errors, `${path}/${kind}/metadata/extensions`, 'must be an object');
                }
            }
        }
        const rawComponents = payload.components;
        // A surface created in this batch owns its catalog; later component updates
        // in the same batch inherit it instead of falling back to the default.
        const inheritedCatalog = kind === 'createSurface' ? (surfaceCatalogId ?? EXTENSION_CATALOG_ID) : (liveSurfaces.get(surfaceId) ?? EXTENSION_CATALOG_ID);
        const effectiveCatalog = resolveCatalogId(inheritedCatalog, undefined) ?? inheritedCatalog;
        if (rawComponents === undefined) {
            if (kind === 'updateComponents')
                fail(errors, `${path}/${kind}`, 'is missing required property "components"');
            messages.push({
                version: PROTOCOL_VERSION,
                createSurface: {
                    surfaceId,
                    catalogId: effectiveCatalog,
                    ...(payload.sendDataModel === undefined ? {} : { sendDataModel: payload.sendDataModel }),
                    ...(payload.dataModel === undefined ? {} : { dataModel: payload.dataModel }),
                },
            });
            if (kind === 'createSurface') {
                createdHere.add(surfaceId);
                liveSurfaces.set(surfaceId, effectiveCatalog);
                batchComponents.set(surfaceId, new Map());
            }
            continue;
        }
        if (!Array.isArray(rawComponents)) {
            fail(errors, `${path}/${kind}/components`, 'must be an array');
            continue;
        }
        if (rawComponents.length === 0)
            fail(errors, `${path}/${kind}/components`, 'must contain at least one component');
        if (rawComponents.length > LIMITS.maxComponentsPerMessage) {
            fail(errors, `${path}/${kind}/components`, limitMessage('components per message', LIMITS.maxComponentsPerMessage, rawComponents.length));
        }
        if (kind === 'createSurface') {
            // A fresh instance: never inherit components from a deleted one.
            createdHere.add(surfaceId);
            liveSurfaces.set(surfaceId, effectiveCatalog);
            batchComponents.set(surfaceId, new Map());
        }
        const seen = new Map();
        const accepted = [];
        for (let position = 0; position < rawComponents.length; position += 1) {
            const componentPath = `${path}/${kind}/components/${position}`;
            const raw = normalizeAliases(rawComponents[position], componentPath, errors);
            const component = checkComponentShape(raw, componentPath, errors);
            if (component === undefined)
                continue;
            if (seen.has(component.id)) {
                fail(errors, componentPath, `duplicates component id "${component.id}" already declared at index ${seen.get(component.id) ?? 0} in this message`);
                continue;
            }
            seen.set(component.id, position);
            const componentCatalog = checkCatalogId(component.catalogId, `${componentPath}/catalogId`, errors);
            const catalogId = resolveCatalogId(effectiveCatalog, componentCatalog);
            if (catalogId === undefined) {
                fail(errors, componentPath, `cannot resolve catalog "${componentCatalog ?? effectiveCatalog}"`);
                continue;
            }
            checkComponentProperties(component, catalogId, componentPath, errors, catalogId !== BASIC_CATALOG_ID);
            accepted.push(component);
            const surfaceComponents = batchComponents.get(surfaceId) ?? new Map();
            surfaceComponents.set(component.id, component);
            batchComponents.set(surfaceId, surfaceComponents);
        }
        if (kind === 'createSurface') {
            createdHere.add(surfaceId);
            messages.push({
                version: PROTOCOL_VERSION,
                createSurface: {
                    surfaceId,
                    catalogId: surfaceCatalogId ?? EXTENSION_CATALOG_ID,
                    ...(payload.sendDataModel === undefined ? {} : { sendDataModel: payload.sendDataModel }),
                    ...(payload.dataModel === undefined ? {} : { dataModel: payload.dataModel }),
                    components: accepted,
                },
            });
        }
        else {
            messages.push({ version: PROTOCOL_VERSION, updateComponents: { surfaceId, components: accepted } });
        }
    }
    // Per-surface graph checks over everything this batch declares.
    for (const [surfaceId, components] of batchComponents) {
        const strict = createdHere.has(surfaceId);
        checkGraph({
            components,
            strict,
            errors,
            warnings,
            pathPrefix: `/surfaces/${surfaceId}`,
        });
        if (components.size > LIMITS.maxComponentsPerSurface) {
            fail(errors, `/surfaces/${surfaceId}`, limitMessage('components per surface', LIMITS.maxComponentsPerSurface, components.size));
        }
    }
    if (createdHere.size > LIMITS.maxSurfacesPerCall) {
        fail(errors, '', limitMessage('surfaces per call', LIMITS.maxSurfacesPerCall, createdHere.size));
    }
    if (errors.length > 0) {
        return { ok: false, errors, warnings, surfaces: [], messages: [], states: new Map() };
    }
    // The fold both produces the final state and reports writes it had to drop, so
    // a refused `updateDataModel` becomes a locatable error instead of a silent
    // success.
    const refusals = [];
    const folded = applyMessageBatch(surfaces, messages, (refusal) => refusals.push(refusal));
    for (const refusal of refusals) {
        fail(errors, `/messages/${refusal.messageIndex}/updateDataModel/path`, `cannot write ${JSON.stringify(refusal.path)} on surface "${refusal.surfaceId}": ${refusal.reason}`);
    }
    // Render budget: a small definition graph can still expand into a huge React
    // tree through template repetition. Reject it here, before any element exists.
    // The per-surface cap is applied together with a whole-call total, because a
    // multi-surface payload could otherwise stay under every per-surface limit.
    let totalNodes = 0;
    let totalDataUnits = 0;
    for (const touch of folded.touches) {
        if (touch.deleted)
            continue;
        const state = folded.surfaces.get(touch.surfaceId);
        if (state === undefined)
            continue;
        const estimate = estimateExpansion(state);
        if (estimate.reason !== undefined) {
            fail(errors, `/surfaces/${touch.surfaceId}${estimate.path ?? ''}`, `surface "${touch.surfaceId}" ${estimate.reason}`);
            continue;
        }
        totalNodes += estimate.nodes;
        totalDataUnits += estimate.dataUnits;
    }
    if (totalNodes > LIMITS.maxTotalExpandedNodes) {
        fail(errors, '', `this call renders ${totalNodes} components in total across its surfaces, above the ${LIMITS.maxTotalExpandedNodes} limit`);
    }
    if (totalDataUnits > LIMITS.maxTotalExpandedDataUnits) {
        fail(errors, '', `this call renders ${totalDataUnits} data rows, points or animation items in total across its surfaces, above the ${LIMITS.maxTotalExpandedDataUnits} limit`);
    }
    if (errors.length > 0)
        return { ok: false, errors, warnings, surfaces: [], messages: [], states: new Map() };
    const summary = folded.touches
        .filter((touch) => touch.created || touch.changedComponentIds.length > 0 || touch.dataModelChanged || touch.deleted)
        .map((touch) => {
        const state = folded.surfaces.get(touch.surfaceId);
        return {
            surfaceId: touch.surfaceId,
            catalogId: state?.catalogId ?? '',
            components: state?.components.size ?? 0,
            deleted: touch.deleted,
        };
    });
    for (const touch of folded.touches) {
        if (touch.changedComponentIds.length === 0 && !touch.created && !touch.deleted && !touch.dataModelChanged) {
            warnings.push(`surface "${touch.surfaceId}" was referenced but nothing changed`);
        }
        else if (!touch.created && !touch.deleted && !surfaces.has(touch.surfaceId) && touch.changedComponentIds.length > 0) {
            warnings.push(`surface "${touch.surfaceId}" was updated here but not created in this tool call; if no earlier call created it, nothing will render. Send a createSurface message first.`);
        }
    }
    return { ok: true, errors, warnings, surfaces: summary, messages, states: folded.surfaces };
}
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
/** Whether a value looks like a v1.0 message envelope (used by diagnostics only). */
export function looksLikeMessage(value) {
    return isPlainObject(value) && (MESSAGE_KINDS.some((kind) => kind in value) || 'version' in value);
}

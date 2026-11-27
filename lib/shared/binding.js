/**
 * Data-model binding resolution.
 *
 * The same resolver runs in the Host (to check that a payload's bindings are
 * well formed) and in the browser (to render values). It never executes a
 * string: a `{"@call": "name"}` object can only select an entry of the closed
 * `FUNCTIONS` table.
 */
import { isFunctionCall, isDataBinding } from './schema.js';
import { pointerGet } from './json.js';
import { FUNCTIONS, truthyValidation } from './functions.js';
const MAX_RESOLVE_DEPTH = 16;
function bindingPath(value) {
    const pointer = value['@path'] ?? value.path;
    return typeof pointer === 'string' ? pointer : undefined;
}
function callName(value) {
    const name = value['@call'] ?? value.call;
    return typeof name === 'string' ? name : undefined;
}
/** Resolve a `{"@path": ...}` binding, honouring relative paths inside a template item. */
export function resolveBinding(pointer, context) {
    if (pointer === '' || pointer === '/')
        return context.dataModel;
    if (pointer.startsWith('/')) {
        const result = pointerGet(context.dataModel, pointer);
        return result.found ? result.value : undefined;
    }
    const relative = pointerGet(context.item, `/${pointer}`);
    if (relative.found)
        return relative.value;
    const absolute = pointerGet(context.dataModel, `/${pointer}`);
    return absolute.found ? absolute.value : undefined;
}
function resolveArgs(args, context, depth) {
    if (args === null || typeof args !== 'object' || Array.isArray(args))
        return {};
    const out = {};
    for (const [key, value] of Object.entries(args)) {
        out[key] = resolveValue(value, context, depth + 1);
    }
    return out;
}
function makeEnvironment(context, depth) {
    return {
        locale: context.locale,
        index: context.index,
        now: context.now,
        evaluate: (value) => resolveValue(value, context, depth + 1),
    };
}
/** Resolve any dynamic value: literal, data binding, or function call. */
export function resolveValue(value, context, depth = 0) {
    if (depth > MAX_RESOLVE_DEPTH)
        return undefined;
    if (value === null || value === undefined)
        return value;
    if (Array.isArray(value))
        return value.map((entry) => resolveValue(entry, context, depth + 1));
    if (typeof value !== 'object')
        return value;
    if (isDataBinding(value)) {
        const pointer = bindingPath(value);
        return pointer === undefined ? undefined : resolveBinding(pointer, context);
    }
    if (isFunctionCall(value)) {
        const name = callName(value);
        if (name === undefined)
            return undefined;
        const implementation = FUNCTIONS[name];
        if (implementation === undefined)
            return undefined;
        const args = resolveArgs(value.args, context, depth);
        try {
            return implementation(args, makeEnvironment(context, depth));
        }
        catch {
            return undefined;
        }
    }
    return value;
}
/** Resolve to display text; never returns `undefined`. */
export function resolveString(value, context) {
    const resolved = resolveValue(value, context);
    if (resolved === undefined || resolved === null)
        return '';
    if (typeof resolved === 'string')
        return resolved;
    if (typeof resolved === 'number')
        return Number.isFinite(resolved) ? String(resolved) : '';
    if (typeof resolved === 'boolean')
        return resolved ? 'true' : 'false';
    if (typeof resolved === 'object' && resolved !== null && '__a2uiOpenUrl' in resolved)
        return '';
    try {
        return JSON.stringify(resolved);
    }
    catch {
        return '';
    }
}
/** Resolve to a finite number, or `undefined`. */
export function resolveNumber(value, context) {
    const resolved = resolveValue(value, context);
    if (typeof resolved === 'number' && Number.isFinite(resolved))
        return resolved;
    if (typeof resolved === 'string' && resolved.trim() !== '') {
        const parsed = Number(resolved);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
/** Resolve to a boolean, coercing a validation result through its `valid` flag. */
export function resolveBoolean(value, context) {
    const resolved = resolveValue(value, context);
    if (typeof resolved === 'boolean')
        return resolved;
    return truthyValidation(resolved);
}
/** Resolve to a string list, tolerating a single string and numeric entries. */
export function resolveStringList(value, context) {
    const resolved = resolveValue(value, context);
    if (Array.isArray(resolved))
        return resolved.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')));
    if (resolved === undefined || resolved === null || resolved === '')
        return [];
    return [String(resolved)];
}
/** Resolve to a number list, dropping non-finite entries. */
export function resolveNumberList(value, context) {
    const resolved = resolveValue(value, context);
    if (Array.isArray(resolved)) {
        return resolved.flatMap((entry) => {
            if (typeof entry === 'number' && Number.isFinite(entry))
                return [entry];
            if (typeof entry === 'string' && entry.trim() !== '' && Number.isFinite(Number(entry)))
                return [Number(entry)];
            return [];
        });
    }
    if (typeof resolved === 'number' && Number.isFinite(resolved))
        return [resolved];
    return [];
}
/** Resolve a `context` record of an `action.event`, keeping only JSON-safe values. */
export function resolveActionContext(context, resolve) {
    if (context === undefined)
        return {};
    const out = {};
    for (const [key, value] of Object.entries(context)) {
        const resolved = resolveValue(value, resolve);
        if (resolved === undefined)
            continue;
        out[key] = resolved;
    }
    return out;
}
/** Expand a child-list template against the data model. */
export function expandTemplate(componentId, pointer, resolve, max) {
    const value = resolveBinding(pointer, resolve);
    if (!Array.isArray(value))
        return [];
    return value.slice(0, max).map((data, index) => ({ componentId, data: data, index }));
}

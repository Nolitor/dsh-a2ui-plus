/**
 * A tiny, side-effect-free validation DSL.
 *
 * It exists instead of a schema library so that the exact same validator runs
 * in the Host process (rejecting a tool call) and in the browser (guarding the
 * renderer), with no build-time dependency and with diagnostics phrased for the
 * model that authored the payload.
 */
import { isJsonValue, isPlainObject } from './json.js';
import { LIMITS, limitMessage } from './limits.js';
import { MAX_REGEX_INPUT, regexUnsafeReason } from './regex.js';
export function fail(out, path, message) {
    out.push({ path, message });
}
function typeName(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
function expectString(value, path, out) {
    if (typeof value !== 'string') {
        fail(out, path, `must be a string (got ${typeName(value)})`);
        return undefined;
    }
    if (value.length > LIMITS.maxStringLength) {
        fail(out, path, limitMessage('string length', LIMITS.maxStringLength, value.length));
        return undefined;
    }
    return value;
}
/** A plain string. */
export function str(options = {}) {
    return (value, path, out) => {
        const text = expectString(value, path, out);
        if (text === undefined)
            return;
        if (options.minLength !== undefined && text.length < options.minLength) {
            fail(out, path, `must not be shorter than ${options.minLength} characters`);
        }
        if (options.enum !== undefined && !options.enum.includes(text)) {
            fail(out, path, `must be one of ${options.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
        }
        if (options.pattern !== undefined && !options.pattern.test(text)) {
            fail(out, path, 'has an invalid format');
        }
    };
}
/** A finite number, optionally bounded or integral. */
export function num(options = {}) {
    return (value, path, out) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            fail(out, path, `must be a finite number (got ${typeName(value)})`);
            return;
        }
        if (options.integer === true && !Number.isInteger(value))
            fail(out, path, 'must be an integer');
        if (options.min !== undefined && value < options.min)
            fail(out, path, `must be >= ${options.min}`);
        if (options.max !== undefined && value > options.max)
            fail(out, path, `must be <= ${options.max}`);
    };
}
/** A boolean. */
export const bool = (value, path, out) => {
    if (typeof value !== 'boolean')
        fail(out, path, `must be a boolean (got ${typeName(value)})`);
};
/** Any lossless JSON value. */
export const jsonValue = (value, path, out) => {
    if (!isJsonValue(value))
        fail(out, path, 'must be a lossless JSON value');
};
function isBindingValue(value) {
    return isPlainObject(value) && (typeof value['@path'] === 'string' || typeof value.path === 'string');
}
function isCallValue(value) {
    return isPlainObject(value) && (typeof value['@call'] === 'string' || typeof value.call === 'string');
}
/** Registered function names, populated by `catalog.ts`. */
export const knownFunctions = new Set();
function checkBinding(value, path, out) {
    const pointer = value['@path'] ?? value.path;
    if (typeof pointer !== 'string') {
        fail(out, path, `data binding needs a string "@path" (got ${typeName(pointer)})`);
        return;
    }
    const extra = Object.keys(value).filter((key) => key !== '@path' && key !== 'path');
    if (extra.length > 0)
        fail(out, path, `data binding has unexpected properties: ${extra.join(', ')}`);
}
function checkCall(value, path, out) {
    const name = value['@call'] ?? value.call;
    if (typeof name !== 'string' || name === '') {
        fail(out, path, 'function call needs a non-empty string "@call"');
        return;
    }
    const allowed = new Set(['@call', 'call', 'args', 'catalogId']);
    const extra = Object.keys(value).filter((key) => !allowed.has(key));
    if (extra.length > 0)
        fail(out, path, `function call has unexpected properties: ${extra.join(', ')}`);
    if (!name.startsWith('@') && knownFunctions.size > 0 && !knownFunctions.has(name)) {
        fail(out, path, `unknown function "${name}" (known: ${[...knownFunctions].sort().join(', ')})`);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'args')) {
        if (!isPlainObject(value.args))
            fail(out, `${path}/args`, 'must be an object');
        else if (!isJsonValue(value.args))
            fail(out, `${path}/args`, 'must be a lossless JSON value');
        else if (name === 'regex')
            checkRegexArguments(value.args, `${path}/args`, out);
    }
}
/**
 * A literal `regex` pattern is admitted here so the model gets a path-qualified
 * error instead of a silently failing check. A pattern bound from the data model
 * is admitted again when it is evaluated.
 */
function checkRegexArguments(args, path, out) {
    const pattern = args.pattern;
    if (typeof pattern === 'string') {
        const unsafe = regexUnsafeReason(pattern);
        if (unsafe !== undefined)
            fail(out, `${path}/pattern`, unsafe);
    }
    else if (!isBindingValue(pattern) && !isCallValue(pattern) && pattern !== undefined) {
        fail(out, `${path}/pattern`, 'must be a string, a data binding, or a function call');
    }
    const value = args.value;
    if (typeof value === 'string' && value.length > MAX_REGEX_INPUT) {
        fail(out, `${path}/value`, `input is longer than ${MAX_REGEX_INPUT} characters`);
    }
}
/** A string, a data binding, or a function call. */
export const dynStr = (value, path, out) => {
    if (typeof value === 'string') {
        if (value.length > LIMITS.maxStringLength)
            fail(out, path, limitMessage('string length', LIMITS.maxStringLength, value.length));
        return;
    }
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    fail(out, path, `must be a string, a data binding ({"@path": "/..."}), or a function call (got ${typeName(value)})`);
};
/** A number, a data binding, or a function call. */
export const dynNum = (value, path, out) => {
    if (typeof value === 'number' && Number.isFinite(value))
        return;
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    fail(out, path, `must be a finite number, a data binding, or a function call (got ${typeName(value)})`);
};
/** A boolean, a data binding, or a function call. */
export const dynBool = (value, path, out) => {
    if (typeof value === 'boolean')
        return;
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    fail(out, path, `must be a boolean, a data binding, or a function call (got ${typeName(value)})`);
};
/** A value: literal, data binding, or function call. */
export const dynValue = (value, path, out) => {
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    if (!isJsonValue(value))
        fail(out, path, 'must be a lossless JSON value');
};
/** A string list, a data binding, or a function call. */
export const dynStrList = (value, path, out) => {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1)
            str()(value[index], `${path}/${index}`, out);
        return;
    }
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    fail(out, path, 'must be an array of strings, a data binding, or a function call');
};
/** A number list, a data binding, or a function call. (Extension dynamic type.) */
export const dynNumList = (value, path, out) => {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            num()(value[index], `${path}/${index}`, out);
            if (index >= LIMITS.maxSeriesPoints) {
                fail(out, path, limitMessage('series length', LIMITS.maxSeriesPoints, value.length));
                return;
            }
        }
        return;
    }
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    fail(out, path, 'must be an array of numbers, a data binding, or a function call');
};
/** A data binding or a function call (no literal allowed). */
export const bindingOrCall = (value, path, out) => {
    if (isBindingValue(value))
        return checkBinding(value, path, out);
    if (isCallValue(value))
        return checkCall(value, path, out);
    fail(out, path, 'must be a data binding ({"@path": "/..."}) or a function call ({"@call": "..."})');
};
/** A component id reference. */
export const childRef = str({ minLength: 1 });
/** A static child-id list or a `{componentId, path}` template. */
export const childList = (value, path, out) => {
    if (Array.isArray(value)) {
        if (value.length > LIMITS.maxComponentsPerSurface) {
            fail(out, path, limitMessage('child count', LIMITS.maxComponentsPerSurface, value.length));
        }
        for (let index = 0; index < value.length; index += 1)
            childRef(value[index], `${path}/${index}`, out);
        return;
    }
    if (isPlainObject(value)) {
        const allowed = new Set(['componentId', 'path']);
        for (const key of Object.keys(value))
            if (!allowed.has(key))
                fail(out, path, `has unexpected property "${key}"`);
        childRef(value.componentId, `${path}/componentId`, out);
        str({ minLength: 1 })(value.path, `${path}/path`, out);
        return;
    }
    fail(out, path, 'must be an array of component ids or a {componentId, path} template');
};
/** `Action`: an agent event or a local renderer function call. */
export const action = (value, path, out) => {
    if (!isPlainObject(value)) {
        fail(out, path, 'must be an object with "event" or "functionCall"');
        return;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1) {
        fail(out, path, 'must have exactly one of "event" or "functionCall"');
        return;
    }
    if (keys[0] === 'event') {
        const event = value.event;
        if (!isPlainObject(event)) {
            fail(out, `${path}/event`, 'must be an object');
            return;
        }
        for (const key of Object.keys(event)) {
            if (key !== 'name' && key !== 'userMessage' && key !== 'context') {
                fail(out, `${path}/event`, `has unexpected property "${key}"`);
            }
        }
        str({ minLength: 1 })(event.name, `${path}/event/name`, out);
        if (Object.prototype.hasOwnProperty.call(event, 'userMessage'))
            dynStr(event.userMessage, `${path}/event/userMessage`, out);
        if (Object.prototype.hasOwnProperty.call(event, 'context')) {
            const context = event.context;
            if (!isPlainObject(context))
                fail(out, `${path}/event/context`, 'must be an object');
            else {
                for (const [key, entry] of Object.entries(context))
                    dynValue(entry, `${path}/event/context/${key}`, out);
            }
        }
        return;
    }
    if (keys[0] === 'functionCall') {
        if (!isPlainObject(value.functionCall))
            fail(out, `${path}/functionCall`, 'must be a function call object');
        else
            checkCall(value.functionCall, `${path}/functionCall`, out);
        return;
    }
    fail(out, path, 'must have exactly one of "event" or "functionCall"');
};
/** An array of a validated item type. */
export function arr(item, options = {}) {
    return (value, path, out) => {
        if (!Array.isArray(value)) {
            fail(out, path, `must be an array (got ${typeName(value)})`);
            return;
        }
        if (options.min !== undefined && value.length < options.min)
            fail(out, path, `must contain at least ${options.min} item(s)`);
        if (options.max !== undefined && value.length > options.max) {
            fail(out, path, limitMessage('array length', options.max, value.length));
            return;
        }
        for (let index = 0; index < value.length; index += 1)
            item(value[index], `${path}/${index}`, out);
    };
}
/** A closed object with a fixed property set. */
export function obj(properties, options = {}) {
    const required = new Set(options.required ?? []);
    const strict = options.strict !== false;
    return (value, path, out) => {
        if (!isPlainObject(value)) {
            fail(out, path, `must be an object (got ${typeName(value)})`);
            return;
        }
        if (strict) {
            for (const key of Object.keys(value)) {
                if (!Object.prototype.hasOwnProperty.call(properties, key)) {
                    fail(out, path, `has unexpected property "${key}"`);
                }
            }
        }
        for (const key of required) {
            if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
                fail(out, path, `is missing required property "${key}"`);
            }
        }
        for (const [key, check] of Object.entries(properties)) {
            if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined)
                continue;
            check(value[key], `${path}/${key}`, out);
        }
    };
}
/** Accepts the first branch that produces no violations. */
export function oneOf(branches) {
    return (value, path, out) => {
        let best;
        for (const branch of branches) {
            const attempt = [];
            branch(value, path, attempt);
            if (attempt.length === 0)
                return;
            if (best === undefined || attempt.length < best.length)
                best = attempt;
        }
        out.push(...(best ?? [{ path, message: 'does not match any allowed shape' }]));
    };
}
/** Rejects a value that is present but `undefined`-like; used for optional fields. */
export function optional(check) {
    return (value, path, out) => {
        if (value === undefined)
            return;
        check(value, path, out);
    };
}
export function isDataBinding(value) {
    return isBindingValue(value);
}
export function isFunctionCall(value) {
    return isCallValue(value);
}

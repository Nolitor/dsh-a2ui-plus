import { matchRegex, regexInputUnsafeReason, RegexSyntaxError } from './regex.js';
function asString(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return '';
}
function asFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
function asBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (value !== null && typeof value === 'object' && 'valid' in value) {
        return value.valid === true;
    }
    return false;
}
/** `required(value)` */
const required = (args) => {
    const value = args.value;
    const empty = value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'string' && value.trim() === '');
    return empty ? { valid: false } : { valid: true };
};
/** `regex(value, pattern)` with dialect and backtracking checks. */
const regex = (args) => {
    const text = asString(args.value);
    const pattern = asString(args.pattern);
    const unsafe = regexInputUnsafeReason(text);
    if (unsafe !== undefined)
        return { valid: false, message: unsafe };
    try {
        return { valid: matchRegex(pattern, text) };
    }
    catch (error) {
        return error instanceof RegexSyntaxError ? { valid: false, message: error.message } : { valid: false };
    }
};
function lengthOf(value) {
    if (typeof value === 'string')
        return [...value].length;
    if (Array.isArray(value))
        return value.length;
    return undefined;
}
/** `length(value, min?, max?)` */
const length = (args) => {
    const size = lengthOf(args.value);
    if (size === undefined)
        return { valid: false };
    const min = asFiniteNumber(args.min);
    const max = asFiniteNumber(args.max);
    if (min !== undefined && size < min)
        return { valid: false };
    if (max !== undefined && size > max)
        return { valid: false };
    return { valid: true };
};
/** `numeric(value, min?, max?)` */
const numeric = (args) => {
    const value = asFiniteNumber(args.value);
    if (value === undefined)
        return { valid: false };
    const min = asFiniteNumber(args.min);
    const max = asFiniteNumber(args.max);
    if (min !== undefined && value < min)
        return { valid: false };
    if (max !== undefined && value > max)
        return { valid: false };
    return { valid: true };
};
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u;
/** `email(value)` */
const email = (args) => ({ valid: EMAIL.test(asString(args.value)) });
/** `and(values)` / `or(values)` / `not(value)` */
const and = (args) => {
    const values = Array.isArray(args.values) ? args.values : [];
    return values.length > 0 && values.every(asBoolean);
};
const or = (args) => {
    const values = Array.isArray(args.values) ? args.values : [];
    return values.some(asBoolean);
};
const not = (args) => !asBoolean(args.value);
/* ------------------------------------------------------------------ */
/* formatString                                                        */
/* ------------------------------------------------------------------ */
const MAX_TEMPLATE_DEPTH = 4;
const MAX_TEMPLATE_LENGTH = 8_192;
function skipSpace(reader) {
    while (reader.position < reader.text.length && /\s/u.test(reader.text[reader.position]))
        reader.position += 1;
}
function readIdentifier(reader) {
    const start = reader.position;
    while (reader.position < reader.text.length && /[A-Za-z0-9_@$./~-]/u.test(reader.text[reader.position])) {
        reader.position += 1;
    }
    return reader.text.slice(start, reader.position);
}
function readQuoted(reader) {
    const quote = reader.text[reader.position];
    if (quote !== "'" && quote !== '"')
        return undefined;
    reader.position += 1;
    let out = '';
    while (reader.position < reader.text.length) {
        const character = reader.text[reader.position];
        if (character === '\\' && reader.position + 1 < reader.text.length) {
            out += reader.text[reader.position + 1];
            reader.position += 2;
            continue;
        }
        reader.position += 1;
        if (character === quote)
            return out;
        out += character;
    }
    return undefined;
}
function readExpression(reader, depth) {
    skipSpace(reader);
    const character = reader.text[reader.position];
    if (character === undefined)
        return '';
    if (character === "'" || character === '"') {
        const value = readQuoted(reader);
        return value ?? '';
    }
    if (character === '/' || character === '.') {
        const pointer = readIdentifier(reader);
        return reader.env.evaluate?.({ '@path': pointer });
    }
    if (/[0-9-]/u.test(character)) {
        const start = reader.position;
        reader.position += 1;
        while (reader.position < reader.text.length && /[0-9.eE+-]/u.test(reader.text[reader.position]))
            reader.position += 1;
        const value = Number(reader.text.slice(start, reader.position));
        return Number.isFinite(value) ? value : 0;
    }
    const name = readIdentifier(reader);
    skipSpace(reader);
    if (reader.text[reader.position] !== '(') {
        // A bare identifier resolves as a relative data-model path when possible.
        const resolved = reader.env.evaluate?.({ '@path': `/${name}` });
        return resolved === undefined ? '' : resolved;
    }
    reader.position += 1;
    const args = {};
    while (reader.position < reader.text.length) {
        skipSpace(reader);
        if (reader.text[reader.position] === ')') {
            reader.position += 1;
            break;
        }
        const argumentName = readIdentifier(reader);
        skipSpace(reader);
        if (reader.text[reader.position] === ':') {
            reader.position += 1;
            args[argumentName] = depth >= MAX_TEMPLATE_DEPTH ? '' : readExpression(reader, depth + 1);
        }
        skipSpace(reader);
        if (reader.text[reader.position] === ',') {
            reader.position += 1;
            continue;
        }
        if (reader.text[reader.position] === ')') {
            reader.position += 1;
            break;
        }
        break;
    }
    const implementation = FUNCTIONS[name];
    if (implementation === undefined)
        return '';
    try {
        return implementation(args, reader.env);
    }
    catch {
        return '';
    }
}
function formatTemplate(template, env) {
    if (template.length > MAX_TEMPLATE_LENGTH)
        return template.slice(0, MAX_TEMPLATE_LENGTH);
    let out = '';
    let index = 0;
    while (index < template.length) {
        const start = template.indexOf('${', index);
        if (start < 0) {
            out += template.slice(index);
            break;
        }
        out += template.slice(index, start);
        if (start > 0 && template[start - 1] === '\\') {
            out = `${out.slice(0, -1)}${template.slice(start, start + 2)}`;
            index = start + 2;
            continue;
        }
        let depth = 0;
        let cursor = start + 2;
        let end = -1;
        while (cursor < template.length) {
            const character = template[cursor];
            if (character === "'" || character === '"') {
                const close = template.indexOf(character, cursor + 1);
                if (close < 0)
                    break;
                cursor = close + 1;
                continue;
            }
            if (character === '{')
                depth += 1;
            else if (character === '}') {
                if (depth === 0) {
                    end = cursor;
                    break;
                }
                depth -= 1;
            }
            cursor += 1;
        }
        if (end < 0) {
            out += template.slice(start);
            break;
        }
        const inner = template.slice(start + 2, end);
        const reader = { text: inner, position: 0, depth: 0, env };
        const value = readExpression(reader, 0);
        out += typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
        index = end + 1;
    }
    return out;
}
/** `formatString(value)` — `${/path}` and `${fn(arg:value)}` interpolation. */
const formatString = (args, env) => formatTemplate(asString(args.value), env);
/* ------------------------------------------------------------------ */
/* Localized formatting                                                */
/* ------------------------------------------------------------------ */
function decimalOptions(args) {
    const decimals = asFiniteNumber(args.decimals);
    const grouping = args.grouping === undefined ? true : asBoolean(args.grouping);
    return {
        decimals: decimals === undefined ? undefined : Math.max(0, Math.min(6, Math.trunc(decimals))),
        grouping,
    };
}
/** `formatNumber(value, decimals?, grouping?)` */
const formatNumber = (args, env) => {
    const value = asFiniteNumber(args.value);
    if (value === undefined)
        return '';
    const { decimals, grouping } = decimalOptions(args);
    try {
        return new Intl.NumberFormat(env.locale, {
            minimumFractionDigits: decimals ?? 0,
            maximumFractionDigits: decimals ?? 3,
            useGrouping: grouping,
        }).format(value);
    }
    catch {
        return String(value);
    }
};
/** `formatCurrency(value, currency, decimals?, grouping?)` */
const formatCurrency = (args, env) => {
    const value = asFiniteNumber(args.value);
    const currency = asString(args.currency).toUpperCase();
    if (value === undefined || !/^[A-Z]{3}$/u.test(currency))
        return '';
    const { decimals } = decimalOptions(args);
    try {
        return new Intl.NumberFormat(env.locale, {
            style: 'currency',
            currency,
            ...(decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
        }).format(value);
    }
    catch {
        return '';
    }
};
function toDate(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return new Date(value);
    if (typeof value === 'string' && value !== '') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
    return undefined;
}
/** `formatDate(value, format)` — the TR35 subset the basic catalog documents. */
const formatDate = (args, env) => {
    const date = toDate(args.value);
    const pattern = asString(args.format);
    if (date === undefined || pattern === '')
        return '';
    const pad = (value) => String(value).padStart(2, '0');
    let out = '';
    let index = 0;
    const monthLong = () => {
        try {
            return new Intl.DateTimeFormat(env.locale, { month: 'long' }).format(date);
        }
        catch {
            return String(date.getMonth() + 1);
        }
    };
    const monthShort = () => {
        try {
            return new Intl.DateTimeFormat(env.locale, { month: 'short' }).format(date);
        }
        catch {
            return String(date.getMonth() + 1);
        }
    };
    const weekdayLong = () => {
        try {
            return new Intl.DateTimeFormat(env.locale, { weekday: 'long' }).format(date);
        }
        catch {
            return '';
        }
    };
    const weekdayShort = () => {
        try {
            return new Intl.DateTimeFormat(env.locale, { weekday: 'short' }).format(date);
        }
        catch {
            return '';
        }
    };
    while (index < pattern.length) {
        const rest = pattern.slice(index);
        const take = (token, render) => {
            if (!rest.startsWith(token))
                return false;
            out += render();
            index += token.length;
            return true;
        };
        if (take('yyyy', () => String(date.getFullYear())))
            continue;
        if (take('yy', () => pad(date.getFullYear() % 100)))
            continue;
        if (take('MMMM', monthLong))
            continue;
        if (take('MMM', monthShort))
            continue;
        if (take('MM', () => pad(date.getMonth() + 1)))
            continue;
        if (take('M', () => String(date.getMonth() + 1)))
            continue;
        if (take('dd', () => pad(date.getDate())))
            continue;
        if (take('d', () => String(date.getDate())))
            continue;
        if (take('EEEE', weekdayLong))
            continue;
        if (take('E', weekdayShort))
            continue;
        if (take('HH', () => pad(date.getHours())))
            continue;
        if (take('H', () => String(date.getHours())))
            continue;
        if (take('hh', () => pad(date.getHours() % 12 === 0 ? 12 : date.getHours() % 12)))
            continue;
        if (take('h', () => String(date.getHours() % 12 === 0 ? 12 : date.getHours() % 12)))
            continue;
        if (take('mm', () => pad(date.getMinutes())))
            continue;
        if (take('ss', () => pad(date.getSeconds())))
            continue;
        if (take('a', () => (date.getHours() < 12 ? 'AM' : 'PM')))
            continue;
        out += pattern[index];
        index += 1;
    }
    return out;
};
/** `pluralize(value, zero?, one?, two?, few?, many?, other)` */
const pluralize = (args, env) => {
    const value = asFiniteNumber(args.value) ?? 0;
    let category = 'other';
    try {
        category = new Intl.PluralRules(env.locale).select(value);
    }
    catch {
        category = Math.abs(value) === 1 ? 'one' : 'other';
    }
    const candidates = [category, 'other', 'many', 'few', 'two', 'one', 'zero'];
    for (const key of candidates) {
        const text = args[key];
        if (typeof text === 'string' && text !== '')
            return text;
    }
    return '';
};
/** `openUrl(url)` returns a marker the renderer turns into a user-gesture navigation. */
const openUrl = (args) => {
    const url = asString(args.url);
    return url === '' ? '' : { __a2uiOpenUrl: url };
};
/** `@index(offset?)` */
const atIndex = (args, env) => {
    const offset = asFiniteNumber(args.offset) ?? 0;
    return (env.index ?? 0) + offset;
};
/** Every function implementation, keyed by the wire name. */
export const FUNCTIONS = {
    required,
    regex,
    length,
    numeric,
    email,
    formatString,
    formatNumber,
    formatCurrency,
    formatDate,
    pluralize,
    openUrl,
    and,
    or,
    not,
    '@index': atIndex,
};
/** A formatter usable by the renderer without re-creating `Intl` objects per cell. */
export function makeNumberFormatter(locale, options) {
    try {
        const formatter = new Intl.NumberFormat(locale, options);
        return (value) => formatter.format(value);
    }
    catch {
        return (value) => String(value);
    }
}
/** Truthiness used when a validation result stands in for a boolean. */
export function truthyValidation(value) {
    if (typeof value === 'boolean')
        return value;
    if (value !== null && typeof value === 'object' && 'valid' in value) {
        return value.valid === true;
    }
    return value !== undefined && value !== null && value !== '' && value !== 0;
}

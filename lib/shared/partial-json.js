/**
 * Recovery of a JSON document that is still being streamed.
 *
 * While the model writes a tool call, the argument text arrives in fragments and
 * a `JSON.parse` of the prefix throws. A2UI payloads are large and ordered —
 * a `createSurface` whose `components` array grows one component at a time — so
 * the interesting question is not "is it valid yet" but "which parts are
 * already *complete*".
 *
 * The scanner answers exactly that and nothing more:
 *
 * - A value that closed is returned as parsed data (it is re-parsed from its own
 *   slice, so the caller only ever receives data `JSON.parse` agreed with).
 * - A container that is still open is returned with only its complete members;
 *   the half-written member is reported separately as the array's `pending` tail
 *   so a caller can never mistake it for finished data.
 * - Anything the scanner cannot follow (invalid syntax or deeper than
 *   {@link MAX_RECOVERY_DEPTH}) is reported as `invalid`, which the caller must
 *   treat as "stop streaming", never as "render nothing".
 *
 * Nothing here is used by the Host validator: this layer only feeds the browser
 * preview, and the finished call still goes through `validateToolArguments`.
 */
import { isPlainObject } from './json.js';
/** Deepest container nesting the recovery scanner will follow. */
export const MAX_RECOVERY_DEPTH = 128;
/** Longest argument text the scanner will look at. */
export const MAX_RECOVERY_CHARS = 512 * 1024;
/**
 * Placeholder for an array element whose text has not closed yet.
 *
 * Only arrays need a marker: an object's *complete* pairs are already usable, so
 * a value still being written is simply dropped from the salvaged object, while
 * an array must remember that its last element exists (it is the message being
 * written and the only place new components can appear).
 */
class IncompleteElement {
    value;
    constructor(value) {
        this.value = value;
    }
}
const WHITESPACE = ' \n\r\t';
const NUMBER_CHAR = /[-+0-9.eE]/u;
const LITERALS = ['true', 'false', 'null'];
function skipWhitespace(text, index) {
    let cursor = index;
    while (cursor < text.length && WHITESPACE.includes(text.charAt(cursor)))
        cursor += 1;
    return cursor;
}
/** Scan a string literal starting at its opening quote. */
function scanString(text, index) {
    let cursor = index + 1;
    while (cursor < text.length) {
        const char = text.charAt(cursor);
        if (char === '\\') {
            cursor += 2;
            continue;
        }
        if (char === '"') {
            const raw = text.slice(index, cursor + 1);
            try {
                return { value: JSON.parse(raw), end: cursor + 1, complete: true, invalid: false };
            }
            catch {
                return { value: undefined, end: cursor + 1, complete: false, invalid: true };
            }
        }
        // A raw newline inside a string is invalid JSON, so it can only be the
        // model's own mistake: stop trusting the prefix.
        if (char === '\n' || char === '\r')
            return { value: undefined, end: cursor, complete: false, invalid: true };
        cursor += 1;
    }
    return { value: undefined, end: text.length, complete: false, invalid: false };
}
/** Scan a number or a `true`/`false`/`null` literal. */
function scanScalar(text, index) {
    const char = text.charAt(index);
    if (char === '')
        return { value: undefined, end: index, complete: false, invalid: false };
    if (char === '-' || (char >= '0' && char <= '9')) {
        let cursor = index;
        while (cursor < text.length && NUMBER_CHAR.test(text.charAt(cursor)))
            cursor += 1;
        // A number that runs to the end of the text may still grow ("12" → "123").
        if (cursor >= text.length)
            return { value: undefined, end: text.length, complete: false, invalid: false };
        const raw = text.slice(index, cursor);
        const value = Number(raw);
        if (!Number.isFinite(value))
            return { value: undefined, end: cursor, complete: false, invalid: true };
        return { value, end: cursor, complete: true, invalid: false };
    }
    for (const literal of LITERALS) {
        if (!literal.startsWith(char))
            continue;
        if (text.length - index < literal.length) {
            if (literal.startsWith(text.slice(index)))
                return { value: undefined, end: text.length, complete: false, invalid: false };
            continue;
        }
        if (text.startsWith(literal, index)) {
            const value = literal === 'null' ? null : literal === 'true';
            return { value, end: index + literal.length, complete: true, invalid: false };
        }
    }
    return { value: undefined, end: index, complete: false, invalid: true };
}
function scanValue(text, index, depth) {
    if (depth > MAX_RECOVERY_DEPTH)
        return { value: undefined, end: index, complete: false, invalid: true };
    if (index >= text.length)
        return { value: undefined, end: index, complete: false, invalid: false };
    const char = text.charAt(index);
    if (char === '{')
        return scanObject(text, index, depth);
    if (char === '[')
        return scanArray(text, index, depth);
    if (char === '"')
        return scanString(text, index);
    return scanScalar(text, index);
}
function scanObject(text, index, depth) {
    const pairs = {};
    let cursor = skipWhitespace(text, index + 1);
    if (cursor >= text.length)
        return { value: pairs, end: text.length, complete: false, invalid: false };
    if (text.charAt(cursor) === '}')
        return { value: pairs, end: cursor + 1, complete: true, invalid: false };
    for (;;) {
        if (text.charAt(cursor) !== '"')
            return { value: undefined, end: cursor, complete: false, invalid: true };
        const key = scanString(text, cursor);
        if (!key.complete)
            return { value: key.invalid ? undefined : pairs, end: text.length, complete: false, invalid: key.invalid };
        cursor = skipWhitespace(text, key.end);
        if (cursor >= text.length)
            return { value: pairs, end: text.length, complete: false, invalid: false };
        if (text.charAt(cursor) !== ':')
            return { value: undefined, end: cursor, complete: false, invalid: true };
        cursor = skipWhitespace(text, cursor + 1);
        const entry = scanValue(text, cursor, depth + 1);
        if (entry.invalid)
            return { value: undefined, end: cursor, complete: false, invalid: true };
        if (!entry.complete) {
            if (entry.value !== undefined)
                pairs[String(key.value)] = entry.value;
            return { value: pairs, end: text.length, complete: false, invalid: false };
        }
        pairs[String(key.value)] = entry.value;
        cursor = skipWhitespace(text, entry.end);
        if (cursor >= text.length)
            return { value: pairs, end: text.length, complete: false, invalid: false };
        if (text.charAt(cursor) === ',') {
            cursor = skipWhitespace(text, cursor + 1);
            if (cursor >= text.length)
                return { value: pairs, end: text.length, complete: false, invalid: false };
            continue;
        }
        if (text.charAt(cursor) === '}')
            return { value: pairs, end: cursor + 1, complete: true, invalid: false };
        return { value: undefined, end: cursor, complete: false, invalid: true };
    }
}
function scanArray(text, index, depth) {
    const items = [];
    let cursor = skipWhitespace(text, index + 1);
    if (cursor >= text.length)
        return { value: items, end: text.length, complete: false, invalid: false };
    if (text.charAt(cursor) === ']')
        return { value: items, end: cursor + 1, complete: true, invalid: false };
    for (;;) {
        const entry = scanValue(text, cursor, depth + 1);
        if (entry.invalid)
            return { value: undefined, end: cursor, complete: false, invalid: true };
        if (!entry.complete) {
            // The element exists but is unfinished: keep its salvaged content behind a
            // marker so only the caller that wants the tail can see it.
            items.push(new IncompleteElement(entry.value));
            return { value: items, end: text.length, complete: false, invalid: false };
        }
        items.push(entry.value);
        cursor = skipWhitespace(text, entry.end);
        if (cursor >= text.length)
            return { value: items, end: text.length, complete: false, invalid: false };
        if (text.charAt(cursor) === ',') {
            cursor = skipWhitespace(text, cursor + 1);
            if (cursor >= text.length)
                return { value: items, end: text.length, complete: false, invalid: false };
            continue;
        }
        if (text.charAt(cursor) === ']')
            return { value: items, end: cursor + 1, complete: true, invalid: false };
        return { value: undefined, end: cursor, complete: false, invalid: true };
    }
}
/**
 * Drop every incomplete array element from a salvaged value.
 * @param value salvaged scan output.
 * @returns the same structure without markers.
 */
export function stripIncomplete(value) {
    if (value instanceof IncompleteElement)
        return undefined;
    if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
            const next = stripIncomplete(item);
            if (next !== undefined)
                out.push(next);
        }
        return out;
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            const next = stripIncomplete(item);
            if (next !== undefined)
                out[key] = next;
        }
        return out;
    }
    return value;
}
/**
 * Recover the complete content of a partially streamed argument document.
 *
 * @param text the argument characters received so far.
 * @returns complete messages plus the open state of the stream.
 */
export function recoverArguments(text) {
    const empty = { messages: [], open: false, invalid: false, closed: false, chars: 0 };
    if (typeof text !== 'string' || text === '')
        return empty;
    const capped = text.length > MAX_RECOVERY_CHARS ? text.slice(0, MAX_RECOVERY_CHARS) : text;
    const scan = scanValue(capped, skipWhitespace(capped, 0), 0);
    const chars = text.length;
    if (scan.invalid)
        return { ...empty, invalid: true, chars };
    if (!isPlainObject(scan.value)) {
        // A closed non-object document is a broken payload; an unfinished one is
        // simply not the object yet (the model may still be writing the first `{`).
        return { ...empty, invalid: scan.complete, closed: scan.complete, chars };
    }
    const title = typeof scan.value.title === 'string' ? scan.value.title : undefined;
    const messages = [];
    let partialMessage;
    let open = !scan.complete;
    const raw = scan.value.messages;
    if (Array.isArray(raw)) {
        for (const message of raw) {
            if (message instanceof IncompleteElement) {
                // The message being written: keep whatever it already closed inside it
                // (its components), so the partial surface can be drawn.
                const salvaged = stripIncomplete(message.value);
                if (isPlainObject(salvaged)) {
                    partialMessage = messages.length;
                    messages.push(salvaged);
                }
                open = true;
                continue;
            }
            if (isPlainObject(message))
                messages.push(message);
        }
    }
    if (scan.complete)
        open = false;
    return {
        ...(title === undefined ? {} : { title }),
        ...(scan.value.presentation === undefined ? {} : { presentation: scan.value.presentation }),
        messages,
        ...(partialMessage === undefined ? {} : { partialMessage }),
        open,
        invalid: false,
        closed: scan.complete && !open,
        chars,
    };
}

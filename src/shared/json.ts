/** Minimal JSON helpers shared by the Host validator and the browser renderer. */

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * Whether a value is a plain JSON object.
 *
 * Realm-tolerant on purpose: a payload may arrive from `JSON.parse`, a `vm`
 * context, an iframe, or a structured-clone boundary, and in each case its
 * prototype is a different `Object.prototype`. Identity against this realm's
 * `Object.prototype` would reject perfectly valid JSON, so the check uses the
 * object tag plus the prototype's constructor name. `Date`, `Map`, `Set`,
 * arrays, class instances and proxies of them are still rejected.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.prototype.toString.call(value) !== '[object Object]') return false
  const proto = Object.getPrototypeOf(value)
  if (proto === null) return true
  const ctor = Object.prototype.hasOwnProperty.call(proto, 'constructor') ? (proto as { constructor?: unknown }).constructor : undefined
  return typeof ctor === 'function' && (ctor as { name?: string }).name === 'Object'
}

/** Deepest accepted JSON nesting; deeper values are rejected, not traversed. */
export const MAX_JSON_DEPTH = 128

/**
 * Whether a value is lossless JSON, checked **iteratively**.
 *
 * A recursive walk overflows the stack on adversarial input (an 11,000-level
 * array overflows in a few kilobytes), so the traversal is explicit and stops at
 * {@link MAX_JSON_DEPTH}. Cycles are rejected by the depth bound as well, which
 * also keeps a self-referencing object from looping forever.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const frame = stack.pop() as { value: unknown; depth: number }
    const current = frame.value
    if (current === null) continue
    const type = typeof current
    if (type === 'string' || type === 'boolean') continue
    if (type === 'number') {
      if (!Number.isFinite(current as number)) return false
      continue
    }
    if (type !== 'object') return false
    if (frame.depth >= MAX_JSON_DEPTH) return false
    let entries: unknown[]
    if (Array.isArray(current)) {
      entries = current
    } else {
      if (!isPlainObject(current)) return false
      try {
        entries = Object.values(current)
      } catch {
        return false
      }
    }
    for (const entry of entries) stack.push({ value: entry, depth: frame.depth + 1 })
  }
  return true
}

/**
 * Why a value is not acceptable JSON, or `undefined` when it is.
 * Uses the same iterative traversal, so it is safe on hostile input.
 */
export function jsonProblem(value: unknown): string | undefined {
  return isJsonValue(value) ? undefined : `must be lossless JSON no deeper than ${MAX_JSON_DEPTH} levels`
}

/** JSON Pointer decoding: RFC 6901 `~1` -> `/`, `~0` -> `~`. */
function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** JSON Pointer encoding, the inverse of {@link decodeSegment}. */
function encodeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Split a JSON Pointer into decoded segments; `''` and `'/'` mean the root. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return []
  if (!pointer.startsWith('/')) return [pointer]
  return pointer.slice(1).split('/').map(decodeSegment)
}

export function pointerJoin(base: string, segment: string | number): string {
  const prefix = base === '/' ? '' : base
  return `${prefix}/${encodeSegment(String(segment))}`
}

/** Segments that must never address an object's prototype chain. */
const DANGEROUS_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

/** Longest accepted JSON Pointer, in characters. */
export const MAX_POINTER_LENGTH = 1_024
/** Largest accepted number of path segments. */
export const MAX_POINTER_SEGMENTS = 64
/** Largest array index a write may address; larger ones would build a sparse array. */
export const MAX_ARRAY_INDEX = 10_000

const ARRAY_INDEX = /^(0|[1-9]\d*)$/u

/**
 * Why a pointer may not be used, or `undefined` when it is admissible.
 *
 * Shared by the validator (so a bad `updateDataModel.path` is reported at its
 * field) and by the accessors (so a bad binding degrades instead of throwing).
 */
export function pointerViolation(pointer: unknown): string | undefined {
  if (typeof pointer !== 'string') return 'must be a string'
  if (pointer === '' || pointer === '/') return undefined
  if (!pointer.startsWith('/')) return 'must start with "/"'
  if (pointer.length > MAX_POINTER_LENGTH) return `is longer than ${MAX_POINTER_LENGTH} characters`
  const segments = pointerSegments(pointer)
  if (segments.length > MAX_POINTER_SEGMENTS) return `has more than ${MAX_POINTER_SEGMENTS} segments`
  for (const segment of segments) {
    if (DANGEROUS_SEGMENTS.has(segment)) return `must not address "${segment}"`
    if (ARRAY_INDEX.test(segment) && Number(segment) > MAX_ARRAY_INDEX) {
      return `array index ${segment} exceeds the ${MAX_ARRAY_INDEX} limit`
    }
  }
  return undefined
}

/**
 * Read a pointer from a value.
 * @returns `{ found, value }` so a stored `undefined`/`null` is distinguishable.
 */
export function pointerGet(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointerViolation(pointer) !== undefined) return { found: false, value: undefined }
  let cursor: unknown = root
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(cursor)) {
      if (!ARRAY_INDEX.test(segment)) return { found: false, value: undefined }
      const index = Number(segment)
      if (index >= cursor.length) return { found: false, value: undefined }
      cursor = cursor[index]
      continue
    }
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false, value: undefined }
    }
    cursor = cursor[segment]
  }
  return { found: true, value: cursor }
}

/** Outcome of a data-model write. */
export type WriteStatus = 'ok' | 'unchanged' | 'refused'

export interface PointerWriteResult {
  status: WriteStatus
  /** The new root; identical to the input when nothing changed. */
  value: JsonValue
  /** Why the write was refused, when `status === 'refused'`. */
  reason?: string
}

/**
 * Copy-on-write pointer assignment with an explicit outcome.
 *
 * A `null` value deletes the addressed key, matching the protocol's "set value
 * explicitly to null to delete" rule. A write is *refused* (never silently
 * dropped) for an inadmissible path, a prototype-chain segment, or a sparse
 * array index, so a caller can report the exact field instead of claiming
 * success; it is *unchanged* when the value was already there.
 */
export function pointerWrite(root: JsonValue, pointer: string, value: JsonValue): PointerWriteResult {
  const violation = pointerViolation(pointer)
  if (violation !== undefined) return { status: 'refused', value: root, reason: `path ${violation}` }
  const segments = pointerSegments(pointer)
  if (segments.length === 0) {
    if (deepEqual(root, value)) return { status: 'unchanged', value: root }
    return { status: 'ok', value }
  }
  let refused: string | undefined
  let changed = false
  const refuse = (reason: string, container: JsonValue): JsonValue => {
    if (refused === undefined) refused = reason
    return container
  }
  const write = (container: JsonValue, index: number): JsonValue => {
    const segment = segments[index] as string
    if (DANGEROUS_SEGMENTS.has(segment)) return refuse(`segment "${segment}" must not address an object prototype`, container)
    const isLast = index === segments.length - 1
    if (Array.isArray(container)) {
      if (segment === '-') {
        // JSON Pointer's append token.
        if (!isLast) return refuse('"-" is only valid as the last segment', container)
        if (value === null) return container
        changed = true
        return [...container, value]
      }
      if (!ARRAY_INDEX.test(segment)) return refuse(`"${segment}" is not an array index`, container)
      const position = Number(segment)
      if (position > MAX_ARRAY_INDEX) {
        return refuse(`array index ${position} exceeds the ${MAX_ARRAY_INDEX} limit`, container)
      }
      if (position > container.length) {
        return refuse(`array index ${position} is past the end of a ${container.length}-element array; append at ${container.length} or "-"`, container)
      }
      if (isLast) {
        const next = container.slice()
        if (value === null) {
          if (position >= container.length) return container
          next.splice(position, 1)
        } else {
          if (deepEqual(container[position], value)) return container
          next[position] = value
        }
        changed = true
        return next
      }
      const existing = container[position]
      const next = container.slice()
      next[position] = write(isPlainObject(existing) || Array.isArray(existing) ? (existing as JsonValue) : {}, index + 1)
      return next
    }
    const record: Record<string, JsonValue> = isPlainObject(container) ? { ...(container as Record<string, JsonValue>) } : {}
    if (isLast) {
      if (value === null) {
        if (!Object.prototype.hasOwnProperty.call(record, segment)) return container
        delete record[segment]
      } else {
        if (Object.prototype.hasOwnProperty.call(record, segment) && deepEqual(record[segment], value)) return container
        record[segment] = value
      }
      changed = true
      return record
    }
    const existing = record[segment]
    record[segment] = write(isPlainObject(existing) || Array.isArray(existing) ? existing : {}, index + 1)
    return record
  }
  const result = write(root, 0)
  if (refused !== undefined) return { status: 'refused', value: root, reason: refused }
  return { status: changed ? 'ok' : 'unchanged', value: result }
}

/**
 * Convenience wrapper around {@link pointerWrite} that returns only the value.
 * Refusals come back as the input unchanged, so this form cannot report them —
 * the validator and the renderer use `pointerWrite` when the outcome matters.
 */
export function pointerSet(root: JsonValue, pointer: string, value: JsonValue): JsonValue {
  return pointerWrite(root, pointer, value).value
}

/** Structural equality for JSON values (cheap rejection for primitives). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    const other = right as unknown[]
    if (left.length !== other.length) return false
    return left.every((entry, index) => deepEqual(entry, other[index]))
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
}

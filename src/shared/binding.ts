/**
 * Data-model binding resolution.
 *
 * The same resolver runs in the Host (to check that a payload's bindings are
 * well formed) and in the browser (to render values). It never executes a
 * string: a `{"@call": "name"}` object can only select an entry of the closed
 * `FUNCTIONS` table.
 */
import { isFunctionCall, isDataBinding } from './schema.js'
import { pointerGet, type JsonValue } from './json.js'
import { FUNCTIONS, truthyValidation, type FunctionEnvironment } from './functions.js'

const MAX_RESOLVE_DEPTH = 16

export interface ResolveContext {
  /** Surface data model root. */
  dataModel: JsonValue
  /** Local template item, used for relative bindings inside a repeated child. */
  item?: JsonValue
  /** Item index inside a repeated child. */
  index?: number
  locale: string
  now: number
}

function bindingPath(value: Record<string, unknown>): string | undefined {
  const pointer = value['@path'] ?? value.path
  return typeof pointer === 'string' ? pointer : undefined
}

function callName(value: Record<string, unknown>): string | undefined {
  const name = value['@call'] ?? value.call
  return typeof name === 'string' ? name : undefined
}

/** Resolve a `{"@path": ...}` binding, honouring relative paths inside a template item. */
export function resolveBinding(pointer: string, context: ResolveContext): unknown {
  if (pointer === '' || pointer === '/') return context.dataModel
  if (pointer.startsWith('/')) {
    const result = pointerGet(context.dataModel, pointer)
    return result.found ? result.value : undefined
  }
  const relative = pointerGet(context.item, `/${pointer}`)
  if (relative.found) return relative.value
  const absolute = pointerGet(context.dataModel, `/${pointer}`)
  return absolute.found ? absolute.value : undefined
}

function resolveArgs(args: unknown, context: ResolveContext, depth: number): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = resolveValue(value, context, depth + 1)
  }
  return out
}

function makeEnvironment(context: ResolveContext, depth: number): FunctionEnvironment {
  return {
    locale: context.locale,
    index: context.index,
    now: context.now,
    evaluate: (value) => resolveValue(value, context, depth + 1),
  }
}

/** Resolve any dynamic value: literal, data binding, or function call. */
export function resolveValue(value: unknown, context: ResolveContext, depth = 0): unknown {
  if (depth > MAX_RESOLVE_DEPTH) return undefined
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, context, depth + 1))
  if (typeof value !== 'object') return value
  if (isDataBinding(value)) {
    const pointer = bindingPath(value as Record<string, unknown>)
    return pointer === undefined ? undefined : resolveBinding(pointer, context)
  }
  if (isFunctionCall(value)) {
    const name = callName(value as Record<string, unknown>)
    if (name === undefined) return undefined
    const implementation = FUNCTIONS[name]
    if (implementation === undefined) return undefined
    const args = resolveArgs((value as Record<string, unknown>).args, context, depth)
    try {
      return implementation(args, makeEnvironment(context, depth))
    } catch {
      return undefined
    }
  }
  return value
}

/** Resolve to display text; never returns `undefined`. */
export function resolveString(value: unknown, context: ResolveContext): string {
  const resolved = resolveValue(value, context)
  if (resolved === undefined || resolved === null) return ''
  if (typeof resolved === 'string') return resolved
  if (typeof resolved === 'number') return Number.isFinite(resolved) ? String(resolved) : ''
  if (typeof resolved === 'boolean') return resolved ? 'true' : 'false'
  if (typeof resolved === 'object' && resolved !== null && '__a2uiOpenUrl' in (resolved as object)) return ''
  try {
    return JSON.stringify(resolved)
  } catch {
    return ''
  }
}

/** Resolve to a finite number, or `undefined`. */
export function resolveNumber(value: unknown, context: ResolveContext): number | undefined {
  const resolved = resolveValue(value, context)
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return resolved
  if (typeof resolved === 'string' && resolved.trim() !== '') {
    const parsed = Number(resolved)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Resolve to a boolean, coercing a validation result through its `valid` flag. */
export function resolveBoolean(value: unknown, context: ResolveContext): boolean {
  const resolved = resolveValue(value, context)
  if (typeof resolved === 'boolean') return resolved
  return truthyValidation(resolved)
}

/** Resolve to a string list, tolerating a single string and numeric entries. */
export function resolveStringList(value: unknown, context: ResolveContext): string[] {
  const resolved = resolveValue(value, context)
  if (Array.isArray(resolved)) return resolved.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')))
  if (resolved === undefined || resolved === null || resolved === '') return []
  return [String(resolved)]
}

/** Resolve to a number list, dropping non-finite entries. */
export function resolveNumberList(value: unknown, context: ResolveContext): number[] {
  const resolved = resolveValue(value, context)
  if (Array.isArray(resolved)) {
    return resolved.flatMap((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return [entry]
      if (typeof entry === 'string' && entry.trim() !== '' && Number.isFinite(Number(entry))) return [Number(entry)]
      return []
    })
  }
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return [resolved]
  return []
}

/** Resolve a `context` record of an `action.event`, keeping only JSON-safe values. */
export function resolveActionContext(
  context: Record<string, unknown> | undefined,
  resolve: ResolveContext,
): Record<string, unknown> {
  if (context === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    const resolved = resolveValue(value, resolve)
    if (resolved === undefined) continue
    out[key] = resolved
  }
  return out
}

/** One repeated child produced from a `{componentId, path}` template. */
export interface TemplateItem {
  componentId: string
  data: JsonValue
  index: number
}

/** Expand a child-list template against the data model. */
export function expandTemplate(componentId: string, pointer: string, resolve: ResolveContext, max: number): TemplateItem[] {
  const value = resolveBinding(pointer, resolve)
  if (!Array.isArray(value)) return []
  return value.slice(0, max).map((data, index) => ({ componentId, data: data as JsonValue, index }))
}

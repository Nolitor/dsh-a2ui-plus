/**
 * Rendering context shared by every A2UI component module.
 *
 * Kept separate from `surface.tsx` so the component implementations form a DAG
 * (`surface` → `fields`/`charts`/`player` → `context`), which keeps the
 * single-file client bundle deterministic and cycle-free.
 */
import { h, type React } from './h.js'
import type { A2UIComponent, SurfaceState } from '../shared/validate.js'
import { expandTemplate, resolveBoolean, resolveNumber, resolveString, resolveStringList, resolveValue, type ResolveContext, type TemplateItem } from '../shared/binding.js'
import { LIMITS } from '../shared/limits.js'
import type { JsonValue } from '../shared/json.js'

/** Interaction state of one surface card. */
export interface InteractionState {
  state: 'idle' | 'sending' | 'sent' | 'error'
  message?: string
}

/** Everything a component renderer needs. */
export interface SurfaceView {
  readonly surfaceId: string
  /** Tool call this surface belongs to; keeps DOM ids unique across calls. */
  readonly callId: string
  readonly state: SurfaceState
  readonly model: JsonValue
  readonly locale: string
  readonly now: number
  readonly interaction: InteractionState
  readonly t: (key: string) => string
  readonly setValue: (pointer: string, value: JsonValue) => void
  /**
   * Send an `action.event` to the agent. The scope matters: a template row's
   * action context resolves relative paths against that row's item.
   */
  readonly submit: (scope: Scope, component: A2UIComponent, name: string, context: Record<string, unknown>, userMessage?: string) => void
  /** Run an `action.functionCall` locally (never sends a message). */
  readonly runLocal: (scope: Scope, component: A2UIComponent, call: unknown) => void
  /**
   * Set while the payload is still being written: children that have not
   * arrived render as placeholders instead of "missing child" errors, because
   * absence is expected here and is not a defect.
   */
  readonly streaming?: boolean
}

/** A render scope: the surface plus an optional template item. */
export interface Scope {
  readonly view: SurfaceView
  readonly item?: JsonValue
  readonly index?: number
}

export function resolveContext(scope: Scope): ResolveContext {
  return {
    dataModel: scope.view.model,
    item: scope.item,
    index: scope.index,
    locale: scope.view.locale,
    now: scope.view.now,
  }
}

export function text(scope: Scope, value: unknown): string {
  return resolveString(value, resolveContext(scope))
}

export function numberValue(scope: Scope, value: unknown): number | undefined {
  return resolveNumber(value, resolveContext(scope))
}

export function booleanValue(scope: Scope, value: unknown): boolean {
  return resolveBoolean(value, resolveContext(scope))
}

export function stringList(scope: Scope, value: unknown): string[] {
  return resolveStringList(value, resolveContext(scope))
}

export function anyValue(scope: Scope, value: unknown): unknown {
  return resolveValue(value, resolveContext(scope))
}

/** Template items for a `{componentId, path}` child list. */
export function templateItems(scope: Scope, componentId: string, pointer: string): TemplateItem[] {
  return expandTemplate(componentId, pointer, resolveContext(scope), LIMITS.maxComponentsPerSurface)
}

/** Resolved `accessibility` attributes for a component. */
export function accessibilityAttributes(scope: Scope, component: A2UIComponent): Record<string, unknown> {
  const accessibility = component.accessibility as Record<string, unknown> | undefined
  if (accessibility === undefined) return {}
  const attributes: Record<string, unknown> = {}
  if (accessibility.label !== undefined) {
    const label = text(scope, accessibility.label)
    if (label !== '') attributes['aria-label'] = label
  }
  if (accessibility.description !== undefined) {
    const description = text(scope, accessibility.description)
    if (description !== '') attributes['aria-description'] = description
  }
  if (typeof accessibility.live === 'string' && accessibility.live !== 'off') {
    attributes['aria-live'] = accessibility.live
  }
  if (accessibility.hidden !== undefined && booleanValue(scope, accessibility.hidden)) {
    attributes['aria-hidden'] = true
  }
  return attributes
}

/** Result of evaluating a component's `checks`. */
export interface CheckResult {
  ok: boolean
  message: string
}

export function evaluateChecks(scope: Scope, component: A2UIComponent): CheckResult {
  const checks = component.checks
  if (!Array.isArray(checks) || checks.length === 0) return { ok: true, message: '' }
  for (const rule of checks.slice(0, LIMITS.maxChecks)) {
    if (rule === null || typeof rule !== 'object') continue
    const condition = (rule as Record<string, unknown>).condition
    const resolved = resolveValue(condition, resolveContext(scope))
    const ok = typeof resolved === 'boolean' ? resolved : resolveBoolean(resolved, resolveContext(scope))
    if (!ok) {
      const message = (rule as Record<string, unknown>).message
      return {
        ok: false,
        message: typeof message === 'string' && message !== '' ? message : scope.view.t('invalidValue'),
      }
    }
  }
  return { ok: true, message: '' }
}

/** Inline fallback used whenever a component cannot be rendered safely. */
export function fallback(scope: Scope, message: string): ReturnType<typeof h> {
  return h('span', { className: 'a2ui-fallback', role: 'note' }, message)
}

/** `weight` becomes a flex grow inside a Row/Column. */
export function weightStyle(component: A2UIComponent): React.CSSProperties | undefined {
  const weight = component.weight
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return undefined
  return { flexGrow: weight, flexBasis: 0, minWidth: 0 }
}

export { h }

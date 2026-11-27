/**
 * Component-graph helpers shared by validation and the renderer budget.
 *
 * Kept out of `validate.ts` so the expansion estimator can use it without
 * creating an import cycle with the validator that calls the estimator.
 */
import { isPlainObject } from './json.js'

/** The component fields that hold child references, by shape. */
export interface ChildReference {
  id: string
  field: string
}

/** Whether a `children` value is a `{componentId, path}` template. */
export function isChildTemplate(value: unknown): value is { componentId: string; path: string } {
  return isPlainObject(value) && typeof value.componentId === 'string' && typeof value.path === 'string'
}

/**
 * Collect the child component ids a component references, with their property
 * names. A `{componentId, path}` template is reported once as its template
 * component id; per-item expansion is the renderer's business.
 */
export function childReferences(component: Record<string, unknown>): ChildReference[] {
  const out: ChildReference[] = []
  const single = (field: string): void => {
    const value = component[field]
    if (typeof value === 'string' && value !== '') out.push({ id: value, field })
  }
  single('child')
  single('trigger')
  single('content')
  const children = component.children
  if (Array.isArray(children)) {
    for (const entry of children) if (typeof entry === 'string' && entry !== '') out.push({ id: entry, field: 'children' })
  } else if (isChildTemplate(children)) {
    out.push({ id: children.componentId, field: 'children' })
  }
  const tabs = component.tabs
  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      if (isPlainObject(tab) && typeof tab.child === 'string' && tab.child !== '') out.push({ id: tab.child, field: 'tabs' })
    }
  }
  return out
}

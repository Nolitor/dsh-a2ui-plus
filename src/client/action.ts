/**
 * Pure construction of the A2UI `action` message.
 *
 * Kept out of the React component so the exact payload a click produces — the
 * resolved `context`, the component id, the timestamp — can be asserted without
 * a DOM. The template scope is part of the input: a row button resolves its
 * relative paths against that row's item, which is what makes repeated rows
 * carry their own values.
 */
import type { A2UIComponent } from '../shared/validate.js'
import type { JsonValue } from '../shared/json.js'
import { resolveActionContext, type ResolveContext } from '../shared/binding.js'
import type { InteractionState } from './context.js'

/** Largest action payload accepted before the click is refused. */
export const MAX_ACTION_CHARS = 32_768

export interface ActionInput {
  surfaceId: string
  component: A2UIComponent
  name: string
  /** The component's `action.event.context`, unresolved. */
  contextSpec: Record<string, unknown> | undefined
  dataModel: JsonValue
  /** Template row value, when the button lives inside a repeated child. */
  item?: JsonValue
  /** Template row index. */
  index?: number
  locale: string
  now: number
  userMessage?: string
}

export type ActionOutcome =
  | { kind: 'ok'; action: Record<string, unknown>; text: string }
  | { kind: 'refused'; state: InteractionState }

/** Render the user message that carries the action to the agent. */
export function formatActionPrompt(action: Record<string, unknown>): string {
  const userMessage = typeof action.userMessage === 'string' && action.userMessage !== '' ? action.userMessage : undefined
  const json = JSON.stringify({ version: '1.0', action }, null, 0)
  const head = userMessage === undefined ? '[A2UI action]' : `[A2UI action] ${userMessage}`
  return `${head}\n\n\`\`\`json\n${json}\n\`\`\``
}

/**
 * Build the action message for one click.
 * @returns the message and its prompt text, or the error state to show.
 */
export function buildAction(input: ActionInput): ActionOutcome {
  const resolveContext: ResolveContext = {
    dataModel: input.dataModel,
    item: input.item,
    index: input.index,
    locale: input.locale,
    now: input.now,
  }
  let context: Record<string, unknown> = {}
  try {
    context = resolveActionContext(input.contextSpec, resolveContext)
  } catch {
    context = {}
  }
  const action: Record<string, unknown> = {
    name: input.name,
    surfaceId: input.surfaceId,
    sourceComponentId: input.component.id,
    timestamp: new Date(input.now).toISOString(),
    context,
    ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
  }
  const text = formatActionPrompt(action)
  if (text.length > MAX_ACTION_CHARS) {
    return { kind: 'refused', state: { state: 'error', message: 'action context is too large' } }
  }
  return { kind: 'ok', action, text }
}

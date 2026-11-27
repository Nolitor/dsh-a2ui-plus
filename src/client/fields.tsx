/** Interactive A2UI components: Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput. */
import * as React from 'react'
import { h } from './h.js'
import type { A2UIComponent } from '../shared/validate.js'
import { isDataBinding } from '../shared/schema.js'
import type { JsonValue } from '../shared/json.js'
import { booleanValue, evaluateChecks, numberValue, stringList, text, type Scope } from './context.js'
import { dateTimeKind, fromControlValue, toControlValue } from './datetime.js'

/**
 * DOM id for a control. Includes the tool call, the surface, the component and —
 * inside a repeated template — the row index, so two rows or two calls never
 * share a `label[for]` or a radio group.
 */
function domId(scope: Scope, component: A2UIComponent, suffix?: string | number): string {
  const parts = ['a2ui', scope.view.callId, scope.view.surfaceId, component.id]
  if (scope.index !== undefined) parts.push(`r${scope.index}`)
  if (suffix !== undefined) parts.push(String(suffix))
  return parts.join('-')
}

/** The absolute data-model pointer a control writes to, if it is bound. */
export function bindingPointer(value: unknown): string | undefined {
  if (!isDataBinding(value)) return undefined
  const record = value as Record<string, unknown>
  const pointer = record['@path'] ?? record.path
  if (typeof pointer !== 'string' || pointer === '' || !pointer.startsWith('/')) return undefined
  return pointer
}

function write(scope: Scope, value: unknown, next: JsonValue): void {
  const pointer = bindingPointer(value)
  if (pointer === undefined) return
  scope.view.setValue(pointer, next)
}

/**
 * Whether a control must refuse edits right now.
 *
 * Only an in-flight send (`sending`) or a completed one (`sent`) locks the form.
 * An **error** state must leave the inputs editable: the send can be retried
 * after the user fixes the value, so `!== 'idle'` would strand the whole card.
 * This mirrors the button, which already becomes clickable again on failure.
 */
function formLocked(scope: Scope): boolean {
  const state = scope.view.interaction.state
  return state === 'sending' || state === 'sent'
}

function labelOf(scope: Scope, component: A2UIComponent): string {
  return component.label === undefined ? '' : text(scope, component.label)
}

/** `Button` */
export function renderButton(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const action = component.action as Record<string, unknown> | undefined
  const checks = evaluateChecks(scope, component)
  const busy = view.interaction.state === 'sending'
  const done = view.interaction.state === 'sent'
  const variant = typeof component.variant === 'string' ? component.variant : 'default'
  const disabled = busy || done || !checks.ok
  const child = typeof component.child === 'string' ? component.child : ''
  const labelNode = renderChildLabel(scope, child)

  const onClick = (): void => {
    if (disabled || action === undefined) return
    if (action.event !== undefined) {
      const event = action.event as Record<string, unknown>
      const name = typeof event.name === 'string' ? event.name : 'action'
      const userMessage = event.userMessage === undefined ? undefined : text(scope, event.userMessage)
      const context = (event.context ?? {}) as Record<string, unknown>
      view.submit(scope, component, name, context, userMessage === '' ? undefined : userMessage)
      return
    }
    if (action.functionCall !== undefined) view.runLocal(scope, component, action.functionCall)
  }

  // An agent-bound button starts a real turn when clicked, so it says so on
  // hover instead of surprising the reader with a new message.
  const agentBound = action?.event !== undefined

  return h(
    'span',
    { className: 'a2ui-stack', style: { alignItems: 'flex-start' } },
    h(
      'button',
      {
        type: 'button',
        className: `a2ui-btn${variant === 'primary' ? ' a2ui-btn-primary' : variant === 'borderless' ? ' a2ui-btn-borderless' : ''}`,
        disabled,
        onClick,
        'aria-busy': busy ? true : undefined,
        title: checks.ok ? (agentBound ? view.t('sendsMessage') : undefined) : checks.message,
      },
      labelNode,
      done ? h('span', { 'aria-hidden': true }, '✓') : null,
    ),
    !checks.ok ? h('span', { className: 'a2ui-error', role: 'status' }, checks.message) : null,
  )
}

function renderChildLabel(scope: Scope, childId: string): ReturnType<typeof h> | string {
  const child = scope.view.state.components.get(childId)
  if (child === undefined) return childId
  if (child.component === 'Text') {
    const label = text(scope, child.text)
    return h('span', null, label)
  }
  if (child.component === 'Icon') {
    const name = child.name
    if (typeof name === 'string') {
      const glyph =
        name === 'send' ? '→' : name === 'check' ? '✓' : name === 'close' ? '×' : name === 'add' ? '+' : name === 'refresh' ? '↻' : '•'
      return h('span', { 'aria-hidden': true }, glyph)
    }
  }
  return childId
}

/** `TextField` */
export function renderTextField(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const pointer = bindingPointer(component.value)
  const [local, setLocal] = React.useState<string>(() => text(scope, component.value))
  const current = pointer === undefined ? local : text(scope, component.value)
  const variant = typeof component.variant === 'string' ? component.variant : 'shortText'
  const checks = evaluateChecks(scope, component)
  const id = domId(scope, component)
  const onChange = (next: string): void => {
    if (pointer === undefined) setLocal(next)
    else write(scope, component.value, next as JsonValue)
  }
  const inputProps = {
    id,
    className: 'a2ui-input',
    value: current,
    disabled: view.interaction.state === 'sending' || view.interaction.state === 'sent',
    placeholder: component.placeholder === undefined ? undefined : text(scope, component.placeholder),
    'aria-invalid': checks.ok ? undefined : true,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  }
  const control =
    variant === 'longText'
      ? h('textarea', { ...inputProps, className: 'a2ui-textarea', rows: 4 })
      : h('input', {
          ...inputProps,
          type: variant === 'number' ? 'number' : variant === 'obscured' ? 'password' : 'text',
          inputMode: variant === 'number' ? 'decimal' : undefined,
          autoComplete: 'off',
        })
  return h(
    'div',
    { className: 'a2ui-field' },
    h('label', { className: 'a2ui-label', htmlFor: id }, labelOf(scope, component)),
    control,
    checks.ok ? null : h('span', { className: 'a2ui-error', role: 'status' }, checks.message),
  )
}

/** `CheckBox` */
export function renderCheckBox(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const checked = booleanValue(scope, component.value)
  const pointer = bindingPointer(component.value)
  const [local, setLocal] = React.useState(checked)
  const value = pointer === undefined ? local : checked
  const checks = evaluateChecks(scope, component)
  const id = domId(scope, component)
  return h(
    'div',
    { className: 'a2ui-field' },
    h(
      'label',
      { className: 'a2ui-check', htmlFor: id },
      h('input', {
        id,
        type: 'checkbox',
        checked: value,
        disabled: formLocked(scope),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const next = event.target.checked
          if (pointer === undefined) setLocal(next)
          else write(scope, component.value, next)
        },
      }),
      h('span', null, labelOf(scope, component)),
    ),
    checks.ok ? null : h('span', { className: 'a2ui-error', role: 'status' }, checks.message),
  )
}

/** `ChoicePicker` */
export function renderChoicePicker(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const multiple = component.variant === 'multipleSelection'
  const chips = component.displayStyle === 'chips'
  const options = (Array.isArray(component.options) ? component.options : []).slice(0, LIMITS_MAX_OPTIONS) as Array<Record<string, unknown>>
  const selected = stringList(scope, component.value)
  const pointer = bindingPointer(component.value)
  const [local, setLocal] = React.useState<string[]>(selected)
  const current = pointer === undefined ? local : selected
  const checks = evaluateChecks(scope, component)
  const [query, setQuery] = React.useState('')
  const disabled = formLocked(scope)
  const commit = (next: string[]): void => {
    if (pointer === undefined) setLocal(next)
    else write(scope, component.value, next as JsonValue)
  }
  const toggle = (value: string): void => {
    if (multiple) commit(current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value])
    else commit(current.includes(value) ? [] : [value])
  }
  const visible = options.filter((option) => {
    if (query === '') return true
    const label = text(scope, option.label).toLowerCase()
    return label.includes(query.toLowerCase()) || String(option.value).toLowerCase().includes(query.toLowerCase())
  })
  const head = h(
    'div',
    { className: 'a2ui-field' },
    h('span', { className: 'a2ui-label' }, `${labelOf(scope, component)}${multiple ? ` · ${view.t('chooseMultiple')}` : ''}`),
    component.filterable === true
      ? h('input', {
          className: 'a2ui-input',
          type: 'search',
          value: query,
          placeholder: view.t('choose'),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        })
      : null,
  )
  if (options.length === 0) {
    return h('div', { className: 'a2ui-field' }, head, h('span', { className: 'a2ui-caption' }, view.t('noOptions')))
  }
  if (chips) {
    return h(
      'div',
      { className: 'a2ui-field' },
      head,
      h(
        'div',
        { className: 'a2ui-choice', role: multiple ? 'group' : 'radiogroup' },
        ...visible.map((option, index) => {
          const value = String(option.value ?? '')
          const active = current.includes(value)
          return h(
            'button',
            {
              key: `o${index}`,
              type: 'button',
              className: 'a2ui-chip',
              'aria-pressed': active,
              role: multiple ? 'checkbox' : 'radio',
              'aria-checked': active,
              disabled,
              onClick: () => toggle(value),
            },
            text(scope, option.label),
          )
        }),
      ),
      checks.ok ? null : h('span', { className: 'a2ui-error', role: 'status' }, checks.message),
    )
  }
  return h(
    'div',
    { className: 'a2ui-field' },
    head,
    h(
      'div',
      { className: 'a2ui-choice', style: { flexDirection: 'column', gap: '4px' }, role: multiple ? 'group' : 'radiogroup' },
      ...visible.map((option, index) => {
        const value = String(option.value ?? '')
        const active = current.includes(value)
        const id = domId(scope, component, index)
        return h(
          'label',
          { key: `o${index}`, className: 'a2ui-check', htmlFor: id },
          h('input', {
            id,
            type: multiple ? 'checkbox' : 'radio',
            name: multiple ? undefined : domId(scope, component, 'group'),
            checked: active,
            disabled,
            onChange: () => toggle(value),
          }),
          h('span', null, text(scope, option.label)),
        )
      }),
    ),
    checks.ok ? null : h('span', { className: 'a2ui-error', role: 'status' }, checks.message),
  )
}

const LIMITS_MAX_OPTIONS = 200

/** `Slider` */
export function renderSlider(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const min = numberValue(scope, component.min) ?? 0
  const max = numberValue(scope, component.max) ?? 100
  const steps = numberValue(scope, component.steps)
  const bound = numberValue(scope, component.value) ?? min
  const pointer = bindingPointer(component.value)
  const [local, setLocal] = React.useState(bound)
  const current = pointer === undefined ? local : bound
  const id = domId(scope, component)
  const step = steps !== undefined && steps > 0 ? (max - min) / steps : undefined
  const disabled = formLocked(scope)
  const checks = evaluateChecks(scope, component)
  const onChange = (next: number): void => {
    if (pointer === undefined) setLocal(next)
    else write(scope, component.value, next)
  }
  return h(
    'div',
    { className: 'a2ui-slider' },
    h(
      'div',
      { className: 'a2ui-slider-row' },
      h('label', { className: 'a2ui-label', htmlFor: id, style: { minWidth: 0, flex: 1 } }, labelOf(scope, component) || view.t('slider')),
      h('span', { className: 'a2ui-slider-value' }, new Intl.NumberFormat(view.locale, { maximumFractionDigits: 3 }).format(current)),
    ),
    h('input', {
      id,
      type: 'range',
      min,
      max,
      step: step === undefined ? 'any' : step,
      value: current,
      disabled,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-valuenow': current,
      'aria-invalid': checks.ok ? undefined : true,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value)),
    }),
    checks.ok ? null : h('span', { className: 'a2ui-error', role: 'status' }, checks.message),
  )
}

/** `DateTimeInput` */
export function renderDateTimeInput(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const enableDate = component.enableDate !== false
  const enableTime = component.enableTime === true
  const type = dateTimeKind(enableDate, enableTime)
  const raw = text(scope, component.value)
  const pointer = bindingPointer(component.value)
  const [local, setLocal] = React.useState(raw)
  const current = pointer === undefined ? local : raw
  const id = domId(scope, component)
  const checks = evaluateChecks(scope, component)
  const min = component.min === undefined ? undefined : toControlValue(text(scope, component.min), type)
  const max = component.max === undefined ? undefined : toControlValue(text(scope, component.max), type)
  const onChange = (next: string): void => {
    const stored = fromControlValue(next, type)
    if (pointer === undefined) setLocal(stored)
    else write(scope, component.value, stored)
  }
  return h(
    'div',
    { className: 'a2ui-field' },
    component.label === undefined ? null : h('label', { className: 'a2ui-label', htmlFor: id }, text(scope, component.label)),
    h('input', {
      id,
      className: 'a2ui-input',
      type,
      value: toControlValue(current, type),
      min,
      max,
      disabled: formLocked(scope),
      'aria-invalid': checks.ok ? undefined : true,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    }),
    checks.ok ? null : h('span', { className: 'a2ui-error', role: 'status' }, checks.message),
  )
}

/** Component wrappers: each hook lives in its own fiber, so a component whose
 * type changes via `updateComponents` mounts/unmounts cleanly instead of
 * breaking the parent's hook order. */

export function TextFieldView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderTextField(props.scope, props.component)
}

export function CheckBoxView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderCheckBox(props.scope, props.component)
}

export function ChoicePickerView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderChoicePicker(props.scope, props.component)
}

export function SliderView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderSlider(props.scope, props.component)
}

export function DateTimeInputView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderDateTimeInput(props.scope, props.component)
}
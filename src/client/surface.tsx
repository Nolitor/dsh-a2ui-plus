/**
 * The A2UI surface renderer: walks the validated component graph and renders it
 * with React elements and theme tokens.
 *
 * Safety rules enforced here (not merely hoped for):
 * - Only components named in the catalog are rendered; anything else becomes a
 *   readable fallback, never an empty hole or a crash.
 * - Text becomes React text nodes, never HTML.
 * - `Image`/`Video`/`AudioPlayer` sources are filtered to http(s) (plus
 *   `data:image/*` for images).
 * - A missing child, an unknown catalog, or a too-deep graph degrades to a
 *   message instead of throwing (a throwing renderer blanks the whole slot).
 */
import * as React from 'react'
import { h } from './h.js'
import type { A2UIComponent } from '../shared/validate.js'
import { COMPONENT_BY_NAME, resolveCatalogId } from '../shared/catalog.js'
import { LIMITS } from '../shared/limits.js'
import type { JsonValue } from '../shared/json.js'
import { safeMediaUrl, safeSvgPath } from '../shared/url.js'
import {
  accessibilityAttributes,
  anyValue,
  fallback,
  numberValue,
  templateItems,
  text,
  weightStyle,
  type Scope,
  type SurfaceView,
} from './context.js'
import { renderText } from './markdown.js'
import { renderButton, CheckBoxView, ChoicePickerView, DateTimeInputView, SliderView, TextFieldView } from './fields.js'
import { BarChartView, LineChartView, ParetoChartView, PieChartView, PlotView } from './charts.js'
import { RadarChartView } from './radar.js'
import { HeatmapView, TimelineView } from './display.js'
import { FramePlayerView } from './player.js'

const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  spaceAround: 'space-around',
  spaceBetween: 'space-between',
  spaceEvenly: 'space-evenly',
}

const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
}

function layoutStyle(component: A2UIComponent, axis: 'row' | 'column'): React.CSSProperties {
  const justify = typeof component.justify === 'string' ? JUSTIFY[component.justify] : undefined
  const align = typeof component.align === 'string' ? ALIGN[component.align] : undefined
  return {
    justifyContent: justify ?? 'flex-start',
    alignItems: align ?? (axis === 'row' ? 'stretch' : 'stretch'),
  }
}

/** ~30 named glyphs; an unknown name draws a neutral dot. */
const ICONS: Record<string, string> = {
  add: 'M12 5v14M5 12h14',
  check: 'M4 12.5l5 5L20 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  delete: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  upload: 'M12 20V9m0 0l-4 4m4-4l4 4M5 4h14',
  edit: 'M4 20h4L20 8l-4-4L4 16v4z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4.5-4.5',
  settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 10v6M12 7v.5',
  warning: 'M12 3l9 17H3l9-17zM12 9v5M12 17v.5',
  error: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9 9l6 6M15 9l-6 6',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9a2.5 2.5 0 114 2c-.9.7-1.5 1.2-1.5 2.5M12 17v.5',
  home: 'M4 11l8-7 8 7v9H4v-9z',
  folder: 'M3 6h6l2 2h10v11H3V6z',
  calendarToday: 'M4 6h16v14H4V6zM4 10h16M8 3v4M16 3v4',
  event: 'M4 6h16v14H4V6zM8 3v4M16 3v4M8 14h3',
  accountCircle: 'M12 3a9 9 0 100 18 9 9 0 000-18zM7.5 18a4.5 4.5 0 019 0M12 8.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  person: 'M12 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM5 20a7 7 0 0114 0',
  play: 'M8 5l11 7-11 7V5z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  refresh: 'M20 11a8 8 0 10-2 6M20 4v7h-7',
  favorite: 'M12 20l-7-7a4 4 0 015.6-5.6L12 9l1.4-1.6A4 4 0 0119 13l-7 7z',
  star: 'M12 3l2.6 5.6 6.1.7-4.6 4.1 1.3 6-5.4-3.1L6.6 19.4l1.3-6L3.3 9.3l6.1-.7L12 3z',
  mail: 'M3 6h18v12H3V6zM3 7l9 6 9-6',
  send: 'M4 12l16-8-6 16-2.5-6L4 12z',
  lock: 'M6 11h12v10H6V11zM9 11V7a3 3 0 016 0v4',
  visibility: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  moreVert: 'M12 6v.5M12 12v.5M12 18v.5',
  arrowBack: 'M20 12H4m0 0l6-6m-6 6l6 6',
  arrowForward: 'M4 12h16m0 0l-6-6m6 6l-6 6',
  moreHoriz: 'M6 12v.5M12 12v.5M18 12v.5',
  starOff: 'M12 3l2.6 5.6 6.1.7-4.6 4.1 1.3 6-5.4-3.1L6.6 19.4l1.3-6L3.3 9.3l6.1-.7L12 3zM4 4l16 16',
  favoriteOff: 'M12 20l-7-7a4 4 0 015.6-5.6L12 9l1.4-1.6A4 4 0 0119 13l-7 7zM4 4l16 16',
}

function renderIcon(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const a11y = accessibilityAttributes(scope, component)
  const name = component.name
  let path: string | undefined
  if (typeof name === 'string') path = ICONS[name] ?? 'M12 5v14M12 12h.01'
  else if (name !== null && typeof name === 'object') {
    const svgPath = (name as Record<string, unknown>).svgPath
    if (svgPath !== undefined) {
      const resolved = text(scope, svgPath)
      const admitted = safeSvgPath(resolved)
      if (admitted !== undefined) path = admitted
    }
  }
  const labelled = typeof a11y['aria-label'] === 'string'
  return h(
    'span',
    { className: 'a2ui-icon', ...(labelled ? { role: 'img', 'aria-label': a11y['aria-label'] } : { 'aria-hidden': true }) },
    h(
      'svg',
      { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('path', { d: path ?? 'M12 5v14M12 12h.01' }),
    ),
  )
}

function renderChildren(scope: Scope, component: A2UIComponent, depth: number): Array<ReturnType<typeof h> | null> {
  const children = component.children
  if (Array.isArray(children)) {
    return children.map((id, index) => renderById(scope, typeof id === 'string' ? id : '', depth + 1, `c${index}`))
  }
  if (children !== null && typeof children === 'object') {
    const template = children as Record<string, unknown>
    const componentId = typeof template.componentId === 'string' ? template.componentId : ''
    const pointer = typeof template.path === 'string' ? template.path : ''
    if (componentId === '' || pointer === '') return [fallback(scope, scope.view.t('childMissing'))]
    return templateItems(scope, componentId, pointer).map((item, index) =>
      renderById(scope, item.componentId, depth + 1, `t${index}`, { item: item.data, index: item.index }),
    )
  }
  return []
}

function renderById(
  scope: Scope,
  id: string,
  depth: number,
  key: string,
  itemScope?: { item: JsonValue; index: number },
): ReturnType<typeof h> | null {
  if (id === '') return null
  if (depth > LIMITS.maxDepth) return fallback(scope, 'depth limit')
  const component = scope.view.state.components.get(id)
  if (component === undefined) {
    // While the payload is still streaming, a child that has not arrived yet is
    // expected: reserve its space with a placeholder instead of reporting a
    // defect the user cannot do anything about.
    if (scope.view.streaming === true) return h('span', { key, className: 'a2ui-skel-line a2ui-skel-inline', 'aria-hidden': true })
    return h('span', { key }, fallback(scope, `${scope.view.t('childMissing')}: ${id}`))
  }
  // A nested child inside a template row inherits the row's item, so a `Text`
  // three levels below the template still resolves `{"@path": "title"}` against
  // that row. Only the component that *renders the template* gets a new scope.
  const nextScope: Scope =
    itemScope === undefined
      ? { view: scope.view, item: scope.item, index: scope.index }
      : { view: scope.view, item: itemScope.item, index: itemScope.index }
  return h(ComponentNode, { key, component, scope: nextScope, depth })
}

function ComponentNode(props: { component: A2UIComponent; scope: Scope; depth: number }): ReturnType<typeof h> | null {
  const { component, scope, depth } = props
  const view = scope.view
  const catalogId = resolveCatalogId(view.state.catalogId === '' ? undefined : view.state.catalogId, component.catalogId)
  if (catalogId === undefined) return fallback(scope, view.t('unknownCatalog'))
  const spec = COMPONENT_BY_NAME.get(component.component)
  if (spec === undefined) return fallback(scope, `${view.t('unsupportedComponent')}: ${component.component}`)
  const a11y = accessibilityAttributes(scope, component)
  const style = weightStyle(component)
  const wrap = (element: ReturnType<typeof h> | null): ReturnType<typeof h> | null =>
    element === null
      ? null
      : style === undefined
        ? element
        : h('div', { className: 'a2ui-stack', style: { flexGrow: style.flexGrow as number, flexBasis: 0, minWidth: 0 } }, element)

  switch (component.component) {
    case 'Text':
      return wrap(
        renderText(
          text(scope, component.text),
          component.variant === 'caption' ? 'caption' : 'body',
          component.id,
          typeof a11y['aria-label'] === 'string' ? a11y['aria-label'] : undefined,
        ),
      )
    case 'Image': {
      const url = safeMediaUrl(text(scope, component.url), true)
      if (url === undefined) return wrap(fallback(scope, view.t('imageFailed')))
      const description = component.description === undefined ? '' : text(scope, component.description)
      const fit = typeof component.fit === 'string' ? component.fit : 'fill'
      return wrap(
        h('img', {
          className: 'a2ui-image',
          src: url,
          alt: description,
          loading: 'lazy',
          decoding: 'async',
          referrerPolicy: 'no-referrer',
          style: { objectFit: fit === 'scaleDown' ? 'scale-down' : (fit as React.CSSProperties['objectFit']) },
        }),
      )
    }
    case 'Icon':
      return wrap(renderIcon(scope, component))
    case 'Video': {
      const url = safeMediaUrl(text(scope, component.url), false)
      if (url === undefined) return wrap(fallback(scope, view.t('imageFailed')))
      const poster = component.posterUrl === undefined ? undefined : safeMediaUrl(text(scope, component.posterUrl), true)
      return wrap(h('video', { className: 'a2ui-image', src: url, controls: true, preload: 'metadata', ...(poster === undefined ? {} : { poster }) }))
    }
    case 'AudioPlayer': {
      const url = safeMediaUrl(text(scope, component.url), false)
      if (url === undefined) return wrap(fallback(scope, view.t('imageFailed')))
      return wrap(h('audio', { src: url, controls: true, preload: 'none', style: { width: '100%' } }))
    }
    case 'Row':
      return wrap(h('div', { className: 'a2ui-row', style: layoutStyle(component, 'row'), ...a11y }, ...renderChildren(scope, component, depth)))
    case 'Column':
      return wrap(h('div', { className: 'a2ui-stack', style: layoutStyle(component, 'column'), ...a11y }, ...renderChildren(scope, component, depth)))
    case 'Section': {
      const title = text(scope, component.title)
      const description = component.description === undefined ? '' : text(scope, component.description)
      return wrap(h(
        'section',
        { className: 'a2ui-section', ...a11y },
        title === '' && description === '' ? null : h(
          'header',
          { className: 'a2ui-section-head' },
          title === '' ? null : h('h3', { className: 'a2ui-section-title' }, title),
          description === '' ? null : h('p', { className: 'a2ui-caption' }, description),
        ),
        ...renderChildren(scope, component, depth),
      ))
    }
    case 'List':
      return wrap(
        h(
          'div',
          {
            className: 'a2ui-list',
            style: {
              flexDirection: component.direction === 'horizontal' ? 'row' : 'column',
              flexWrap: component.direction === 'horizontal' ? 'wrap' : 'nowrap',
              alignItems: typeof component.align === 'string' ? ALIGN[component.align] : 'stretch',
            },
            ...a11y,
          },
          ...renderChildren(scope, component, depth),
        ),
      )
    case 'Card': {
      const child = typeof component.child === 'string' ? component.child : ''
      return wrap(h('div', { className: 'a2ui-card-inner', ...a11y }, renderById(scope, child, depth + 1, 'card')))
    }
    case 'Divider':
      return component.axis === 'vertical'
        ? wrap(h('div', { className: 'a2ui-divider-v', role: 'separator', 'aria-orientation': 'vertical' }))
        : h('hr', { className: 'a2ui-divider', role: 'separator' })
    case 'Tabs':
      return wrap(h(TabsView, { component, scope, depth }))
    case 'Modal':
      return wrap(h(ModalView, { component, scope, depth }))
    case 'Button':
      return wrap(renderButton(scope, component))
    case 'TextField':
      return wrap(h(TextFieldView, { component, scope }))
    case 'CheckBox':
      return wrap(h(CheckBoxView, { component, scope }))
    case 'ChoicePicker':
      return wrap(h(ChoicePickerView, { component, scope }))
    case 'Slider':
      return wrap(h(SliderView, { component, scope }))
    case 'DateTimeInput':
      return wrap(h(DateTimeInputView, { component, scope }))
    case 'Table':
      return wrap(h(TableView, { component, scope }))
    case 'Stat':
      return wrap(renderStat(scope, component))
    case 'Progress':
      return wrap(renderProgress(scope, component))
    case 'BarChart':
      return wrap(h(BarChartView, { component, scope }))
    case 'ParetoChart':
      return wrap(h(ParetoChartView, { component, scope }))
    case 'RadarChart':
      return wrap(h(RadarChartView, { component, scope }))
    case 'LineChart':
      return wrap(h(LineChartView, { component, scope }))
    case 'PieChart':
      return wrap(h(PieChartView, { component, scope }))
    case 'Plot':
      return wrap(h(PlotView, { component, scope }))
    case 'Heatmap':
      return wrap(h(HeatmapView, { component, scope }))
    case 'Timeline':
      return wrap(h(TimelineView, { component, scope }))
    case 'FramePlayer':
      return wrap(h(FramePlayerView, { component, scope }))
    default:
      return wrap(fallback(scope, `${view.t('unsupportedComponent')}: ${component.component}`))
  }
}

/** Hosted component wrappers for the local renderers that use hooks. */
function TabsView(props: { component: A2UIComponent; scope: Scope; depth: number }): ReturnType<typeof h> {
  return renderTabs(props.scope, props.component, props.depth)
}

function ModalView(props: { component: A2UIComponent; scope: Scope; depth: number }): ReturnType<typeof h> {
  return renderModal(props.scope, props.component, props.depth)
}

function TableView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderTable(props.scope, props.component)
}

function renderTabs(scope: Scope, component: A2UIComponent, depth: number): ReturnType<typeof h> {
  const view = scope.view
  const tabs = Array.isArray(component.tabs) ? component.tabs : []
  const [active, setActive] = React.useState(0)
  const safeIndex = Math.min(active, Math.max(0, tabs.length - 1))
  const surfacePrefix = `a2ui-${view.callId}-${view.surfaceId}-${component.id}${scope.index === undefined ? '' : `-r${scope.index}`}`
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const focusTab = (index: number): void => {
    const count = tabs.length
    if (count === 0) return
    const next = ((index % count) + count) % count
    setActive(next)
    tabRefs.current[next]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      focusTab(safeIndex + 1)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusTab(safeIndex - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focusTab(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focusTab(tabs.length - 1)
    }
  }
  const buttons = tabs.map((tab, index) => {
    const record = tab as Record<string, unknown>
    const title = record.title === undefined ? `Tab ${index + 1}` : text(scope, record.title)
    return h(
      'button',
      {
        key: `tab${index}`,
        type: 'button',
        role: 'tab',
        className: 'a2ui-tab',
        'aria-selected': index === safeIndex,
        'aria-controls': `${surfacePrefix}-panel-${index}`,
        id: `${surfacePrefix}-tab-${index}`,
        // Roving tabindex: only the selected tab is in the tab order, and the
        // arrow keys move selection (the WAI-ARIA tabs pattern).
        tabIndex: index === safeIndex ? 0 : -1,
        ref: (element: HTMLButtonElement | null): void => {
          tabRefs.current[index] = element
        },
        onClick: () => setActive(index),
      },
      title,
    )
  })
  const current = tabs[safeIndex] as Record<string, unknown> | undefined
  const child = typeof current?.child === 'string' ? current.child : ''
  return h(
    'div',
    { className: 'a2ui-tabs' },
    h('div', { className: 'a2ui-tabbar', role: 'tablist', onKeyDown }, ...buttons),
    h(
      'div',
      { role: 'tabpanel', id: `${surfacePrefix}-panel-${safeIndex}`, 'aria-labelledby': `${surfacePrefix}-tab-${safeIndex}` },
      renderById(scope, child, depth + 1, 'tabpanel'),
    ),
  )
}

function renderModal(scope: Scope, component: A2UIComponent, depth: number): ReturnType<typeof h> {
  const view = scope.view
  const [open, setOpen] = React.useState(false)
  const triggerId = typeof component.trigger === 'string' ? component.trigger : ''
  const contentId = typeof component.content === 'string' ? component.content : ''
  const triggerElementId = `a2ui-${view.callId}-${view.surfaceId}-${component.id}-trigger`
  const dialogRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLSpanElement | null>(null)
  /** Set when the dialog closes, so the next committed render can restore focus. */
  const restoreFocus = React.useRef(false)
  const close = (): void => setOpen(false)

  // Focus management: initial focus inside the dialog, Tab cycles within it, Esc
  // closes, and closing returns focus to the trigger (WAI-ARIA dialog pattern).
  React.useEffect(() => {
    if (!open) return undefined
    const dialog = dialogRef.current
    const focusable = (): HTMLElement[] => {
      if (dialog === null) return []
      return [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
      )
    }
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) {
        event.preventDefault()
        items[items.length - 1]?.focus()
      } else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
        event.preventDefault()
        items[0]?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreFocus.current = true
    }
  }, [open])

  // Runs after the closed tree is committed, so the trigger node exists again.
  // Scoped to `open` on purpose: an effect that ran on every render would focus
  // the trigger repeatedly and spin the component.
  React.useEffect(() => {
    if (open || !restoreFocus.current) return
    restoreFocus.current = false
    const wrapper = triggerRef.current ?? document.getElementById(triggerElementId)
    wrapper?.querySelector('button')?.focus()
  }, [open, triggerElementId])

  const trigger = h(
    'span',
    {
      className: 'a2ui-modal-trigger',
      id: triggerElementId,
      ref: (element: HTMLSpanElement | null): void => {
        triggerRef.current = element
      },
      onClick: () => setOpen(true),
    },
    renderById(scope, triggerId, depth + 1, 'trigger'),
  )
  if (!open) return trigger
  return h(
    'span',
    null,
    trigger,
    h(
      'div',
      {
        className: 'a2ui-modal-backdrop',
        role: 'presentation',
        onClick: (event: React.MouseEvent) => {
          if (event.target === event.currentTarget) close()
        },
      },
      h(
        'div',
        {
          className: 'a2ui-modal',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': view.t('title'),
          ref: (element: HTMLDivElement | null): void => {
            dialogRef.current = element
          },
        },
        h('div', { className: 'a2ui-modal-close' }, h('button', { type: 'button', className: 'a2ui-btn', onClick: close }, view.t('close'))),
        renderById(scope, contentId, depth + 1, 'content'),
      ),
    ),
  )
}

function formatCell(value: unknown, column: Record<string, unknown>, locale: string): string {
  if (value === undefined || value === null) return ''
  const format = typeof column.format === 'string' ? column.format : 'text'
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : undefined
  const decimals = typeof column.decimals === 'number' ? Math.max(0, Math.min(6, Math.trunc(column.decimals))) : undefined
  if (format === 'number' && numeric !== undefined) {
    try {
      return new Intl.NumberFormat(locale, { minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? 2 }).format(numeric)
    } catch {
      return String(numeric)
    }
  }
  if (format === 'percent' && numeric !== undefined) {
    try {
      return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: decimals ?? 1, maximumFractionDigits: decimals ?? 1 }).format(numeric)
    } catch {
      return `${String(numeric)}%`
    }
  }
  if (format === 'currency' && numeric !== undefined) {
    const currency = typeof column.currency === 'string' ? column.currency.toUpperCase() : ''
    if (/^[A-Z]{3}$/u.test(currency)) {
      try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(numeric)
      } catch {
        return String(numeric)
      }
    }
  }
  if (format === 'date') {
    const date = new Date(typeof value === 'number' ? value : String(value))
    if (!Number.isNaN(date.getTime())) {
      try {
        return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
      } catch {
        return String(value)
      }
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

function renderTable(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const columns = (Array.isArray(component.columns) ? component.columns : []).slice(0, 24) as Array<Record<string, unknown>>
  const rowsValue = anyValue(scope, component.rows)
  const totalRows = Array.isArray(rowsValue) ? rowsValue.length : 0
  const rows = Array.isArray(rowsValue) ? rowsValue.slice(0, LIMITS.maxTableRows) : []
  const truncated = totalRows > rows.length
  const [expanded, setExpanded] = React.useState(false)
  const [sort, setSort] = React.useState<{ key: string; dir: 1 | -1 } | null>(null)
  // Sorting is local: it reorders the rows already in the data model and never
  // asks the agent for anything.
  const sortedRows = React.useMemo(() => {
    if (sort === null) return rows
    const key = sort.key
    const value = (row: unknown): unknown => (row !== null && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined)
    return rows.slice().sort((left, right) => {
      const a = value(left)
      const b = value(right)
      const an = typeof a === 'number' ? a : Number(a)
      const bn = typeof b === 'number' ? b : Number(b)
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * sort.dir
      return String(a ?? '').localeCompare(String(b ?? ''), view.locale) * sort.dir
    })
  }, [rows, sort, view.locale])
  const toggleSort = (key: string): void => {
    setSort((previous) => {
      if (previous === null || previous.key !== key) return { key, dir: 1 }
      return previous.dir === 1 ? { key, dir: -1 } : null
    })
  }
  const visible = expanded ? sortedRows : sortedRows.slice(0, 40)
  const showRows = view.t(truncated ? 'tableShowAvailable' : 'showAll')
  const caption = component.caption === undefined ? null : h('p', { className: 'a2ui-caption' }, text(scope, component.caption))
  if (rows.length === 0) {
    return h('div', { className: 'a2ui-stack' }, caption, h('p', { className: 'a2ui-caption' }, view.t('tableEmpty')))
  }
  return h(
    'div',
    { className: 'a2ui-stack' },
    caption,
    truncated
      ? h('p', { className: 'a2ui-caption' }, view.t('tableRowLimit').replace('{limit}', String(rows.length)).replace('{total}', String(totalRows)))
      : null,
    h(
      'div',
      { className: 'a2ui-table-wrap', style: typeof component.height === 'number' ? { maxHeight: `${component.height}px` } : undefined },
      h(
        'table',
        { className: 'a2ui-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...columns.map((column, index) => {
              const key = typeof column.key === 'string' ? column.key : ''
              const active = sort?.key === key ? sort.dir : undefined
              return h(
                'th',
                {
                  key: `h${index}`,
                  scope: 'col',
                  'aria-sort': active === undefined ? 'none' : active === 1 ? 'ascending' : 'descending',
                  style: {
                    textAlign: column.align === 'end' ? 'right' : column.align === 'center' ? 'center' : 'left',
                    ...(typeof column.width === 'number' ? { minWidth: `${Math.max(24, Math.min(800, column.width))}px` } : {}),
                  },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'a2ui-th-sort',
                    onClick: key === '' ? undefined : () => toggleSort(key),
                    title: view.t('sortHint'),
                  },
                  column.label === undefined ? String(column.key ?? '') : text(scope, column.label),
                  active === undefined ? null : h('span', { className: 'a2ui-th-arrow', 'aria-hidden': true }, active === 1 ? '▲' : '▼'),
                ),
              )
            }),
          ),
        ),
        h(
          'tbody',
          null,
          ...visible.map((row, rowIndex) => {
            const record = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
            return h(
              'tr',
              { key: `r${rowIndex}` },
              ...columns.map((column, columnIndex) => {
                const key = typeof column.key === 'string' ? column.key : ''
                const value = record[key]
                const isNumeric = typeof value === 'number' || column.format === 'number' || column.format === 'currency' || column.format === 'percent'
                return h(
                  'td',
                  { key: `c${columnIndex}`, className: isNumeric ? 'a2ui-num' : undefined, style: { textAlign: column.align === 'end' ? 'right' : column.align === 'center' ? 'center' : 'left' } },
                  formatCell(value, column, view.locale),
                )
              }),
            )
          }),
        ),
      ),
    ),
    rows.length > 40
      ? h('button', { type: 'button', className: 'a2ui-btn a2ui-btn-borderless', onClick: () => setExpanded(!expanded) }, expanded ? view.t('showLess') : `${showRows} (${rows.length})`)
      : null,
  )
}

function renderStat(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const raw = anyValue(scope, component.value)
  const value =
    typeof raw === 'number'
      ? new Intl.NumberFormat(view.locale, { maximumFractionDigits: 4 }).format(raw)
      : raw === undefined || raw === null
        ? ''
        : typeof raw === 'object'
          ? JSON.stringify(raw)
          : String(raw)
  const trend = typeof component.trend === 'string' ? component.trend : undefined
  const deltaClass = trend === 'up' ? 'a2ui-delta-up' : trend === 'down' ? 'a2ui-delta-down' : 'a2ui-delta-flat'
  return h(
    'div',
    { className: 'a2ui-stat' },
    h('span', { className: 'a2ui-stat-label' }, text(scope, component.label)),
    h('span', { className: 'a2ui-stat-value' }, value, component.unit === undefined ? null : h('span', { className: 'a2ui-stat-unit' }, text(scope, component.unit))),
    component.delta === undefined ? null : h('span', { className: `a2ui-stat-delta ${deltaClass}` }, text(scope, component.delta)),
    component.hint === undefined ? null : h('span', { className: 'a2ui-caption' }, text(scope, component.hint)),
  )
}

function renderProgress(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const value = numberValue(scope, component.value) ?? 0
  const max = numberValue(scope, component.max) ?? 100
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const tone = typeof component.tone === 'string' ? component.tone : 'neutral'
  const percent = `${Math.round(ratio * 100)}%`
  return h(
    'div',
    { className: 'a2ui-progress', role: 'progressbar', 'aria-valuenow': value, 'aria-valuemin': 0, 'aria-valuemax': max },
    component.label === undefined && component.showValue === false
      ? null
      : h(
          'div',
          { className: 'a2ui-progress-head' },
          h('span', null, component.label === undefined ? '' : text(scope, component.label)),
          component.showValue === false ? null : h('span', null, percent),
        ),
    h('div', { className: 'a2ui-progress-track' }, h('div', { className: `a2ui-progress-fill a2ui-tone-${tone}`, style: { width: percent } })),
  )
}

/** Render one surface's component tree from its `root` component. */
export function A2UISurface(props: { view: SurfaceView }): ReturnType<typeof h> {
  const { view } = props
  const root = view.state.components.get('root')
  if (root === undefined) {
    // The fold only returns surfaces that have a root; a streaming view without
    // one still reserves space instead of reporting a defect.
    if (view.streaming === true) return h('div', { className: 'a2ui-skel', 'aria-hidden': true }, h('span', { className: 'a2ui-skel-line a2ui-skel-w70' }))
    return fallback({ view }, `${view.t('childMissing')}: root`)
  }
  return h('div', { className: 'a2ui-surface' }, h(ComponentNode, { component: root, scope: { view }, depth: 1 }))
}

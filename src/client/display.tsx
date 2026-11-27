import * as React from 'react'
import { resolveHeatmapData, resolveTimelineEvents, type HeatmapData } from '../shared/display-data.js'
import type { A2UIComponent } from '../shared/validate.js'
import { ChartTooltip } from './chart-tooltip.js'
import { accessibilityAttributes, fallback, resolveContext, text, type Scope } from './context.js'
import { h } from './h.js'

interface DisplayProps {
  component: A2UIComponent
  scope: Scope
}

interface ColorRange {
  min: number
  max: number
  diverging: boolean
}

const baseColor = 'var(--a2ui-heat-base)'
const highColor = 'var(--a2ui-heat-high)'
const lowColor = 'var(--a2ui-heat-low)'

function colorRange(values: HeatmapData['values'], component: A2UIComponent): ColorRange | undefined {
  const numbers = values.flat().filter((value): value is number => value !== null)
  if (numbers.length === 0) return undefined
  const diverging = component.scale === 'diverging'
  if (typeof component.min === 'number' && typeof component.max === 'number') {
    return { min: component.min, max: component.max, diverging }
  }
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  if (!diverging || min === max) return { min, max, diverging }
  const magnitude = Math.max(Math.abs(min), Math.abs(max))
  return { min: -magnitude, max: magnitude, diverging }
}

function cellColor(value: number, range: ColorRange): string {
  let intensity = 0.6
  let target = highColor
  if (range.diverging) {
    target = value < 0 ? lowColor : highColor
    intensity = value === 0 ? 0 : range.min === range.max ? 0.6 : value / (value < 0 ? range.min : range.max)
  } else if (range.min !== range.max) {
    const span = range.max - range.min
    intensity = Number.isFinite(span)
      ? (value - range.min) / span
      : (value / 2 - range.min / 2) / (range.max / 2 - range.min / 2)
  }
  const percent = Math.round(Math.max(0, Math.min(1, intensity)) * 100)
  return `color-mix(in oklab, ${target} ${percent}%, ${baseColor})`
}

function withUnit(value: number, unit: string): string {
  return unit === '' ? String(value) : `${value} ${unit}`
}

interface HeatmapGridProps extends DisplayProps {
  data: HeatmapData
}

type CellSelection = { anchor: HTMLTableCellElement; row: number; column: number; mode: 'hover' | 'focus' | 'touch' }

function cellTarget(target: EventTarget | null): HTMLTableCellElement | undefined {
  return (target as Element | null)?.closest?.<HTMLTableCellElement>('td[data-heat-cell]') ?? undefined
}

function cellPosition(cell: HTMLTableCellElement): { row: number; column: number } {
  return { row: Number(cell.dataset.heatRow), column: Number(cell.dataset.heatColumn) }
}

function HeatmapGrid({ component, data, scope }: HeatmapGridProps): ReturnType<typeof h> {
  const { view } = scope
  const t = view.t
  const interactive = !view.streaming
  const { rowLabels, columnLabels, values } = data
  const unit = component.unit === undefined ? '' : text(scope, component.unit)
  const caption = component.caption === undefined ? '' : text(scope, component.caption)
  const range = React.useMemo(() => colorRange(values, component), [values, component])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const tableRef = React.useRef<HTMLTableElement>(null)
  const cornerRef = React.useRef<HTMLTableCellElement>(null)
  const clickPointer = React.useRef('')
  const id = React.useId()
  const [cursor, setCursor] = React.useState({ row: 0, column: 0 })
  const [selected, setSelected] = React.useState<CellSelection>()
  const activeRow = Math.min(cursor.row, rowLabels.length - 1)
  const activeColumn = Math.min(cursor.column, columnLabels.length - 1)

  React.useEffect(() => {
    const scroller = scrollRef.current
    const table = tableRef.current
    if (!scroller || !table) return
    const header = table.rows[0]
    const first = header.cells[1]
    const body = table.tBodies[0]
    const firstRow = body?.rows[0]
    if (!first || !body || !firstRow) return
    let rtl = false
    const onScroll = (): void => {
      const x = Math.max(0, rtl ? -scroller.scrollLeft : scroller.scrollLeft)
      const y = Math.max(0, scroller.scrollTop)
      table.style.setProperty('--a2ui-heat-scroll-x', `${x}px`)
      table.style.setProperty('--a2ui-heat-scroll-y', `${y}px`)
      table.toggleAttribute('data-heat-scrolled', x > 0)
      table.toggleAttribute('data-heat-scrolled-y', y > 0)
    }
    const measure = (): void => {
      rtl = table.ownerDocument.defaultView?.getComputedStyle(table).direction === 'rtl'
      table.toggleAttribute('data-heat-rtl', rtl)
      const start = (cell: HTMLTableCellElement): number => rtl ? -cell.offsetLeft - cell.offsetWidth : cell.offsetLeft
      const firstStart = start(first)
      // Cache positions in table coordinates and update only the offsets on scroll.
      const offsets = Array.from(header.cells, (cell) => `${start(cell) - firstStart}px`)
      for (const row of table.rows) {
        for (let i = 1; i < row.cells.length; i++) row.cells[i].style.setProperty('--a2ui-heat-column-x', offsets[i])
      }
      const firstTop = firstRow.offsetTop
      for (const row of body.rows) row.style.setProperty('--a2ui-heat-row-y', `${row.offsetTop - firstTop}px`)
      scroller.style.setProperty('--a2ui-heat-header-size', `${header.offsetHeight}px`)
      onScroll()
    }
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(table)
    observer?.observe(header)
    return () => {
      observer?.disconnect()
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [rowLabels, columnLabels])

  const select = (cell: HTMLTableCellElement, mode: CellSelection['mode']): void => {
    const position = cellPosition(cell)
    setSelected({ anchor: cell, ...position, mode })
    if (mode !== 'hover') setCursor(position)
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLTableElement>): void => {
    const cell = cellTarget(event.target)
    if (cell === undefined) return
    const position = cellPosition(cell)
    let { row, column } = position
    switch (event.key) {
      case 'ArrowUp': row -= 1; break
      case 'ArrowDown': row += 1; break
      case 'ArrowLeft': column -= 1; break
      case 'ArrowRight': column += 1; break
      case 'Home': column = 0; break
      case 'End': column = columnLabels.length - 1; break
      case 'Escape':
        if (selected === undefined) return
        event.preventDefault()
        event.stopPropagation()
        setSelected(undefined)
        return
      default: return
    }
    event.preventDefault()
    row = Math.max(0, Math.min(rowLabels.length - 1, row))
    column = Math.max(0, Math.min(columnLabels.length - 1, column))
    const next = event.currentTarget.querySelector<HTMLTableCellElement>(
      `td[data-heat-row="${row}"][data-heat-column="${column}"]`,
    )
    if (next) {
      next.focus({ preventScroll: true })
      next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
  }

  const body = React.useMemo(() => values.map((row, rowIndex) => h('tr', { key: rowIndex },
    h('th', { scope: 'row' }, rowLabels[rowIndex]),
    ...row.map((value, columnIndex) => {
      const missing = value === null
      const description = missing ? t('heatmapMissing') : withUnit(value, unit)
      return h('td', {
        key: columnIndex,
        className: missing ? 'a2ui-heat-missing' : undefined,
        'data-heat-cell': '',
        'data-heat-row': rowIndex,
        'data-heat-column': columnIndex,
        'aria-label': `${rowLabels[rowIndex]} · ${columnLabels[columnIndex]} · ${description}`,
        tabIndex: interactive ? (rowIndex === activeRow && columnIndex === activeColumn ? 0 : -1) : undefined,
        style: value !== null && range !== undefined ? { backgroundColor: cellColor(value, range) } : undefined,
      }, missing ? h('span', { 'aria-hidden': true }, '—') : null)
    }),
  )), [values, rowLabels, columnLabels, t, unit, interactive, activeRow, activeColumn, range])

  const reading = selected === undefined ? undefined : values[selected.row]?.[selected.column]
  const lines = selected === undefined || reading === undefined ? [] : [
    `${rowLabels[selected.row]} · ${columnLabels[selected.column]}`,
    reading === null ? t('heatmapMissing') : withUnit(reading, unit),
  ]
  if (reading != null && range !== undefined && (reading < range.min || reading > range.max)) lines.push(t('heatmapOutsideScale'))
  const showScale = range !== undefined && range.min !== range.max
  const colorStops = range?.diverging ? [lowColor, baseColor, highColor] : [baseColor, highColor]
  return h('figure', { className: 'a2ui-chart-wrap a2ui-heatmap', ...accessibilityAttributes(scope, component) },
    caption === '' ? null : h('figcaption', { className: 'a2ui-caption' }, caption),
    interactive ? h('span', { id, className: 'a2ui-visually-hidden' }, t('heatmapKeyboard')) : null,
    h('div', { className: 'a2ui-heatmap-scroll', ref: scrollRef },
      h('table', {
        className: 'a2ui-heatmap-table',
        ref: tableRef,
        'aria-label': caption || t('heatmap'),
        'aria-describedby': interactive ? id : undefined,
        ...(interactive ? {
          onFocus: (event: React.FocusEvent<HTMLTableElement>) => {
            const cell = cellTarget(event.target)
            if (cell !== undefined) select(cell, 'focus')
          },
          onBlur: (event: React.FocusEvent<HTMLTableElement>) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSelected(undefined)
          },
          onKeyDown,
          onPointerDown: (event: React.PointerEvent<HTMLTableElement>) => {
            clickPointer.current = event.pointerType
          },
          onPointerCancel: () => { clickPointer.current = '' },
          onClick: (event: React.MouseEvent<HTMLTableElement>) => {
            const nativeEvent = event.nativeEvent
            const pointerType = ('pointerType' in nativeEvent && nativeEvent.pointerType) || clickPointer.current
            clickPointer.current = ''
            const cell = cellTarget(event.target)
            if (cell === undefined) setSelected(undefined)
            else select(cell, pointerType === 'touch' ? 'touch' : 'hover')
          },
          onPointerOver: (event: React.PointerEvent<HTMLTableElement>) => {
            const cell = cellTarget(event.target)
            if (cell !== undefined && event.pointerType !== 'touch' && cell !== cellTarget(event.relatedTarget)) select(cell, 'hover')
          },
          onPointerOut: (event: React.PointerEvent<HTMLTableElement>) => {
            if (event.pointerType === 'touch') return
            const cell = cellTarget(event.target)
            if (cell === undefined || cell === cellTarget(event.relatedTarget)) return
            setSelected((current) => current?.mode === 'hover' && current.anchor === cell ? undefined : current)
          },
        } : {}),
      },
      h('thead', null, h('tr', null, h('td', { className: 'a2ui-heat-corner', ref: cornerRef, 'aria-hidden': true }),
        ...columnLabels.map((label, index) => h('th', { key: index, scope: 'col' }, label)),
      )),
      h('tbody', null, ...body)),
    ),
    h('div', { className: 'a2ui-heat-legend a2ui-caption' },
      showScale ? h('div', { className: 'a2ui-heat-scale', 'aria-label': t('heatmapScale') },
        h('div', { className: 'a2ui-heat-ramp', style: { backgroundImage: `linear-gradient(to right in oklab, ${colorStops.join(',')})` }, 'aria-hidden': true }),
        h('div', { className: 'a2ui-heat-ticks' },
          h('span', null, withUnit(range.min, unit)),
          range.diverging ? h('span', null, withUnit(0, unit)) : null,
          h('span', null, withUnit(range.max, unit)),
        ),
      ) : range === undefined
        ? h('span', null, t('heatmapNoValues'))
        : h('span', { className: 'a2ui-heat-key' },
          h('span', { className: 'a2ui-heat-chip', style: { backgroundColor: cellColor(range.min, range) }, 'aria-hidden': true }),
          withUnit(range.min, unit),
        ),
      values.some((row) => row.includes(null)) ? h('span', { className: 'a2ui-heat-key' },
        h('span', { className: 'a2ui-heat-chip a2ui-heat-missing', 'aria-hidden': true }),
        t('heatmapMissing'),
      ) : null,
    ),
    selected !== undefined && lines.length > 0
      ? h(ChartTooltip, { anchor: selected.anchor, lines, viewport: scrollRef.current ?? undefined,
        viewportStartCorner: cornerRef.current ?? undefined })
      : null,
  )
}

export function HeatmapView({ component, scope }: DisplayProps): ReturnType<typeof h> {
  const data = resolveHeatmapData(component, resolveContext(scope), '')
  if (data.kind !== 'ready') {
    return fallback(scope, scope.view.streaming && data.kind === 'pending' ? scope.view.t('displayWaiting') : scope.view.t('displayInvalid'))
  }
  if (data.units === 0) return fallback(scope, scope.view.t('heatmapEmpty'))
  return h(HeatmapGrid, { component, scope, data: data.value })
}

export function TimelineView({ component, scope }: DisplayProps): ReturnType<typeof h> {
  const t = scope.view.t
  const events = resolveTimelineEvents(component.events, resolveContext(scope), '/events')
  if (events.kind !== 'ready') {
    return fallback(scope, scope.view.streaming && events.kind === 'pending' ? t('displayWaiting') : t('displayInvalid'))
  }
  if (events.units === 0) return fallback(scope, t('timelineEmpty'))
  const caption = component.caption === undefined ? '' : text(scope, component.caption)
  return h('div', { className: 'a2ui-timeline', ...accessibilityAttributes(scope, component) },
    caption === '' ? null : h('p', { className: 'a2ui-caption' }, caption),
    h('ol', { className: 'a2ui-timeline-list', 'aria-label': caption || t('timeline') },
      ...events.value.map((event, index) => h('li', { className: 'a2ui-timeline-item', key: index },
        h('span', { className: 'a2ui-timeline-when' }, event.when),
        h('span', { className: 'a2ui-timeline-track', 'aria-hidden': true }, h('span', { className: 'a2ui-timeline-dot' })),
        h('div', { className: 'a2ui-timeline-content' },
          h('div', { className: 'a2ui-timeline-head' },
            h('span', { className: 'a2ui-timeline-title' }, event.title),
            event.status === undefined ? null : h('span', { className: `a2ui-timeline-status a2ui-timeline-${event.status}` },
              t(`timelineStatus-${event.status}`),
            ),
          ),
          event.description ? h('p', { className: 'a2ui-timeline-description' }, event.description) : null,
        ),
      )),
    ),
  )
}

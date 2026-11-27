import * as React from 'react'
import { isPlainObject } from '../shared/json.js'
import { axisFraction } from '../shared/plot-data.js'
import { resolveRadarData, type RadarData } from '../shared/display-data.js'
import type { A2UIComponent } from '../shared/validate.js'
import { caption, emptyChart, seriesColor, useChartWidth } from './charts.js'
import { ChartTooltip } from './chart-tooltip.js'
import { accessibilityAttributes, resolveContext, text, type Scope } from './context.js'
import { h } from './h.js'

interface Point {
  x: number
  y: number
}

interface AxisLabel extends Point {
  text: string
  align: 'start' | 'middle' | 'end'
  left: number
  right: number
}

interface Selection {
  index: number
  anchor: SVGGraphicsElement
  mode: 'hover' | 'keyboard' | 'touch'
}

const dashPatterns = ['', '7 4', '2 4', '10 4 2 4', '4 3', '10 5', '2 3 6 3', '4 3 1 3']
const rings = [0.25, 0.5, 0.75, 1]

function labelWidth(value: string): number {
  let width = 0
  for (const character of value) {
    if (character.charCodeAt(0) >= 128) width += 14
    else if (/[MW@%&mw]/u.test(character)) width += 13
    else if (/[A-Z]/u.test(character)) width += 10
    else width += 8
  }
  return width
}

function radarLayout(axes: string[], width: number, height: number) {
  const center = { x: width / 2, y: height / 2 }
  const directions = axes.map((_, index) => {
    const angle = 2 * Math.PI * index / axes.length - Math.PI / 2
    return { x: Math.cos(angle), y: Math.sin(angle) }
  })
  const at = (index: number, distance: number): Point => ({
    x: center.x + distance * directions[index].x,
    y: center.y + distance * directions[index].y,
  })
  const makeLabels = (radius: number, names: string[]): AxisLabel[] => names.map((text, index) => {
    const point = at(index, radius + 15)
    const direction = directions[index].x
    const align = direction > 0.18 ? 'start' : direction < -0.18 ? 'end' : 'middle'
    const size = labelWidth(text)
    const left = point.x - (align === 'start' ? 0 : align === 'end' ? size : size / 2)
    return { ...point, text, align, left, right: left + size }
  })
  const directRadius = Math.min(width / 2 - 56, height / 2 - 35)
  const directLabels = makeLabels(directRadius, axes)
  // When label boxes would collide, keep their full names in an ordered key.
  const numbered = directLabels.some((label, index) => {
    if (label.left < 8 || label.right > width - 8) return true
    return directLabels.slice(0, index).some((other) => (
      Math.abs(other.y - label.y) < 20 && other.left < label.right + 7 && label.left < other.right + 7
    ))
  })
  const radius = numbered ? Math.min(width / 2 - 37, height / 2 - 35) : directRadius
  return {
    at, radius, center, numbered,
    labels: numbered ? makeLabels(radius, axes.map((_, index) => String(index + 1))) : directLabels,
  }
}

function hitAxis(target: EventTarget | null): SVGGraphicsElement | undefined {
  return (target as Element | null)?.closest?.<SVGGraphicsElement>('[data-radar-axis]') ?? undefined
}

function pointList(points: Point[]): string {
  return points.map(({ x, y }) => `${x},${y}`).join(' ')
}

function RadarPlot({ component, scope, data }: { component: A2UIComponent; scope: Scope; data: RadarData }): ReturnType<typeof h> {
  const { axes, scores, min, max } = data
  const t = scope.view.t
  const interactive = !scope.view.streaming
  const id = React.useId()
  const frame = React.useRef<HTMLDivElement>(null)
  const pointerType = React.useRef('')
  const availableWidth = useChartWidth(frame, true, 0)
  const width = Math.max(240, availableWidth)
  const height = typeof component.height === 'number' ? component.height : 316
  const [hidden, setHidden] = React.useState<Set<number>>(() => new Set())
  const [selected, setSelected] = React.useState<Selection>()
  const definitions = Array.isArray(component.series) ? component.series : []
  const series = scores.map((values, index) => {
    const raw = definitions[index]
    const definition = isPlainObject(raw) ? raw : {}
    return {
      index, values,
      label: (definition.label === undefined ? '' : text(scope, definition.label)) || `${t('series')} ${index + 1}`,
      color: seriesColor(index, definition.color),
      dash: dashPatterns[index],
      missing: values.filter((score) => score === null).length,
    }
  })
  const visible = series.filter((entry) => !hidden.has(entry.index))
  const { at, radius, center, numbered, labels } = radarLayout(axes, width, height)
  const selectedSeries = selected?.anchor.getAttribute('data-radar-series')
  const active = selected !== undefined && axes[selected.index] !== undefined && visible.length > 0
    && (selectedSeries == null || scores[Number(selectedSeries)]?.[selected.index] != null) ? selected : undefined
  const header = component.caption === undefined ? '' : text(scope, component.caption)
  const accessibility = accessibilityAttributes(scope, component)
  const title = accessibility['aria-label'] || header || t('radarChart')
  const scale = t('radarScale').replace('{min}', String(min)).replace('{max}', String(max))
  const readout = active === undefined ? [] : [axes[active.index], ...visible.map((entry) => (
    `${entry.label}: ${entry.values[active.index] ?? t('radarMissing')}`
  ))]
  const readoutWidth = Math.max(1, Math.min(256, availableWidth - 38))
  const estimatedLines = readout.flatMap((line) => line.split(/\r?\n/u))
    .reduce((count, line) => count + Math.max(1, Math.ceil(labelWidth(line) / readoutWidth)), 0)
  const showInlineReadout = estimatedLines * 18 + 20 > height * (availableWidth / width) - 36

  const select = (anchor: SVGGraphicsElement, mode: Selection['mode']): void => {
    setSelected({ anchor, mode, index: Number(anchor.getAttribute('data-radar-axis')) })
  }
  const selectLabel = (index: number): void => {
    const anchor = frame.current?.querySelector<SVGGraphicsElement>(`[data-radar-label="${index}"]`)
    if (anchor) select(anchor, 'keyboard')
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (visible.length === 0) return
    const count = axes.length
    const index = active?.index
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': next = index === undefined ? 0 : (index + 1) % count; break
      case 'ArrowLeft':
      case 'ArrowUp': next = index === undefined ? count - 1 : (index - 1 + count) % count; break
      case 'Home': next = 0; break
      case 'End': next = count - 1; break
      case 'Escape':
        if (selected === undefined) return
        event.preventDefault()
        event.stopPropagation()
        setSelected(undefined)
        return
      default: return
    }
    event.preventDefault()
    selectLabel(next)
  }
  const toggle = (index: number): void => {
    setSelected(undefined)
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  return h('div', { className: 'a2ui-chart-wrap a2ui-radar' },
    caption(scope, component),
    h('div', { className: 'a2ui-radar-frame a2ui-plot-frame', ref: frame,
      ...(interactive ? {
        role: 'group', tabIndex: 0, ...accessibility, 'aria-label': title, 'aria-describedby': `${id}-scale ${id}-keys`,
        onFocus: () => selectLabel(0),
        onBlur: () => setSelected(undefined),
        onKeyDown,
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => { pointerType.current = event.pointerType },
        onPointerCancel: () => { pointerType.current = '' },
        onPointerOver: (event: React.PointerEvent<HTMLDivElement>) => {
          const hit = hitAxis(event.target)
          if (event.pointerType !== 'touch' && hit && hit !== hitAxis(event.relatedTarget)) select(hit, 'hover')
        },
        onPointerOut: (event: React.PointerEvent<HTMLDivElement>) => {
          if (event.pointerType === 'touch') return
          const hit = hitAxis(event.target)
          if (hit === undefined || hit === hitAxis(event.relatedTarget)) return
          setSelected((current) => current?.mode === 'hover' && current.anchor === hit ? undefined : current)
        },
        onClick: (event: React.MouseEvent<HTMLDivElement>) => {
          const native = event.nativeEvent
          const kind = ('pointerType' in native && native.pointerType) || pointerType.current
          pointerType.current = ''
          const hit = hitAxis(event.target)
          if (hit) select(hit, kind === 'touch' ? 'touch' : 'hover')
          else setSelected(undefined)
        },
      } : {}),
    },
    h('svg', { className: 'a2ui-chart-svg a2ui-axis', viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': title, 'aria-hidden': interactive || undefined, style: { maxHeight: `${height}px` },
    },
    h('g', { className: 'a2ui-radar-grid', fill: 'none', 'aria-hidden': true },
      ...rings.map((fraction) => h('polygon', { key: fraction, points: pointList(axes.map((_, index) => at(index, radius * fraction))) })),
      ...axes.map((_, index) => {
        const end = at(index, radius)
        return h('line', { key: `axis${index}`, x1: center.x, y1: center.y, x2: end.x, y2: end.y,
          className: active?.index === index ? 'a2ui-radar-spoke-active' : undefined })
      }),
    ),
    ...visible.map((entry) => {
      const marks = entry.values.map((score, index) => score === null ? null : at(index, radius * axisFraction(score, min, max)))
      const plotted = marks.filter((point): point is Point => point !== null)
      const complete = plotted.length === marks.length
      const edges = complete ? '' : marks.map((point, index) => {
        const next = marks[(index + 1) % marks.length]
        return point && next ? `M${point.x},${point.y}L${next.x},${next.y}` : ''
      }).join('')
      const outline = { stroke: entry.color, strokeWidth: 2, strokeDasharray: entry.dash || undefined, strokeLinejoin: 'round' as const, pointerEvents: 'none' as const }
      return h('g', { key: `series${entry.index}`, 'data-radar-series-group': entry.index },
        complete ? h('polygon', { ...outline, 'data-radar-profile': '', points: pointList(plotted), fill: entry.color, fillOpacity: 0.1 })
          : edges !== '' ? h('path', { ...outline, 'data-radar-gap-path': '', d: edges, fill: 'none' }) : null,
        ...marks.map((point, index) => point === null ? null : h('circle', {
          key: index, 'data-radar-axis': index, 'data-radar-series': entry.index,
          cx: point.x, cy: point.y, r: active?.index === index ? 4 : 3,
          fill: entry.color, stroke: 'transparent', strokeWidth: 9,
        })),
      )
    }),
    ...labels.map((label, index) => h('g', {
      key: `label${index}`, 'data-radar-label': index, 'data-radar-axis': index,
      className: active?.index === index ? 'a2ui-radar-label-active' : undefined,
    },
    h('rect', { x: label.left - 4, y: label.y - 10, width: label.right - label.left + 8, height: 20, rx: 5 }),
    h('text', { x: label.x, y: label.y + 4, textAnchor: label.align, fontSize: 12, pointerEvents: 'none' }, label.text),
    )),
    ),
    interactive ? h('span', { id: `${id}-keys`, className: 'a2ui-visually-hidden' }, t('radarKeyboard')) : null,
    interactive ? h('span', { role: 'status', className: 'a2ui-visually-hidden' }, active?.mode !== 'hover' ? readout.join(' · ') : '') : null,
    active && !showInlineReadout ? h(ChartTooltip, { anchor: active.anchor, lines: readout }) : null,
    ),
    h('p', { id: `${id}-scale`, className: 'a2ui-caption a2ui-radar-scale' }, scale),
    numbered ? h('ol', { className: 'a2ui-radar-axis-key', 'aria-label': t('radarAxes') },
      ...axes.map((label, index) => h('li', { key: index },
        h('span', { className: 'a2ui-radar-axis-number', 'aria-hidden': true }, index + 1),
        h('span', null, label),
      )),
    ) : null,
    h('div', { className: 'a2ui-legend a2ui-radar-legend' }, ...series.map((entry) => {
      const swatch = h('svg', { className: 'a2ui-radar-swatch', viewBox: '0 0 23 8', 'aria-hidden': true },
        h('line', { x1: 0, x2: 23, y1: 4, y2: 4, stroke: entry.color, strokeWidth: 2, strokeDasharray: entry.dash || undefined }),
      )
      const name = entry.missing === 0 ? entry.label : `${entry.label} · ${t('radarMissingCount').replace('{count}', String(entry.missing))}`
      return interactive ? h('button', {
        key: entry.index, type: 'button', className: `a2ui-legend-item${hidden.has(entry.index) ? ' a2ui-legend-off' : ''}`,
        'aria-pressed': !hidden.has(entry.index), onClick: () => toggle(entry.index),
      }, swatch, h('span', null, name)) : h('span', { key: entry.index, className: 'a2ui-legend-item' }, swatch, h('span', null, name))
    })),
    visible.length === 0 ? h('p', { className: 'a2ui-caption' }, t('radarAllHidden')) : null,
    active && showInlineReadout ? h('div', { className: 'a2ui-caption a2ui-radar-readout' },
      ...readout.map((line, index) => h(index === 0 ? 'strong' : 'span', { key: index }, line)),
    ) : null,
  )
}

export function RadarChartView({ component, scope }: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  const data = resolveRadarData(component, resolveContext(scope), '')
  if (data.kind !== 'ready') {
    return emptyChart(scope, component, scope.view.t(data.kind === 'pending' && scope.view.streaming ? 'displayWaiting' : 'displayInvalid'))
  }
  return h(RadarPlot, { component, scope, data: data.value })
}

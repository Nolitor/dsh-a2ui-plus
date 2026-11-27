/**
 * SVG charts for the extension catalog: BarChart, LineChart, PieChart, Plot.
 *
 * Hand-rolled SVG instead of a chart library keeps the single-file client
 * bundle small, avoids a runtime CDN, and inherits the theme (text uses
 * `currentColor`, grids use `--dsw-alias-border-l1`). Every chart also exposes
 * an accessible summary, because an SVG is otherwise opaque to screen readers.
 *
 * Interactivity is local by design: hovering highlights the data point, shows a
 * tooltip, and clicking a legend entry toggles that series. None of it sends a
 * message or touches the model.
 */
import * as React from 'react'
import { h } from './h.js'
import type { A2UIComponent } from '../shared/validate.js'
import { compileExpression, tryCompileExpression, type CompiledExpression } from '../shared/expression.js'
import { anyValue, numberValue, resolveContext, text, type Scope } from './context.js'
import { isDataBinding, isFunctionCall, type Violation } from '../shared/schema.js'
import { isPlainObject } from '../shared/json.js'
import { LIMITS } from '../shared/limits.js'
import { axisFraction, fitLinearRegression, plotPointList, visibleRegressionSegment, type PlotPoint } from '../shared/plot-data.js'
import { chartSeriesValues, resolveErrorRanges, resolveParetoItems, type ErrorRange, type ParetoItem } from '../shared/display-data.js'
import { bindingPointer } from './fields.js'
import { ChartTooltip } from './chart-tooltip.js'

const VIEW_WIDTH = 640
const PAD = { top: 18, right: 16, bottom: 30, left: 46 }

/** Series colour: an authored safe colour, else the theme-independent palette. */
export function seriesColor(index: number, override: unknown): string {
  if (typeof override === 'string' && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/u.test(override)) return override
  return `var(--a2ui-c${(index % 8) + 1})`
}

function formatTick(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(value / 1_000)}k`
  return trim(value)
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return '–'
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return String(rounded)
}

function visibleCategoryLabel(label: string, limit: number): string {
  if (label.length <= limit) return label
  const points = Array.from(label)
  return points.length <= limit ? label : `${points.slice(0, limit - 1).join('')}…`
}

interface Scale {
  min: number
  max: number
  ticks: number[]
}

function niceScale(values: number[], forcedMin?: number, forcedMax?: number, tickCount = 4): Scale {
  const finite = values.filter((value) => Number.isFinite(value))
  let min = forcedMin ?? (finite.length > 0 ? Math.min(...finite) : 0)
  let max = forcedMax ?? (finite.length > 0 ? Math.max(...finite) : 1)
  if (!Number.isFinite(min)) min = 0
  if (!Number.isFinite(max)) max = 1
  if (min === max) {
    const padding = Math.abs(min) > 0 ? Math.abs(min) * 0.2 : 1
    min -= padding
    max += padding
  }
  if (forcedMin === undefined && min > 0 && min / max < 0.6) min = 0
  const span = max - min
  const rawStep = span / Math.max(1, tickCount)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const step = (normalized >= 5 ? 10 : normalized >= 2 ? 5 : normalized >= 1 ? 2 : 1) * magnitude
  if (!Number.isFinite(step) || !(step > 0)) return scatterScale(finite, forcedMin, forcedMax)
  const niceMin = forcedMin === undefined ? Math.floor(min / step) * step : min
  const niceMax = forcedMax === undefined ? Math.ceil(max / step) * step : max
  if (!Number.isFinite(niceMin) || !Number.isFinite(niceMax)) return scatterScale(finite, forcedMin, forcedMax)
  const ticks: number[] = []
  for (let i = 0; i < 12; i++) {
    const raw = niceMin + i * step
    const rounded = Number(raw.toFixed(10))
    if (raw > niceMax && rounded > niceMax) break
    const tick = Math.max(niceMin, Math.min(niceMax, rounded))
    if (tick !== ticks.at(-1)) ticks.push(tick)
  }
  const last = ticks.at(-1)
  if (forcedMax !== undefined && last !== undefined && niceMax - last >= step / 2 && ticks.length < 12) ticks.push(niceMax)
  return { min: niceMin, max: niceMax, ticks }
}

interface SeriesData {
  label: string
  values: Array<number | undefined>
  color: string
}

function readSeries(scope: Scope, component: A2UIComponent, categoryCount?: number): SeriesData[] {
  const raw = Array.isArray(component.series) ? component.series.slice(0, 8) : []
  return raw.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>
    return {
      label: record.label === undefined ? `${scope.view.t('series')} ${index + 1}` : text(scope, record.label),
      values: chartSeriesValues(anyValue(scope, record.values), categoryCount),
      color: seriesColor(index, record.color),
    }
  })
}

interface LegendProps {
  series: Array<{ label: string; color: string }>
  hidden?: ReadonlySet<number>
  onToggle?: (index: number) => void
  /** Entries beyond the legend cap, reported instead of silently dropped. */
  more?: number
}

function legend(props: LegendProps): ReturnType<typeof h> | null {
  const { series, hidden, onToggle, more } = props
  if (series.length <= 1) return null
  return h(
    'div',
    { className: 'a2ui-legend' },
    ...series.map((entry, index) => {
      const off = hidden?.has(index) === true
      return h(
        'button',
        {
          key: `l${index}`,
          type: 'button',
          className: `a2ui-legend-item${off ? ' a2ui-legend-off' : ''}`,
          'aria-pressed': !off,
          title: entry.label,
          onClick: onToggle === undefined ? undefined : () => onToggle(index),
          style: onToggle === undefined ? { cursor: 'default' } : undefined,
        },
        h('span', { className: 'a2ui-legend-swatch', style: { background: entry.color } }),
        entry.label,
      )
    }),
    more !== undefined && more > 0 ? h('span', { className: 'a2ui-legend-more' }, `+${more}`) : null,
  )
}

export function caption(scope: Scope, component: A2UIComponent): ReturnType<typeof h> | null {
  if (component.caption === undefined) return null
  return h('p', { className: 'a2ui-caption' }, text(scope, component.caption))
}

export function emptyChart(scope: Scope, component: A2UIComponent, message: string): ReturnType<typeof h> {
  return h('div', { className: 'a2ui-chart-wrap' }, caption(scope, component), h('p', { className: 'a2ui-caption' }, message))
}

function chartHeight(component: A2UIComponent, fallback: number): number {
  const height = component.height
  return typeof height === 'number' && Number.isFinite(height) ? Math.max(120, Math.min(560, height)) : fallback
}

function axisSummary(scope: Scope, categories: string[], series: SeriesData[]): string {
  const parts = series.map((entry) => {
    const values = entry.values.filter((value) => value !== undefined)
    if (values.length === 0) return `${entry.label}: ${scope.view.t('chartEmpty')}`
    const min = Math.min(...values)
    const max = Math.max(...values)
    return `${entry.label}: ${scope.view.t('total')} ${trim(values.reduce((sum, value) => sum + value, 0))} (min ${trim(min)}, max ${trim(max)})`
  })
  return `${categories.join(', ')}. ${parts.join('. ')}`
}

/**
 * Domain a bar chart needs so the baseline is visible.
 *
 * A positive-only series starts at 0, a negative-only one ends at 0, and a
 * mixed one contains 0 naturally. An explicit `yMin`/`yMax` wins; if both force
 * the same value the domain is left automatic so the scale cannot collapse.
 */
export function barDomain(values: number[], forcedMin?: number, forcedMax?: number): { min?: number; max?: number } {
  const finite = values.filter((value) => Number.isFinite(value))
  const dataMin = finite.length > 0 ? Math.min(...finite) : 0
  const dataMax = finite.length > 0 ? Math.max(...finite) : 0
  let min = forcedMin ?? (dataMin >= 0 ? 0 : undefined)
  let max = forcedMax ?? (dataMax <= 0 ? 0 : undefined)
  if (min !== undefined && max !== undefined && min === max) {
    min = undefined
    max = undefined
  }
  return { min, max }
}

/**
 * Split sampled points into drawable runs.
 *
 * A curve that leaves the plotted domain (`1/x`, `tan`, an asymptote) is broken
 * instead of being connected across the gap, which would draw a false straight
 * line through a discontinuity.
 */
interface PlotSample { x: number; y: number }

export function splitPlotSegments(
  points: PlotSample[],
  min: number,
  max: number,
  hasGap?: (previous: PlotSample, next: PlotSample) => boolean,
): PlotSample[][] {
  const segments: PlotSample[][] = []
  let current: PlotSample[] = []
  for (const point of points) {
    if (!Number.isFinite(point.y) || point.y < min || point.y > max) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    const previous = current.at(-1)
    if (previous !== undefined && hasGap?.(previous, point)) {
      segments.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/** `BarChart` */
interface BarHover {
  series: number
  category: number
  element: SVGRectElement
}

interface BarSeriesData extends SeriesData {
  errorBars?: Array<ErrorRange | null>
  errorLabel?: string
  invalidErrors?: boolean
}

export function renderBarChart(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const resolvedCategories = Array.isArray(component.categories) ? component.categories : anyValue(scope, component.categories)
  const categories = Array.isArray(resolvedCategories) ? resolvedCategories.map((entry) => text(scope, entry)) : []
  const declarations = Array.isArray(component.series) ? component.series : []
  const allSeries = readSeries(scope, component, categories.length).map<BarSeriesData>((entry, index) => {
    const raw = declarations[index]
    if (!isPlainObject(raw) || raw.errorBars === undefined) return entry
    const ranges = resolveErrorRanges(raw.errorBars, resolvedCategories, anyValue(scope, raw.values), resolveContext(scope), '')
    return {
      ...entry,
      errorBars: ranges.kind === 'ready' ? ranges.value : undefined,
      invalidErrors: ranges.kind === 'invalid' || (ranges.kind === 'pending' && !view.streaming),
      errorLabel: raw.errorLabel === undefined ? '' : text(scope, raw.errorLabel),
    }
  })
  const [hidden, setHidden] = React.useState<Set<number>>(() => new Set())
  const [hover, setHover] = React.useState<BarHover | null>(null)
  const plotRef = React.useRef<HTMLDivElement>(null)
  const responsive = allSeries.some((entry) => entry.errorBars !== undefined)
  const viewWidth = useChartWidth(plotRef, responsive)
  const series = allSeries.filter((_, index) => !hidden.has(index))
  const horizontal = component.horizontal === true
  const stacked = component.stacked === true
  const suffix = component.valueSuffix === undefined ? '' : text(scope, component.valueSuffix)
  const all = series.flatMap((entry) => entry.values.filter((value) => value !== undefined))
  if (allSeries.some((entry) => entry.invalidErrors)) return emptyChart(scope, component, view.t('displayInvalid'))
  if (categories.length === 0 || series.length === 0 || all.length === 0) return emptyChart(scope, component, view.t('chartEmpty'))

  const toggle = (index: number): void => {
    setHover(null)
    setHidden((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next.size >= allSeries.length ? new Set() : next
    })
  }

  const height = chartHeight(component, horizontal ? Math.max(160, categories.length * 26 + PAD.top + PAD.bottom) : 240)
  const plotWidth = viewWidth - PAD.left - PAD.right
  const plotHeight = height - PAD.top - PAD.bottom

  // Bar charts must show their baseline: a positive-only series starts at 0, a
  // negative-only one ends at 0, and a mixed one contains 0. An explicit yMin /
  // yMax wins, and the plot is clamped to that domain.
  const endpoints = series.flatMap((entry) => entry.errorBars?.flatMap((range) => range === null ? [] : [range.lower, range.upper]) ?? [])
  const extent = endpoints.length === 0 ? all : [...all, ...endpoints]
  const domain = barDomain(extent, numberValue(scope, component.yMin), numberValue(scope, component.yMax))
  let scale: Scale
  if (stacked && !horizontal) {
    const stackMin: number[] = []
    const stackMax: number[] = []
    categories.forEach((_, index) => {
      let up = 0
      let down = 0
      for (const entry of series) {
        const value = entry.values[index]
        if (value === undefined) continue
        if (value >= 0) up += value
        else down += value
      }
      stackMax.push(up)
      stackMin.push(down)
    })
    scale = niceScale([...stackMax, ...stackMin], domain.min, domain.max)
  } else {
    scale = niceScale(extent, domain.min, domain.max)
    if (endpoints.length > 0 && (!(scale.max > scale.min) || new Set(scale.ticks).size < 2)) {
      scale = scatterScale(extent, domain.min, domain.max)
    }
  }
  const clamp = (value: number): number => Math.max(scale.min, Math.min(scale.max, value))
  const fraction = (value: number): number => scale.min === scale.max ? 0 : axisFraction(clamp(value), scale.min, scale.max)
  const valueToY = (value: number): number => PAD.top + plotHeight * (1 - fraction(value))
  const valueToX = (value: number): number => PAD.left + plotWidth * fraction(value)
  const tickLabels = endpoints.length > 0 ? numericTickLabels(scale.ticks) : scale.ticks.map(formatTick)
  const band = horizontal ? plotHeight / Math.max(1, categories.length) : plotWidth / Math.max(1, categories.length)
  const labelEvery = responsive ? Math.max(1, Math.ceil(52 / band)) : 1
  const groupWidth = band * 0.68
  const barWidth = stacked || horizontal ? groupWidth : groupWidth / Math.max(1, series.length)

  const grid = h(
    'g',
    { className: 'a2ui-grid' },
    ...scale.ticks.map((tick, index) =>
      horizontal
        ? h(
            'g',
            { key: `g${index}` },
            h('line', { x1: valueToX(tick), x2: valueToX(tick), y1: PAD.top, y2: PAD.top + plotHeight }),
            h('text', { x: valueToX(tick), y: height - 10, textAnchor: 'middle', fontSize: 10 }, tickLabels[index]),
          )
        : h(
            'g',
            { key: `g${index}` },
            h('line', { x1: PAD.left, x2: PAD.left + plotWidth, y1: valueToY(tick), y2: valueToY(tick) }),
            h('text', { x: PAD.left - 6, y: valueToY(tick) + 3.5, textAnchor: 'end', fontSize: 10 }, tickLabels[index]),
          ),
    ),
  )

  const barEvents = (series: number, category: number) => ({
    onMouseEnter: (event: React.MouseEvent<SVGRectElement>) => setHover({ series, category, element: event.currentTarget }),
    onMouseLeave: () => setHover(null),
  })
  const bars: Array<ReturnType<typeof h>> = []
  categories.forEach((category, categoryIndex) => {
    const center = PAD.left + band * categoryIndex + band / 2
    if (stacked && !horizontal) {
      let up = 0
      let down = 0
      series.forEach((entry, seriesIndex) => {
        const value = entry.values[categoryIndex]
        if (value === undefined) return
        const base = value >= 0 ? up : down
        const top = base + value
        const yBase = valueToY(base)
        const yTop = valueToY(top)
        const isHover = hover?.category === categoryIndex
        bars.push(
          h('rect', {
            key: `b${categoryIndex}-${seriesIndex}`,
            x: center - barWidth / 2,
            y: Math.min(yBase, yTop),
            width: barWidth,
            height: Math.max(0.5, Math.abs(yBase - yTop)),
            rx: 2,
            fill: entry.color,
            opacity: hover === null || isHover ? 1 : 0.42,
            ...barEvents(seriesIndex, categoryIndex),
            style: { transition: 'opacity .12s ease' },
          }),
        )
        if (value >= 0) up = top
        else down = top
      })
    } else if (horizontal) {
      const baseline = valueToX(0)
      series.forEach((entry, seriesIndex) => {
        const value = entry.values[categoryIndex]
        if (value === undefined) return
        const end = valueToX(value)
        const isHover = hover?.category === categoryIndex
        bars.push(
          h('rect', {
            key: `b${categoryIndex}-${seriesIndex}`,
            x: Math.min(baseline, end),
            y: PAD.top + band * categoryIndex + (band - groupWidth) / 2 + seriesIndex * (groupWidth / Math.max(1, series.length)),
            width: Math.max(0.5, Math.abs(end - baseline)),
            height: (groupWidth / Math.max(1, series.length)) * 0.86,
            rx: 2,
            fill: entry.color,
            opacity: hover === null || isHover ? 1 : 0.42,
            ...barEvents(seriesIndex, categoryIndex),
            style: { transition: 'opacity .12s ease' },
          }),
        )
      })
    } else {
      series.forEach((entry, seriesIndex) => {
        const value = entry.values[categoryIndex]
        if (value === undefined) return
        const zero = valueToY(0)
        const y = valueToY(value)
        const isHover = hover !== null && hover.category === categoryIndex && hover.series === seriesIndex
        const x = center - groupWidth / 2 + seriesIndex * barWidth
        const width = Math.max(1, barWidth * 0.88)
        bars.push(
          h('rect', {
            key: `b${categoryIndex}-${seriesIndex}`,
            x,
            y: Math.min(y, zero),
            width,
            height: Math.max(0.5, Math.abs(zero - y)),
            rx: 2,
            fill: entry.color,
            opacity: hover === null || isHover ? 1 : 0.5,
            stroke: isHover ? 'var(--dsw-alias-label-primary)' : 'none',
            strokeWidth: isHover ? 1 : 0,
            ...barEvents(seriesIndex, categoryIndex),
            style: { transition: 'opacity .12s ease' },
          }),
        )
        const interval = entry.errorBars?.[categoryIndex]
        if (interval && interval.upper >= scale.min && interval.lower <= scale.max) {
          const mid = x + width / 2
          const halfCap = Math.min(6, width * 0.31)
          const low = valueToY(interval.lower)
          const high = valueToY(interval.upper)
          const cap = (at: number): string => `M${mid - halfCap},${at}H${mid + halfCap}`
          const d = `M${mid},${low}V${high}`
            + (interval.lower >= scale.min ? cap(low) : '')
            + (interval.upper <= scale.max && interval.upper !== interval.lower ? cap(high) : '')
          bars.push(h('path', {
            key: `error${categoryIndex}-${seriesIndex}`,
            'data-bar-error': '',
            'aria-hidden': true,
            d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
            vectorEffect: 'non-scaling-stroke', pointerEvents: 'none',
            opacity: hover === null || isHover ? 1 : 0.35,
          }))
        }
      })
    }
    if (responsive ? categoryIndex % labelEvery === 0 : categories.length <= 14) {
      bars.push(
        h(
          'text',
          {
            key: `x${categoryIndex}`,
            x: horizontal ? PAD.left - 6 : center,
            y: horizontal ? PAD.top + band * categoryIndex + band / 2 + 3.5 : height - 10,
            textAnchor: horizontal ? 'end' : 'middle',
            fontSize: 10,
            fill: 'currentColor',
            opacity: hover === null || hover.category === categoryIndex ? 0.85 : 0.45,
          },
          responsive ? visibleCategoryLabel(category, Math.max(3, Math.min(14, Math.floor(band * labelEvery / 11))))
            : category.length > 14 ? `${category.slice(0, 13)}…` : category,
        ),
      )
    }
  })

  let tooltip: ReturnType<typeof h> | null = null
  if (hover !== null) {
    const entry = series[hover.series]
    const value = entry?.values[hover.category]
    const label = categories[hover.category] ?? ''
    if (entry !== undefined && value !== undefined) {
      const unit = suffix === '' ? '' : ` ${suffix}`
      const interval = entry.errorBars?.[hover.category]
      const lines = [label, `${entry.label}: ${interval ? value : trim(value)}${unit}`]
      if (interval) lines.push(`${entry.errorLabel || view.t('barErrorRange')}: ${interval.lower} – ${interval.upper}${unit}`)
      tooltip = h(ChartTooltip, {
        anchor: hover.element,
        lines,
      })
    }
  }

  return h(
    'div',
    { className: 'a2ui-chart-wrap' },
    caption(scope, component),
    h(
      'div',
      { className: 'a2ui-bar-plot', ref: plotRef },
      h(
        'svg',
        {
          className: 'a2ui-chart-svg a2ui-axis',
          viewBox: `0 0 ${viewWidth} ${height}`,
          role: 'img',
          'aria-label': axisSummary(scope, categories, series),
          style: { maxHeight: `${height}px` },
        },
        grid,
        ...bars,
      ),
      tooltip,
    ),
    legend({ series: allSeries, hidden, onToggle: toggle }),
    suffix === '' ? null : h('p', { className: 'a2ui-caption' }, `(${suffix})`),
  )
}

/** `LineChart` */
export function renderLineChart(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const categories = Array.isArray(component.categories) ? (component.categories as unknown[]).map((entry) => text(scope, entry)) : []
  const allSeries = readSeries(scope, component)
  const [hidden, setHidden] = React.useState<Set<number>>(() => new Set())
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null)
  const tooltipAnchor = React.useRef<SVGCircleElement>(null)
  const series = allSeries.filter((_, index) => !hidden.has(index))
  const area = component.area === true
  const smooth = component.curve === 'smooth'
  const showPoints = component.showPoints !== false
  const all = series.flatMap((entry) => entry.values).filter((value) => value !== undefined)
  if (all.length === 0) return emptyChart(scope, component, view.t('chartEmpty'))
  const height = chartHeight(component, 240)
  const plotWidth = VIEW_WIDTH - PAD.left - PAD.right
  const plotHeight = height - PAD.top - PAD.bottom
  const scale = niceScale(all, numberValue(scope, component.yMin), numberValue(scope, component.yMax))
  const count = Math.max(1, ...series.map((entry) => entry.values.length), categories.length)
  const xAt = (index: number): number => PAD.left + (count === 1 ? plotWidth / 2 : (plotWidth * index) / (count - 1))
  const yAt = (value: number): number => PAD.top + plotHeight - ((value - scale.min) / (scale.max - scale.min)) * plotHeight

  const toggle = (index: number): void => {
    setHidden((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next.size >= allSeries.length ? new Set() : next
    })
  }

  const pathFor = (points: Array<{ x: number; y: number }>): string => {
    if (!smooth || points.length < 3) {
      return points.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
    }
    let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
    for (let index = 0; index < points.length - 1; index += 1) {
      const { x: x0, y: y0 } = points[Math.max(0, index - 1)]
      const { x: x1, y: y1 } = points[index]
      const { x: x2, y: y2 } = points[index + 1]
      const { x: x3, y: y3 } = points[Math.min(points.length - 1, index + 2)]
      const c1x = x1 + (x2 - x0) / 6
      const c1y = y1 + (y2 - y0) / 6
      const c2x = x2 - (x3 - x1) / 6
      const c2y = y2 - (y3 - y1) / 6
      path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}`
    }
    return path
  }

  const grid = h(
    'g',
    { className: 'a2ui-grid' },
    ...scale.ticks.map((tick, index) =>
      h(
        'g',
        { key: `g${index}` },
        h('line', { x1: PAD.left, x2: PAD.left + plotWidth, y1: yAt(tick), y2: yAt(tick) }),
        h('text', { x: PAD.left - 6, y: yAt(tick) + 3.5, textAnchor: 'end', fontSize: 10 }, formatTick(tick)),
      ),
    ),
  )

  const marks: Array<ReturnType<typeof h>> = []
  series.forEach((entry, seriesIndex) => {
    const points = entry.values.map((value, index) => ({ x: xAt(index), y: value === undefined ? Number.NaN : yAt(value) }))
    const segments = splitPlotSegments(points, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
    segments.forEach((segment, segmentIndex) => {
      const line = pathFor(segment)
      if (area && segment.length > 1) {
        const base = yAt(scale.min)
        marks.push(
          h('path', {
            key: `a${seriesIndex}-${segmentIndex}`,
            d: `${line} L${segment[segment.length - 1].x.toFixed(2)},${base} L${segment[0].x.toFixed(2)},${base} Z`,
            fill: entry.color,
            opacity: 0.14,
          }),
        )
      }
      marks.push(h('path', { key: `p${seriesIndex}-${segmentIndex}`, d: line, fill: 'none', stroke: entry.color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }))
    })
    if (showPoints) {
      points.forEach(({ x, y }, index) => {
        if (!Number.isFinite(y)) return
        const active = hoverIndex === index
        marks.push(
          h('circle', {
            key: `c${seriesIndex}-${index}`,
            cx: x,
            cy: y,
            r: active ? 4.2 : 2.6,
            fill: entry.color,
            stroke: active ? 'var(--dsw-alias-bg-layer-2)' : 'none',
            strokeWidth: active ? 1.2 : 0,
            style: { transition: 'r .1s ease' },
          }),
        )
      })
    }
  })

  const labelStep = Math.max(1, Math.ceil(Math.max(categories.length, count) / 8))
  categories.forEach((category, index) => {
    if (index % labelStep !== 0) return
    marks.push(
      h(
        'text',
        {
          key: `x${index}`,
          x: xAt(index),
          y: height - 10,
          textAnchor: 'middle',
          fontSize: 10,
          fill: 'currentColor',
          opacity: hoverIndex === null || hoverIndex === index ? 0.8 : 0.45,
        },
        category.length > 12 ? `${category.slice(0, 11)}…` : category,
      ),
    )
  })

  // Hover bands: one invisible column per category, so a tooltip lists every
  // series at that x without needing per-point hit areas.
  const bands: Array<ReturnType<typeof h>> = []
  const bandWidth = count === 1 ? plotWidth : plotWidth / (count - 1)
  for (let index = 0; index < count; index += 1) {
    const x = xAt(index) - bandWidth / 2
    bands.push(
      h('rect', {
        key: `h${index}`,
        x: Math.max(PAD.left, x),
        y: PAD.top,
        width: Math.max(6, Math.min(bandWidth, PAD.left + plotWidth - x)),
        height: plotHeight,
        fill: 'transparent',
        onMouseEnter: () => setHoverIndex(index),
        onMouseLeave: () => setHoverIndex(null),
      }),
    )
  }

  let tooltip: ReturnType<typeof h> | null = null
  if (hoverIndex !== null) {
    const lines = [categories[hoverIndex] ?? `#${hoverIndex + 1}`]
    series.forEach((entry) => {
      const value = entry.values[hoverIndex]
      if (value !== undefined) lines.push(`${entry.label}: ${trim(value)}`)
    })
    if (lines.length > 1) tooltip = h(ChartTooltip, { anchor: tooltipAnchor, lines })
  }

  const guide =
    hoverIndex === null
      ? null
      : h('line', {
          x1: xAt(hoverIndex),
          x2: xAt(hoverIndex),
          y1: PAD.top,
          y2: PAD.top + plotHeight,
          stroke: 'var(--dsw-alias-label-secondary)',
          strokeWidth: 1,
          strokeDasharray: '3 3',
          opacity: 0.6,
        })

  const yLabel = component.yLabel === undefined ? '' : text(scope, component.yLabel)
  return h(
    'div',
    { className: 'a2ui-chart-wrap' },
    caption(scope, component),
    h('div', { className: 'a2ui-bar-plot' }, h(
      'svg',
      {
        className: 'a2ui-chart-svg a2ui-axis',
        viewBox: `0 0 ${VIEW_WIDTH} ${height}`,
        role: 'img',
        'aria-label': axisSummary(scope, categories, series),
        style: { maxHeight: `${height}px` },
      },
      grid,
      guide,
      yLabel === '' ? null : h('text', { x: PAD.left, y: 11, fontSize: 10, fill: 'currentColor', opacity: 0.7 }, yLabel),
      ...marks,
      ...bands,
      hoverIndex === null || tooltip === null ? null : h('circle', {
        ref: tooltipAnchor, cx: xAt(hoverIndex), cy: PAD.top + 18, r: 1, opacity: 0, pointerEvents: 'none',
      }),
    ), tooltip),
    legend({ series: allSeries, hidden, onToggle: toggle }),
  )
}

/** `PieChart` */
export function renderPieChart(scope: Scope, component: A2UIComponent): ReturnType<typeof h> {
  const view = scope.view
  const raw = Array.isArray(component.slices) ? component.slices : []
  const [hover, setHover] = React.useState<number | null>(null)
  const allSlices = raw.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>
    return {
      label: record.label === undefined ? `#${index + 1}` : text(scope, record.label),
      value: Math.max(0, numberValue(scope, record.value) ?? 0),
      color: seriesColor(index, record.color),
    }
  })
  const total = allSlices.reduce((sum, slice) => sum + slice.value, 0)
  if (total <= 0) return emptyChart(scope, component, view.t('chartEmpty'))
  const maxVisibleSlices = 40
  const slices = allSlices.slice(0, maxVisibleSlices)
  const remaining = allSlices.length - slices.length
  if (remaining > 0) {
    slices.push({
      label: `${view.t('otherSlices')} (${remaining})`,
      value: allSlices.slice(maxVisibleSlices).reduce((sum, slice) => sum + slice.value, 0),
      color: seriesColor(maxVisibleSlices, undefined),
    })
  }
  const summary = remaining > 0
    ? h('p', { className: 'a2ui-chart-note' }, `${view.t('groupedSlices')}: ${remaining}`)
    : null
  const height = chartHeight(component, 220)
  const radius = Math.min(height, VIEW_WIDTH / 2) / 2 - 14
  const cx = VIEW_WIDTH / 4
  const cy = height / 2
  const donut = component.donut === true
  const suffix = component.valueSuffix === undefined ? '' : text(scope, component.valueSuffix)
  let angle = -Math.PI / 2
  const arcs = slices.map((slice, index) => {
    const sweep = (slice.value / total) * Math.PI * 2
    const start = angle
    const end = angle + sweep
    angle = end
    const large = sweep > Math.PI ? 1 : 0
    const mid = start + sweep / 2
    const lift = hover === index ? 7 : 0
    const x1 = cx + radius * Math.cos(start)
    const y1 = cy + radius * Math.sin(start)
    const x2 = cx + radius * Math.cos(end)
    const y2 = cy + radius * Math.sin(end)
    const path =
      sweep >= Math.PI * 2 - 1e-6
        ? `M${cx},${cy - radius} A${radius},${radius} 0 1 1 ${cx - 0.01},${cy - radius} Z`
        : `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`
    return { path, color: slice.color, index, mid, lift, share: slice.value / total }
  })

  const active = hover === null ? null : slices[hover]
  const centerTop = donut || active !== null
  const centerText =
    active === null
      ? [`${view.t('total')} ${trim(total)}`]
      : [active.label, `${trim(active.value)}${suffix === '' ? '' : ` ${suffix}`}`, `${Math.round((active.value / total) * 100)}%`]

  return h(
    'div',
    { className: 'a2ui-chart-wrap' },
    caption(scope, component),
    summary,
    h(
      'svg',
      {
        className: 'a2ui-chart-svg',
        viewBox: `0 0 ${VIEW_WIDTH} ${height}`,
        role: 'img',
        'aria-label': slices.map((slice) => `${slice.label} ${trim(slice.value)}`).join(', '),
        style: { maxHeight: `${height}px` },
      },
      ...arcs.map((arc) =>
        h('path', {
          key: `s${arc.index}`,
          d: arc.path,
          fill: arc.color,
          opacity: hover === null || hover === arc.index ? 0.94 : 0.45,
          style: {
            transform: arc.lift === 0 ? undefined : `translate(${(Math.cos(arc.mid) * arc.lift).toFixed(2)}px, ${(Math.sin(arc.mid) * arc.lift).toFixed(2)}px)`,
            transition: 'transform .14s ease, opacity .14s ease',
          },
          onMouseEnter: () => setHover(arc.index),
          onMouseLeave: () => setHover(null),
        }),
      ),
      donut ? h('circle', { cx, cy, r: radius * 0.58, fill: 'var(--dsw-alias-bg-layer-2)', pointerEvents: 'none' }) : null,
      centerTop && !donut
        ? h('circle', { cx, cy, r: radius * 0.46, fill: 'var(--dsw-alias-bg-layer-2)', opacity: 0.9, pointerEvents: 'none' })
        : null,
      centerTop
        ? h(
            'g',
            { pointerEvents: 'none' },
            ...centerText.map((line, index) =>
              h(
                'text',
                {
                  key: `c${index}`,
                  x: cx,
                  y: cy + (index - (centerText.length - 1) / 2) * 15 + 4,
                  textAnchor: 'middle',
                  fontSize: index === 0 ? 11 : 13,
                  fontWeight: index === 0 ? 500 : 600,
                  fill: 'var(--dsw-alias-label-primary)',
                },
                line,
              ),
            ),
          )
        : null,
      ...slices.slice(0, 10).map((slice, index) => {
        const isActive = hover === index
        return h(
          'g',
          {
            key: `t${index}`,
            onMouseEnter: () => setHover(index),
            onMouseLeave: () => setHover(null),
            style: { cursor: 'default' },
          },
          h('rect', { x: VIEW_WIDTH / 2 + 4, y: 16 + index * 19, width: 9, height: 9, rx: 2, fill: slice.color, opacity: hover === null || isActive ? 1 : 0.45 }),
          h(
            'text',
            {
              x: VIEW_WIDTH / 2 + 19,
              y: 24.5 + index * 19,
              fontSize: 11,
              fill: 'var(--dsw-alias-label-primary)',
              opacity: hover === null || isActive ? 1 : 0.5,
              textDecoration: isActive ? 'underline' : undefined,
            },
            `${slice.label.length > 18 ? `${slice.label.slice(0, 17)}…` : slice.label} · ${Math.round((slice.value / total) * 100)}%`,
          ),
        )
      }),
      // Legend cap: say how many entries are not listed instead of dropping them.
      slices.length > 10
        ? h(
            'text',
            { x: VIEW_WIDTH / 2 + 19, y: 24.5 + 10 * 19, fontSize: 11, fill: 'currentColor', opacity: 0.7 },
            `+${slices.length - 10}`,
          )
        : null,
    ),
  )
}

function scatterScale(values: number[], lower?: number, upper?: number, inset = 0): Scale {
  let min = lower ?? (values.length > 0 ? Math.min(...values) : (upper ?? 1) - 1)
  let max = upper ?? (values.length > 0 ? Math.max(...values) : (lower ?? 0) + 1)
  if (max <= min) {
    const edge = lower ?? upper ?? min
    const padding = edge === 0 ? 1 : Math.max(Math.abs(edge) * 0.1, Number.MIN_VALUE)
    if (lower === undefined) min = Math.max(-Number.MAX_VALUE, edge - padding)
    if (upper === undefined) max = Math.min(Number.MAX_VALUE, edge + padding)
  }
  if (inset > 0 && min < max) {
    const padding = (max * inset - min * inset) / (1 - 2 * inset)
    if (lower === undefined) min = Math.max(-Number.MAX_VALUE, min - padding)
    if (upper === undefined) max = Math.min(Number.MAX_VALUE, max + padding)
  }
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const part = index / 4
    return min * (1 - part) + max * part
  })
  return { min, max, ticks: [...new Set(ticks)] }
}

function bubbleRadius(size: number | undefined, maxSize: number, maxRadius: number): number {
  if (size === undefined || size === 0) return 3.5
  return Math.max(1.5, maxRadius * Math.sqrt(size / maxSize))
}

function numericTickLabels(ticks: number[]): string[] {
  const labels = ticks.map((value) => {
    const magnitude = Math.abs(value)
    return magnitude >= 1e12 || (magnitude > 0 && magnitude < 0.01) ? value.toExponential(2) : formatTick(value)
  })
  if (new Set(labels).size === labels.length) return labels
  const precise = ticks.map((value) => String(Number(value.toPrecision(9))))
  return new Set(precise).size === precise.length ? precise : ticks.map(String)
}

interface ScatterMark extends PlotPoint {
  key: string
  cx: number
  cy: number
  series: string
  color: string
  radius: number
}

interface PlotFrameProps {
  svg: React.SVGProps<SVGSVGElement>
  points: ScatterMark[]
  plotWidth: number
  plotHeight: number
  left: number
  xLabel: string
  yLabel: string
  sizeLabel: string
  interactive: boolean
  t: (key: string) => string
  children?: React.ReactNode
}

function PlotFrame(props: PlotFrameProps): ReturnType<typeof h> {
  const { points, svg, interactive, t } = props
  const id = React.useId()
  const svgRef = React.useRef<SVGSVGElement>(null)
  const [selection, setSelection] = React.useState<{
    index: number
    point: ScatterMark
    anchor: SVGGraphicsElement
    mode: 'hover' | 'keyboard' | 'pinned'
  }>()
  const current = selection === undefined ? undefined : points[selection.index]
  const active = selection !== undefined && current !== undefined && selection.anchor.isConnected
    && current.key === selection.point.key
    && current.x === selection.point.x && current.y === selection.point.y
    && current.size === selection.point.size
    && current.label === selection.point.label && current.series === selection.point.series
    ? current
    : undefined
  const groups = React.useMemo(() => {
    const byPosition = new Map<string, number[]>()
    points.forEach(({ x, y }, index) => {
      const key = `${x},${y}`
      const members = byPosition.get(key)
      if (members === undefined) byPosition.set(key, [index])
      else members.push(index)
    })
    return byPosition
  }, [points])
  const marks = React.useMemo(() => points.map((point, index) => ({ point, index }))
    .sort((a, b) => b.point.radius - a.point.radius)
    .map(({ point, index }) => h('circle', {
      key: point.key,
      'data-plot-point': index,
      cx: point.cx, cy: point.cy, r: point.radius,
      fill: point.size === 0 ? 'transparent' : point.color,
      fillOpacity: point.size === undefined ? undefined : 0.5,
      stroke: point.size === undefined ? 'transparent' : point.color,
      strokeWidth: point.size === undefined ? 8 : 1,
    })), [points])

  const pick = (index: number, mode: 'hover' | 'keyboard' | 'pinned'): void => {
    const point = points[index]
    const anchor = svgRef.current?.querySelector<SVGGraphicsElement>(`[data-plot-point="${index}"]`)
    if (point !== undefined && anchor) setSelection({ index, point, anchor, mode })
  }
  const pointIndex = (target: EventTarget): number | undefined => {
    const raw = (target as Element).getAttribute?.('data-plot-point')
    return raw == null ? undefined : Number(raw)
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = active === undefined ? undefined : selection?.index
    let next: number
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown': next = index === undefined ? 0 : (index + 1) % points.length; break
      case 'ArrowLeft':
      case 'ArrowUp': next = index === undefined ? points.length - 1 : (index - 1 + points.length) % points.length; break
      case 'Home': next = 0; break
      case 'End': next = points.length - 1; break
      case 'Escape':
        if (selection === undefined) return
        event.preventDefault()
        event.stopPropagation()
        setSelection(undefined)
        return
      default: return
    }
    event.preventDefault()
    pick(next, 'keyboard')
  }
  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const index = pointIndex(event.target)
    const point = index === undefined ? undefined : points[index]
    if (point === undefined || index === undefined) {
      setSelection(undefined)
      return
    }
    const overlaps = groups.get(`${point.x},${point.y}`) ?? [index]
    const selectedOverlap = active !== undefined && selection?.mode === 'pinned' ? overlaps.indexOf(selection.index) : -1
    pick(selectedOverlap === -1 ? index : overlaps[(selectedOverlap + 1) % overlaps.length], 'pinned')
  }
  const lines: string[] = []
  if (active !== undefined && selection !== undefined) {
    if (active.label) lines.push(active.label)
    lines.push(active.series, `${props.xLabel || 'X'}: ${active.x}`, `${props.yLabel || 'Y'}: ${active.y}`)
    if (active.size !== undefined) lines.push(`${props.sizeLabel}: ${active.size}`)
    const overlaps = groups.get(`${active.x},${active.y}`)
    if (overlaps !== undefined && overlaps.length > 1) {
      lines.push(t('scatterOverlap')
        .replace('{index}', String(overlaps.indexOf(selection.index) + 1))
        .replace('{total}', String(overlaps.length)))
    }
  }
  const clipId = `${id}-plot`
  return h('div', {
    className: 'a2ui-plot-frame',
    ...(interactive ? {
        role: 'group',
        tabIndex: 0,
        'aria-label': svg['aria-label'],
        'aria-describedby': `${id}-keys`,
        onFocus: () => pick(0, 'keyboard'),
        onBlur: () => setSelection(undefined),
        onKeyDown,
        onClick,
        onPointerOver: (event: React.PointerEvent<HTMLDivElement>) => {
          const index = pointIndex(event.target)
          if (index !== undefined && event.pointerType !== 'touch' && (active === undefined || selection?.mode !== 'pinned')) pick(index, 'hover')
        },
        onPointerOut: () => {
          if (selection?.mode === 'hover') setSelection(undefined)
        },
    } : {}),
  },
    h('svg', { ...svg, ref: svgRef, 'aria-hidden': interactive || undefined },
    h('defs', null, h('clipPath', { id: clipId },
      h('rect', { x: props.left, y: PAD.top, width: props.plotWidth, height: props.plotHeight }),
    )),
    props.children,
    h('g', { clipPath: `url(#${clipId})`, 'aria-hidden': true },
      ...marks,
      active === undefined ? null : h('circle', {
        cx: active.cx, cy: active.cy, r: active.radius + 1.5,
        fill: active.size === undefined ? active.color : 'none',
        stroke: 'currentColor', strokeWidth: 1.25, pointerEvents: 'none',
      }),
    )),
    interactive ? h('span', { id: `${id}-keys`, className: 'a2ui-visually-hidden' }, t('scatterKeyboard')) : null,
    interactive ? h('span', { className: 'a2ui-visually-hidden', role: 'status' },
      selection?.mode === 'hover' ? '' : lines.join(' · '),
    ) : null,
    selection !== undefined && active !== undefined ? h(ChartTooltip, { anchor: selection.anchor, lines }) : null,
  )
}

function readPlotVariables(scope: Scope, variablesRaw: unknown): Record<string, number> {
  const variables: Record<string, number> = {}
  // `variables` may be an object of per-variable bindings, or one binding that
  // resolves to the whole coefficient object (`{"@path": "/coefficients"}`).
  if (isDataBinding(variablesRaw) || isFunctionCall(variablesRaw)) {
    const resolved = anyValue(scope, variablesRaw)
    if (resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)) {
      for (const [key, value] of Object.entries(resolved as Record<string, unknown>)) {
        const numeric = typeof value === 'number' ? value : Number(value)
        if (Number.isFinite(numeric)) variables[key] = numeric
      }
    }
  } else if (variablesRaw !== undefined && variablesRaw !== null && typeof variablesRaw === 'object') {
    for (const [key, value] of Object.entries(variablesRaw as Record<string, unknown>)) {
      const resolved = numberValue(scope, value)
      if (resolved !== undefined) variables[key] = resolved
    }
  }
  return variables
}

interface SliderRange {
  name: string
  min: number
  max: number
}

function plotSliderRanges(scope: Scope, variablesRaw: unknown, variables: Record<string, number>): SliderRange[] {
  const whole = bindingPointer(variablesRaw)
  const variablePaths = new Map<string, string>()
  for (const name of Object.keys(variables)) {
    const propertyPath = name.replaceAll('~', '~0').replaceAll('/', '~1')
    const pointer = whole === undefined
      ? bindingPointer(isPlainObject(variablesRaw) ? variablesRaw[name] : undefined)
      : `${whole === '/' ? '' : whole}/${propertyPath}`
    if (pointer !== undefined) variablePaths.set(name, pointer)
  }
  if (variablePaths.size === 0) return []

  const sliderBounds = new Map<string, { min: number; max: number }>()
  for (const component of scope.view.state.components.values()) {
    if (component.component !== 'Slider') continue
    const pointer = bindingPointer(component.value)
    const min = typeof component.min === 'number' ? component.min : 0
    const max = typeof component.max === 'number' ? component.max : 100
    if (pointer === undefined || !Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) continue
    const previous = sliderBounds.get(pointer)
    sliderBounds.set(pointer, previous === undefined ? { min, max } : {
      min: Math.min(min, previous.min),
      max: Math.max(max, previous.max),
    })
  }
  const ranges: SliderRange[] = []
  for (const [name, pointer] of variablePaths) {
    const bounds = sliderBounds.get(pointer)
    if (bounds !== undefined) ranges.push({ name, ...bounds })
  }
  return ranges
}

/** Sample a bounded set of slider settings once, outside the drag's update loop. */
function linkedPlotExtent(
  component: A2UIComponent,
  fixed: Record<string, number>,
  ranges: SliderRange[],
): [number, number] | undefined {
  const { xMin, xMax, plots } = component
  if (typeof xMin !== 'number' || typeof xMax !== 'number' || !Number.isFinite(xMax - xMin) || !(xMax > xMin)
    || !Array.isArray(plots)) return undefined
  const expressions = plots.flatMap((entry) => {
    if (!isPlainObject(entry) || entry.kind === 'scatter' || typeof entry.expression !== 'string') return []
    const expression = tryCompileExpression(entry.expression)
    return expression?.variables.some((name) => ranges.some((range) => range.name === name)) ? [expression] : []
  })
  if (expressions.length === 0) return undefined
  const settings = ranges.reduce(
    (inputs, range) => inputs.flatMap((input) => [range.min, range.min / 2 + range.max / 2, range.max].map(
      (value) => ({ ...input, [range.name]: value }),
    )),
    [fixed],
  )
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const expression of expressions) {
    for (const input of settings) {
      const values = { ...input, x: xMin }
      for (let index = 0; index <= 80; index += 1) {
        values.x = xMin + (xMax - xMin) * (index / 80)
        const y = expression.evaluate(values)
        if (!Number.isFinite(y)) return undefined
        min = Math.min(min, y)
        max = Math.max(max, y)
      }
    }
  }
  return Number.isFinite(max - min) ? [min, max] : undefined
}

interface PlotOptions extends Pick<LegendProps, 'hidden' | 'onToggle'> {
  width?: number
  variables?: Record<string, number>
  linkedExtent?: [number, number]
}

/** `Plot` */
export function renderPlot(
  scope: Scope,
  component: A2UIComponent,
  options: PlotOptions = {},
): ReturnType<typeof h> {
  const { width = VIEW_WIDTH, variables = readPlotVariables(scope, component.variables), linkedExtent, hidden, onToggle } = options
  const view = scope.view
  const requestedXMin = numberValue(scope, component.xMin)
  const requestedXMax = numberValue(scope, component.xMax)
  if (requestedXMin !== undefined && requestedXMax !== undefined && !(requestedXMax > requestedXMin)) {
    return emptyChart(scope, component, view.t('plotInvalidRange'))
  }
  const samples = Math.max(8, Math.min(1200, numberValue(scope, component.samples) ?? 240))
  const plots = (Array.isArray(component.plots) ? component.plots.slice(0, LIMITS.maxSeries) : []).map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>
    const kind = record.kind === 'scatter' ? 'scatter' : 'function'
    let compiled: CompiledExpression | undefined
    let error = ''
    if (kind === 'function') {
      const expression = typeof record.expression === 'string' ? record.expression : ''
      try {
        compiled = compileExpression(expression)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : view.t('plotInvalid')
      }
    }
    const resolved = anyValue(scope, record.points)
    const violations: Violation[] = []
    if (resolved !== undefined && resolved !== null) plotPointList(resolved, '', violations)
    const points = violations.length === 0 && Array.isArray(resolved) ? resolved as PlotPoint[] : []
    return {
      label: record.label === undefined ? `${view.t('series')} ${index + 1}` : text(scope, record.label),
      kind,
      compiled,
      error,
      points,
      regression: kind === 'scatter' && record.regression === 'linear',
      invalidPoints: violations.length > 0,
      color: seriesColor(index, record.color),
    }
  })
  if (plots.length === 0 || plots.every((plot) => plot.error !== '' && plot.points.length === 0)) {
    return emptyChart(scope, component, plots.find((plot) => plot.error !== '')?.error || view.t('plotInvalid'))
  }

  if (plots.some((plot) => plot.invalidPoints)) {
    return emptyChart(scope, component, view.t('scatterInvalidPoints').replace('{limit}', String(LIMITS.maxSeriesPoints)))
  }
  const scatterOnly = plots.every((plot) => plot.kind === 'scatter')
  const hasPoints = plots.some((plot) => plot.points.length > 0)
  if (scatterOnly && !hasPoints) return emptyChart(scope, component, view.t('scatterEmpty'))
  const height = chartHeight(component, 250)
  const left = hasPoints ? 62 : PAD.left
  const plotWidth = width - left - PAD.right
  const plotHeight = height - PAD.top - PAD.bottom
  const sizes = plots.flatMap((plot) => plot.points.flatMap((point) => point.size === undefined ? [] : [point.size]))
  const maxSize = Math.max(0, ...sizes)
  const maxRadius = Math.min(16, plotWidth * 0.075, plotHeight * 0.12)
  const xScale = scatterOnly ? scatterScale(
    plots.flatMap((plot) => plot.points.map((point) => point.x)), requestedXMin, requestedXMax,
    sizes.length > 0 ? (maxRadius + 2) / plotWidth : 0,
  ) : undefined
  const xMin = xScale?.min ?? requestedXMin ?? -10
  const xMax = xScale?.max ?? requestedXMax ?? 10
  if (!(xMax > xMin)) return emptyChart(scope, component, view.t('plotInvalidRange'))

  const step = (xMax - xMin) / (samples - 1)
  const lines = plots.map((plot) => {
    if (plot.kind === 'scatter' || plot.compiled === undefined) return { ...plot, samples: [] as Array<{ x: number; y: number }> }
    const points: Array<{ x: number; y: number }> = []
    for (let index = 0; index < samples; index += 1) {
      const x = xMin + step * index
      const y = plot.compiled.evaluate({ ...variables, x })
      points.push({ x, y })
    }
    return { ...plot, samples: points }
  })
  const allY = lines.flatMap((line) => [...line.samples, ...line.points].map((point) => point.y)).filter(Number.isFinite)
  const yMin = numberValue(scope, component.yMin)
  const yMax = numberValue(scope, component.yMax)
  const scale = scatterOnly ? scatterScale(allY, yMin, yMax, sizes.length > 0 ? (maxRadius + 2) / plotHeight : 0) : niceScale(
    linkedExtent === undefined ? allY : [...allY, ...linkedExtent],
    yMin, yMax,
  )
  if (scatterOnly && !(scale.max > scale.min)) return emptyChart(scope, component, view.t('scatterInvalidYRange'))
  const xAt = (x: number): number => left + axisFraction(x, xMin, xMax) * plotWidth
  const yAt = (y: number): number => PAD.top + plotHeight - axisFraction(y, scale.min, scale.max) * plotHeight

  const xTicks = xScale?.ticks ?? Array.from({ length: 5 }, (_, index) => xMin + ((xMax - xMin) * index) / 4)
  const xTicksShown = hasPoints && width < 420 && xTicks.length === 5 ? [xTicks[0], xTicks[2], xTicks[4]] : xTicks
  const xLabels = hasPoints ? numericTickLabels(xTicksShown) : xTicksShown.map(formatTick)
  const yLabels = hasPoints ? numericTickLabels(scale.ticks) : scale.ticks.map(formatTick)

  const grid = h(
    'g',
    { className: 'a2ui-grid' },
    ...scale.ticks.map((tick, index) =>
      h(
        'g',
        { key: `gy${index}` },
        h('line', { x1: left, x2: left + plotWidth, y1: yAt(tick), y2: yAt(tick) }),
        h('text', { x: left - 6, y: yAt(tick) + 3.5, textAnchor: 'end', fontSize: 10 }, yLabels[index]),
      ),
    ),
    ...xTicksShown.map((tick, index) =>
      h(
        'g',
        { key: `gx${index}` },
        h('line', { x1: xAt(tick), x2: xAt(tick), y1: PAD.top, y2: PAD.top + plotHeight }),
        h('text', {
          x: xAt(tick), y: height - 10, fontSize: 10,
          textAnchor: hasPoints && index === xTicksShown.length - 1 ? 'end' : 'middle',
        }, xLabels[index]),
      ),
    ),
  )

  const marks: Array<ReturnType<typeof h>> = []
  const regressionSummaries: Array<ReturnType<typeof h>> = []
  const scatter: ScatterMark[] = []
  let outside = 0
  if (scale.min <= 0 && scale.max >= 0) {
    marks.push(h('line', { x1: left, x2: left + plotWidth, y1: yAt(0), y2: yAt(0), stroke: 'currentColor', opacity: 0.35, strokeWidth: 1 }))
  }
  lines.forEach((line, index) => {
    // Keep the domain derived from all series so comparison does not rescale the visible points.
    if (hidden?.has(index)) return
    // A curve that leaves the plotted domain (1/x, tan, a vertical asymptote) is
    // broken rather than connected across the gap.
    const evaluate = line.compiled?.evaluate
    const segments = splitPlotSegments(line.samples, scale.min, scale.max, evaluate === undefined ? undefined : (previous, next) => {
      // Probe a steep step for a discontinuity between the sampled positions.
      const jump = axisFraction(next.y, scale.min, scale.max) - axisFraction(previous.y, scale.min, scale.max)
      if (Math.abs(jump) < 0.25) return false
      const x = previous.x + (next.x - previous.x) / 2
      const y = evaluate({ ...variables, x })
      return !Number.isFinite(y) || y < scale.min || y > scale.max
    })

    segments.forEach((segment, segmentIndex) => {
      if (segment.length === 1) {
        marks.push(h('circle', { key: `fx${index}-${segmentIndex}`, cx: xAt(segment[0].x), cy: yAt(segment[0].y), r: 2, fill: line.color }))
        return
      }
      marks.push(
        h('path', {
          key: `f${index}-${segmentIndex}`,
          d: segment.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${xAt(point.x).toFixed(2)},${yAt(point.y).toFixed(2)}`).join(' '),
          fill: 'none',
          stroke: line.color,
          strokeWidth: 2,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    })
    if (line.regression) {
      const fit = fitLinearRegression(line.points)
      const segment = fit && visibleRegressionSegment(fit, { xMin, xMax, yMin: scale.min, yMax: scale.max })
      if (segment) {
        const [start, end] = segment
        marks.push(h('line', {
          key: `fit${index}`,
          'data-plot-regression': index,
          x1: xAt(start.x), y1: yAt(start.y), x2: xAt(end.x), y2: yAt(end.y),
          stroke: line.color, strokeWidth: 2, strokeDasharray: '6 4', pointerEvents: 'none',
        }))
      }
      const summary = fit === undefined ? view.t('scatterRegressionUnavailable')
        : fit.rSquared === undefined ? view.t('scatterRegressionConstant')
          : `${view.t('scatterRegression')} · R² ${Number(fit.rSquared.toFixed(3))}`
      regressionSummaries.push(h('span', { key: index },
        segment ? h('span', { className: 'a2ui-plot-fit-swatch', style: { color: line.color }, 'aria-hidden': true }) : null,
        `${line.label} · ${summary}`,
      ))
    }
    for (const [pointIndex, point] of line.points.entries()) {
      if (point.x < xMin || point.x > xMax || point.y < scale.min || point.y > scale.max) {
        outside += 1
        continue
      }
      scatter.push({
        ...point, key: `${index}-${pointIndex}`, cx: xAt(point.x), cy: yAt(point.y),
        series: line.label, color: line.color, radius: bubbleRadius(point.size, maxSize, maxRadius),
      })
    }
  })

  const invalid = plots.filter((plot) => plot.error !== '')
  const xLabel = component.xLabel === undefined ? '' : text(scope, component.xLabel)
  const yLabel = component.yLabel === undefined ? '' : text(scope, component.yLabel)
  const sizeLabel = (component.sizeLabel === undefined ? '' : text(scope, component.sizeLabel)) || view.t('scatterSize')
  const sizeTicks = [...new Set([
    ...(sizes.includes(0) ? [0] : []),
    ...(maxSize > 0 ? [Math.min(...sizes.filter((size) => size > 0)), maxSize] : []),
  ])]
  const sizeLabels = numericTickLabels(sizeTicks)
  const svg: React.SVGProps<SVGSVGElement> = {
    className: 'a2ui-chart-svg a2ui-axis',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${xLabel || 'x'} ${hasPoints ? xMin : trim(xMin)}..${hasPoints ? xMax : trim(xMax)}${yLabel === '' ? '' : ` · ${yLabel}`}`,
    style: { maxHeight: `${height}px` },
  }
  return h(
    'div',
    { className: 'a2ui-chart-wrap' },
    caption(scope, component),
    yLabel === '' ? null : h('p', { className: 'a2ui-plot-label' }, yLabel),
    scatter.length === 0
      ? h('svg', svg, grid, ...marks)
      : h(PlotFrame, { svg, points: scatter, plotWidth, plotHeight, left, xLabel, yLabel, sizeLabel, interactive: !view.streaming, t: view.t }, grid, ...marks),
    xLabel === '' ? null : h('p', { className: 'a2ui-plot-label a2ui-plot-label-x' }, xLabel),
    outside === 0 ? null : h('p', { className: 'a2ui-caption' }, view.t('scatterOutside').replace('{count}', String(outside))),
    invalid.length === 0
      ? null
      : h('p', { className: 'a2ui-error' }, ...invalid.map((plot, index) => h('span', { key: `e${index}` }, `${plot.label}: ${plot.error}; `))),
    legend({ series: lines, hidden, onToggle }),
    sizeTicks.length === 0 ? null : h('div', { className: 'a2ui-caption a2ui-plot-key a2ui-plot-size' },
      h('span', null, sizeLabel),
      ...sizeTicks.map((size, index) => {
        const diameter = 2 * bubbleRadius(size, maxSize, maxRadius)
        return h('span', { key: size },
          h('span', { className: 'a2ui-plot-size-swatch', 'aria-hidden': true,
            style: { width: diameter, height: diameter, background: size === 0 ? 'transparent' : undefined } }),
          sizeLabels[index],
        )
      }),
    ),
    regressionSummaries.length === 0 ? null : h('div', { className: 'a2ui-caption a2ui-plot-key' }, ...regressionSummaries),
  )
}

export function BarChartView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderBarChart(props.scope, props.component)
}

export function useChartWidth(ref: React.RefObject<HTMLDivElement>, responsive: boolean, minWidth = 240): number {
  const [width, setWidth] = React.useState(VIEW_WIDTH)
  React.useEffect(() => {
    const target = ref.current
    if (!responsive || !target) return
    const measure = (): void => {
      const available = Math.floor(target.clientWidth)
      if (available > 0) setWidth(Math.min(VIEW_WIDTH, Math.max(minWidth, available)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    return () => observer.disconnect()
  }, [ref, responsive, minWidth])
  return width
}

function paretoTickLabels(base: number, factors: number[]): string[] {
  const values = factors.map((factor) => base * factor)
  const finiteLabels = numericTickLabels(values.filter(Number.isFinite))
  let i = 0
  return values.map((value, index) => {
    if (Number.isFinite(value)) return finiteLabels[i++]
    const [significand, power] = base.toExponential(16).split('e')
    const [normalized, shift] = (Number(significand) * factors[index]).toExponential(2).split('e')
    return `${normalized}e+${Number(power) + Number(shift)}`
  })
}

function ParetoPlot({ scope, component, items }: {
  scope: Scope; component: A2UIComponent; items: ParetoItem[]
}): ReturnType<typeof h> {
  const t = scope.view.t
  const interactive = !scope.view.streaming
  const ref = React.useRef<HTMLDivElement>(null)
  const width = useChartWidth(ref, true)
  const id = React.useId()
  const [selection, setSelection] = React.useState<{
    index: number; item: ParetoItem; anchor: SVGGraphicsElement; keyboard: boolean
  }>()
  const { ordered, base, total } = React.useMemo(() => {
    const sorted = [...items].sort((a, b) => b.value - a.value)
    const base = sorted[0].value
    let total = 0
    // Sum scaled values so even several near-maximum finite values stay drawable.
    const ordered = sorted.map((item) => {
      const part = item.value / base
      total += part
      return { item, part, cumulative: total }
    })
    return { ordered, base, total }
  }, [items])
  const current = selection === undefined ? undefined : ordered[selection.index]
  const active = current?.item === selection?.item ? current : undefined
  const suffix = component.valueSuffix === undefined ? '' : text(scope, component.valueSuffix)
  const rawLabel = suffix === '' ? t('paretoValue') : `${t('paretoValue')} (${suffix})`
  const cumulativeLabel = t('paretoCumulative')
  const title = component.caption === undefined ? t('paretoChart') : text(scope, component.caption) || t('paretoChart')
  const fractions = [0, 0.25, 0.5, 0.75, 1]
  const labels = paretoTickLabels(base, fractions.map((fraction) => total * fraction))
  const ticks = fractions.map((fraction, index) => ({ fraction, label: labels[index] }))
  const height = chartHeight(component, 250)
  const left = Math.max(36, Math.max(...ticks.map((tick) => tick.label.length)) * 6 + 10)
  const right = 40
  const plotHeight = height - PAD.top - PAD.bottom
  const plotWidth = width - left - right
  const band = plotWidth / items.length
  const barWidth = Math.min(72, band * 0.68)
  const x = (index: number): number => left + band * (index + 0.5)
  const y = (fraction: number): number => PAD.top + plotHeight * (1 - fraction)
  const baseline = y(0)
  const barColor = seriesColor(0, undefined)
  const lineColor = seriesColor(1, undefined)
  const labelEvery = Math.max(1, Math.ceil(60 / band))
  const pickBar = (index: number): void => {
    const anchor = ref.current?.querySelector<SVGRectElement>(`[data-pareto-bar="${index}"]`)
    if (anchor) setSelection({ index, item: ordered[index].item, anchor, keyboard: true })
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const last = items.length - 1
    const index = active === undefined ? 0 : (selection?.index ?? 0)
    const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last }
    if (event.key === 'Escape') {
      if (selection === undefined) return
      event.stopPropagation()
      setSelection(undefined)
    } else {
      const next = moves[event.key]
      if (typeof next !== 'number') return
      pickBar(Math.max(0, Math.min(last, next)))
    }
    event.preventDefault()
  }
  const hover = (index: number) => interactive ? {
    onPointerEnter: (event: React.PointerEvent<SVGGraphicsElement>) => {
      setSelection({ index, item: ordered[index].item, anchor: event.currentTarget, keyboard: false })
    },
    onPointerLeave: () => setSelection((current) => current?.keyboard ? current : undefined),
    onClick: (event: React.MouseEvent<SVGGraphicsElement>) => {
      setSelection({ index, item: ordered[index].item, anchor: event.currentTarget, keyboard: false })
    },
  } : {}
  const lines = active === undefined ? [] : [
    active.item.label,
    `${t('paretoValue')}: ${active.item.value}${suffix === '' ? '' : ` ${suffix}`}`,
    `${cumulativeLabel}: ${trim(100 * active.cumulative / total)}%`,
  ]
  return h('div', { className: 'a2ui-chart-wrap a2ui-pareto' },
    caption(scope, component),
    h('div', { className: 'a2ui-bar-plot a2ui-plot-frame', ref,
      ...(interactive ? {
        role: 'group', tabIndex: 0, 'aria-label': title, 'aria-describedby': id,
        onFocus: () => pickBar(0), onBlur: () => setSelection(undefined), onKeyDown,
      } : {}),
    },
    h('svg', { className: 'a2ui-chart-svg a2ui-axis', viewBox: `0 0 ${width} ${height}`,
      role: 'img', 'aria-label': title, 'aria-hidden': interactive || undefined, style: { maxHeight: `${height}px` },
    },
    h('g', { className: 'a2ui-grid' }, ...ticks.map(({ fraction, label }) => h('g', { key: fraction },
      h('line', { x1: left, x2: width - right, y1: y(fraction), y2: y(fraction) }),
      h('text', { x: left - 6, y: y(fraction) + 3.5, textAnchor: 'end', fontSize: 10 }, label),
      h('text', { x: width - right + 5, y: y(fraction) + 3.5, fontSize: 10 }, `${fraction * 100}%`),
    ))),
    ...ordered.map(({ item, part }, index) => {
      const top = y(part / total)
      const labelSize = Math.max(2, Math.floor(Math.min(labelEvery * band, 2 * (x(index) - 3), 2 * (width - x(index) - 3), 88) / 11))
      return h('g', { key: `bar${index}` },
        h('rect', { 'data-pareto-bar': index, x: x(index) - barWidth / 2, width: barWidth,
          y: Math.min(top, baseline - 1), height: Math.max(1, baseline - top), rx: 2,
          fill: barColor, opacity: active === undefined || active === ordered[index] ? 0.92 : 0.55, ...hover(index),
        }),
        index % labelEvery === 0 ? h('text', { x: x(index), y: height - 9, textAnchor: 'middle', fontSize: 10 },
          visibleCategoryLabel(item.label, labelSize)) : null,
      )
    }),
    h('polyline', { 'data-pareto-line': '', points: ordered.map((row, index) => `${x(index)},${y(row.cumulative / total)}`).join(' '),
      fill: 'none', stroke: lineColor, strokeWidth: 2, strokeLinejoin: 'round', pointerEvents: 'none',
    }),
    ...ordered.map(({ cumulative }, index) => h('circle', {
      key: `share${index}`, cx: x(index), cy: y(cumulative / total), r: Math.min(3.2, band * 0.3),
      fill: lineColor, ...hover(index),
    })),
    ),
    interactive ? h('span', { id, className: 'a2ui-visually-hidden' }, t('paretoKeyboard')) : null,
    interactive ? h('span', { role: 'status', className: 'a2ui-visually-hidden' }, selection?.keyboard ? lines.join(' · ') : '') : null,
    selection && lines.length > 0 ? h(ChartTooltip, { anchor: selection.anchor, lines }) : null,
    ),
    h('div', { className: 'a2ui-caption a2ui-plot-key' },
      h('span', null, h('span', { className: 'a2ui-legend-swatch', style: { background: barColor }, 'aria-hidden': true }), rawLabel),
      h('span', null, h('span', { className: 'a2ui-pareto-line-swatch', style: { color: lineColor }, 'aria-hidden': true }), cumulativeLabel),
    ),
  )
}

export function ParetoChartView({ component, scope }: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  const t = scope.view.t
  const data = resolveParetoItems(component.items, resolveContext(scope), '/items')
  if (data.kind !== 'ready') {
    return emptyChart(scope, component, t(data.kind === 'pending' && scope.view.streaming ? 'displayWaiting' : 'displayInvalid'))
  }
  if (data.value.length === 0) return emptyChart(scope, component, t('chartEmpty'))
  if (data.value.every((item) => item.value === 0)) return emptyChart(scope, component, t('paretoZeroTotal'))
  return h(ParetoPlot, { scope, component, items: data.value })
}

export function LineChartView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderLineChart(props.scope, props.component)
}

export function PieChartView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  return renderPieChart(props.scope, props.component)
}

export function PlotView(props: { component: A2UIComponent; scope: Scope }): ReturnType<typeof h> {
  const { component, scope } = props
  const responsive = Array.isArray(component.plots)
    && component.plots.some((plot) => isPlainObject(plot) && (plot.kind === 'scatter' || plot.points !== undefined))
  const variables = readPlotVariables(scope, component.variables)
  const ranges = !scope.view.streaming && (component.yMin === undefined || component.yMax === undefined)
    ? plotSliderRanges(scope, component.variables, variables)
    : []
  const rangeKey = ranges.length === 0 || ranges.length > 2 ? '' : JSON.stringify({
    ranges,
    fixed: Object.fromEntries(Object.entries(variables).filter(([name]) => !ranges.some((range) => range.name === name))),
  })
  const extent = React.useMemo(() => {
    if (rangeKey === '') return undefined
    const input = JSON.parse(rangeKey) as { fixed: Record<string, number>; ranges: SliderRange[] }
    return linkedPlotExtent(component, input.fixed, input.ranges)
  }, [component, rangeKey])
  const ref = React.useRef<HTMLDivElement>(null)
  const width = useChartWidth(ref, responsive)
  const [hidden, setHidden] = React.useState<Set<number>>(() => new Set())
  const toggle = (index: number): void => {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  const content = renderPlot(scope, component, {
    width: responsive ? width : VIEW_WIDTH,
    variables,
    linkedExtent: extent,
    ...(responsive && !scope.view.streaming ? { hidden, onToggle: toggle } : {}),
  })
  return responsive ? h('div', { ref, className: 'a2ui-plot' }, content) : content
}

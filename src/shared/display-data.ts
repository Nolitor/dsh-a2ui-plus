import { resolveValue, type ResolveContext } from './binding.js'
import { LIMITS } from './limits.js'
import { isPlainObject } from './json.js'
import { arr, bindingOrCall, fail, isDataBinding, num, obj, str, type Check, type Violation } from './schema.js'

export const HEATMAP_SCALES = ['sequential', 'diverging'] as const
export const TIMELINE_STATUSES = ['done', 'current', 'upcoming', 'blocked'] as const

export interface HeatmapData {
  rowLabels: string[]
  columnLabels: string[]
  values: Array<Array<number | null>>
}

export interface TimelineEvent {
  when: string
  title: string
  description?: string
  status?: (typeof TIMELINE_STATUSES)[number]
}

export interface ParetoItem {
  label: string
  value: number
}

export interface ErrorRange {
  lower: number
  upper: number
}

export interface RadarData {
  axes: string[]
  scores: Array<Array<number | null>>
  min: number
  max: number
}

type ResolvedDisplayData<T> =
  | { kind: 'ready'; value: T; units: number }
  | { kind: 'pending' | 'invalid'; issue: Violation; units: number }

const heatmapLabels = arr(str({ minLength: 1 }), { max: LIMITS.maxHeatmapAxis })
const finiteNumber = num()
const nullableNumber: Check = (value, path, out) => {
  if (value !== null) finiteNumber(value, path, out)
}
const heatmapValues = arr(arr(nullableNumber, { max: LIMITS.maxHeatmapAxis }), { max: LIMITS.maxHeatmapAxis })
const timelineEvents = arr(obj({
  when: str({ minLength: 1 }),
  title: str({ minLength: 1 }),
  description: str(),
  status: str({ enum: TIMELINE_STATUSES }),
}, { required: ['when', 'title'] }), { max: LIMITS.maxTimelineEvents })
const paretoItems = arr(obj({ label: str({ minLength: 1 }), value: num({ min: 0 }) }, {
  required: ['label', 'value'],
}), { max: LIMITS.maxSeriesPoints })
const errorRange = obj({ lower: finiteNumber, upper: finiteNumber }, { required: ['lower', 'upper'] })
const errorRanges = arr((value, path, out) => {
  if (value !== null) errorRange(value, path, out)
}, { max: LIMITS.maxSeriesPoints })
const radarAxisName = str({ minLength: 1 })
const radarAxes = arr((value, path, out) => {
  radarAxisName(value, path, out)
  if (typeof value === 'string' && value !== '' && value.trim() === '') fail(out, path, 'must have a visible name')
}, { min: 3, max: LIMITS.maxRadarAxes })
const radarScores = arr(nullableNumber, { min: 3, max: LIMITS.maxRadarAxes })

function arrayOrBinding(check: Check): Check {
  return (value, path, out) => {
    if (isDataBinding(value)) bindingOrCall(value, path, out)
    else check(value, path, out)
  }
}

export const heatmapLabelInput = arrayOrBinding(heatmapLabels)
export const heatmapValueInput = arrayOrBinding(heatmapValues)
export const timelineEventInput = arrayOrBinding(timelineEvents)
export const paretoItemInput = arrayOrBinding(paretoItems)
export const errorRangeInput = arrayOrBinding(errorRanges)
export const radarAxisInput = arrayOrBinding(radarAxes)
export const radarScoreInput = arrayOrBinding(radarScores)

export function checkHeatmapScale(component: Record<string, unknown>, path: string, out: Violation[]): void {
  const { min, max } = component
  if ((min === undefined) !== (max === undefined)) {
    fail(out, `${path}/${min === undefined ? 'min' : 'max'}`, 'must be provided together with the other color bound')
  }
  if (typeof min !== 'number' || typeof max !== 'number') return
  if (!(min < max)) fail(out, `${path}/max`, 'must be greater than min')
  else if (component.scale === 'diverging' && !(min < 0 && max > 0)) {
    fail(out, `${path}/scale`, 'diverging color bounds must include values on both sides of zero')
  }
}

function resolveArray<T>(
  input: unknown,
  context: ResolveContext,
  check: Check,
  path: string,
): ResolvedDisplayData<T[]> {
  const bound = isDataBinding(input)
  const value = bound ? resolveValue(input, context) : input
  if (bound && value === undefined) {
    return { kind: 'pending', issue: { path, message: 'data binding does not resolve to a value' }, units: 0 }
  }
  const issues: Violation[] = []
  check(value, path, issues)
  if (issues.length > 0) return { kind: 'invalid', issue: issues[0], units: 0 }
  const array = value as T[]
  return { kind: 'ready', value: array, units: array.length }
}

export function resolveHeatmapData(
  component: Record<string, unknown>,
  context: ResolveContext,
  path: string,
): ResolvedDisplayData<HeatmapData> {
  const rows = resolveArray<string>(component.rowLabels, context, heatmapLabels, `${path}/rowLabels`)
  const columns = resolveArray<string>(component.columnLabels, context, heatmapLabels, `${path}/columnLabels`)
  const matrix = resolveArray<Array<number | null>>(component.values, context, heatmapValues, `${path}/values`)
  const units = matrix.kind === 'ready' ? matrix.value.reduce((count, row) => count + row.length, 0) : 0
  // Definite errors take precedence when other fields in the same stream are still arriving.
  for (const field of [rows, columns, matrix]) {
    if (field.kind === 'invalid') return { ...field, units }
  }
  if (rows.kind !== 'ready') return { ...rows, units }
  if (columns.kind !== 'ready') return { ...columns, units }
  if (matrix.kind !== 'ready') return matrix
  if (matrix.value.length !== rows.value.length) {
    return { kind: 'invalid', units, issue: { path: `${path}/values`, message: 'row count must match rowLabels' } }
  }
  for (const [index, row] of matrix.value.entries()) {
    if (row.length !== columns.value.length) {
      return { kind: 'invalid', units, issue: { path: `${path}/values/${index}`, message: 'column count must match columnLabels' } }
    }
  }
  return { kind: 'ready', units, value: { rowLabels: rows.value, columnLabels: columns.value, values: matrix.value } }
}

export function resolveTimelineEvents(
  input: unknown,
  context: ResolveContext,
  path: string,
): ResolvedDisplayData<TimelineEvent[]> {
  return resolveArray<TimelineEvent>(input, context, timelineEvents, path)
}

export function resolveParetoItems(input: unknown, context: ResolveContext, path: string): ResolvedDisplayData<ParetoItem[]> {
  return resolveArray<ParetoItem>(input, context, paretoItems, path)
}

function radarBounds(component: Record<string, unknown>): { min: number; max: number } {
  return {
    min: typeof component.min === 'number' ? component.min : 0,
    max: typeof component.max === 'number' ? component.max : 100,
  }
}

export function checkRadarScale(component: Record<string, unknown>, path: string, out: Violation[]): void {
  const { min, max } = radarBounds(component)
  if (!(min < max)) fail(out, `${path}/${component.max === undefined ? 'min' : 'max'}`, 'radar max must be greater than min')
}

export function resolveRadarData(
  component: Record<string, unknown>, context: ResolveContext, path: string,
): ResolvedDisplayData<RadarData> {
  const invalid = (at: string, message: string): ResolvedDisplayData<never> => ({
    kind: 'invalid', units: 0, issue: { path: at, message },
  })
  const { min, max } = radarBounds(component)
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
    return invalid(`${path}/max`, 'radar scale requires finite min and max with min < max')
  }
  const axes = resolveArray<string>(component.axes, context, radarAxes, `${path}/axes`)
  if (axes.kind === 'invalid') return axes
  const series = component.series
  if (!Array.isArray(series) || series.length < 1 || series.length > LIMITS.maxSeries) {
    return invalid(`${path}/series`, `must contain 1–${LIMITS.maxSeries} series`)
  }
  let units = axes.units
  let pending = axes.kind === 'pending' ? axes.issue : undefined
  const scores: RadarData['scores'] = []
  for (const [i, entry] of series.entries()) {
    const seriesPath = `${path}/series/${i}`
    if (!isPlainObject(entry)) return invalid(seriesPath, 'must be an object')
    const valuesPath = `${seriesPath}/values`
    const values = resolveArray<number | null>(entry.values, context, radarScores, valuesPath)
    if (values.kind !== 'ready') {
      if (values.kind === 'invalid') return values
      pending ??= values.issue
      continue
    }
    if (axes.kind === 'ready' && values.value.length !== axes.value.length) {
      return invalid(valuesPath, 'must contain one score or null per axis')
    }
    for (const [index, score] of values.value.entries()) {
      if (score !== null && (score < min || score > max)) {
        return invalid(`${valuesPath}/${index}`, `must be between ${min} and ${max}, or null`)
      }
    }
    scores.push(values.value)
    units += values.units
  }
  if (axes.kind !== 'ready') return { ...axes, units }
  if (pending !== undefined) return { kind: 'pending', units, issue: pending }
  return { kind: 'ready', value: { axes: axes.value, scores, min, max }, units }
}

/** Retain one slot per category so missing values never move a later mark. */
export function chartSeriesValues(value: unknown, categoryCount?: number): Array<number | undefined> {
  if (!Array.isArray(value)) return typeof value === 'number' && Number.isFinite(value) ? [value] : []
  const values = categoryCount === undefined ? value : value.slice(0, categoryCount)
  return values.map((entry) => {
    const number = typeof entry === 'string' && entry.trim() !== '' ? Number(entry) : entry
    return typeof number === 'number' && Number.isFinite(number) ? number : undefined
  })
}

export function resolveErrorRanges(
  input: unknown, categories: unknown, values: unknown, context: ResolveContext, path: string,
): ResolvedDisplayData<Array<ErrorRange | null>> {
  const ranges = resolveArray<ErrorRange | null>(input, context, errorRanges, path)
  if (ranges.kind !== 'ready') return ranges
  if (categories === undefined || values === undefined) {
    return { kind: 'pending', units: 0, issue: { path, message: 'requires resolved categories and series values' } }
  }
  const invalid = (at: string, message: string): ResolvedDisplayData<never> => ({
    kind: 'invalid', units: 0, issue: { path: at, message },
  })
  if (!Array.isArray(categories) || ranges.value.length !== categories.length) {
    return invalid(path, 'must contain one range or null per category')
  }
  const points = chartSeriesValues(values, categories.length)
  let units = 0
  for (const [index, range] of ranges.value.entries()) {
    if (range === null) continue
    const value = points[index]
    const itemPath = `${path}/${index}`
    if (value === undefined) return invalid(itemPath, 'cannot set an error range for a missing value')
    if (range.lower > value) return invalid(`${itemPath}/lower`, 'must be at or below the bar value')
    if (range.upper < value) return invalid(`${itemPath}/upper`, 'must be at or above the bar value')
    units += 1
  }
  return { ...ranges, units }
}

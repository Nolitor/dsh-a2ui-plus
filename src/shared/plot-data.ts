import { LIMITS } from './limits.js'
import { arr, bindingOrCall, isDataBinding, fail, num, obj, str, type Check } from './schema.js'

export interface PlotPoint {
  x: number
  y: number
  label?: string
  size?: number
}

export const plotPointList = arr(obj({ x: num(), y: num(), label: str(), size: num({ min: 0 }) }, { required: ['x', 'y'] }), {
  max: LIMITS.maxSeriesPoints,
})

export const plotPoints: Check = (value, path, out) => {
  if (Array.isArray(value)) plotPointList(value, path, out)
  else if (isDataBinding(value)) bindingOrCall(value, path, out)
  else fail(out, path, 'must be an array of points or a data-model binding')
}

interface PlotBounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

interface LinearFit extends PlotBounds {
  slope: number
  intercept: number
  rSquared?: number
}

export function axisFraction(value: number, min: number, max: number): number {
  const span = max - min
  const offset = value - min
  return Number.isFinite(span) && Number.isFinite(offset)
    ? offset / span
    : (value / 2 - min / 2) / (max / 2 - min / 2)
}

/** Fit in normalized coordinates to keep sums finite across the numeric range. */
export function fitLinearRegression(points: readonly PlotPoint[]): LinearFit | undefined {
  if (points.length < 2) return undefined
  const xMin = Math.min(...points.map((point) => point.x))
  const xMax = Math.max(...points.map((point) => point.x))
  if (xMin === xMax) return undefined
  const yMin = Math.min(...points.map((point) => point.y))
  const yMax = Math.max(...points.map((point) => point.y))
  if (yMin === yMax) return { xMin, xMax, yMin, yMax, slope: 0, intercept: 0 }

  const values = points.map(({ x, y }) => ({ x: axisFraction(x, xMin, xMax), y: axisFraction(y, yMin, yMax) }))
  const meanX = values.reduce((sum, point) => sum + point.x, 0) / values.length
  const meanY = values.reduce((sum, point) => sum + point.y, 0) / values.length
  let sumXX = 0
  let sumYY = 0
  let sumXY = 0
  for (const { x, y } of values) {
    const dx = x - meanX
    const dy = y - meanY
    sumXX += dx * dx
    sumYY += dy * dy
    sumXY += dx * dy
  }
  const slope = sumXY / sumXX
  const intercept = meanY - slope * meanX
  const rSquared = Math.min(1, (sumXY * sumXY) / (sumXX * sumYY))
  return { xMin, xMax, yMin, yMax, slope, intercept, rSquared }
}

function fromFraction(fraction: number, min: number, max: number): number {
  const span = max - min
  return Number.isFinite(span) ? min + fraction * span : min * (1 - fraction) + max * fraction
}

/** Clip the fitted segment to the axes without extrapolating beyond sample X. */
export function visibleRegressionSegment(fit: LinearFit, bounds: PlotBounds): [PlotPoint, PlotPoint] | undefined {
  const xMin = Math.max(bounds.xMin, fit.xMin)
  const xMax = Math.min(bounds.xMax, fit.xMax)
  if (!(xMin < xMax) || !(bounds.yMin < bounds.yMax)) return undefined
  if (fit.yMin === fit.yMax) {
    const y = fit.yMin
    return y >= bounds.yMin && y <= bounds.yMax ? [{ x: xMin, y }, { x: xMax, y }] : undefined
  }
  let start = axisFraction(xMin, fit.xMin, fit.xMax)
  let end = axisFraction(xMax, fit.xMin, fit.xMax)
  const low = axisFraction(bounds.yMin, fit.yMin, fit.yMax)
  const high = axisFraction(bounds.yMax, fit.yMin, fit.yMax)
  if (fit.slope === 0) {
    if (fit.intercept < low || fit.intercept > high) return undefined
  } else {
    const a = (low - fit.intercept) / fit.slope
    const b = (high - fit.intercept) / fit.slope
    start = Math.max(start, Math.min(a, b))
    end = Math.min(end, Math.max(a, b))
  }
  if (start >= end) return undefined
  const point = (x: number): PlotPoint => {
    const y = fromFraction(fit.intercept + fit.slope * x, fit.yMin, fit.yMax)
    return {
      x: Math.max(xMin, Math.min(xMax, fromFraction(x, fit.xMin, fit.xMax))),
      y: Math.max(bounds.yMin, Math.min(bounds.yMax, y)),
    }
  }
  return [point(start), point(end)]
}

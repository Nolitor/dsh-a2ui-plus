/**
 * The A2UI catalogs this plugin understands.
 *
 * `BASIC` mirrors the official v1.0 basic catalog
 * (`https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`, 18
 * component types); `EXTENSION` adds the data-display components the DeepSeek
 * Harness integration needs and that the basic catalog does not define. Both
 * are ordinary A2UI catalogs addressed by `catalogId`, so a payload stays a
 * protocol payload rather than a private format.
 *
 * Every property below was taken from the official v1.0 schemas shipped in
 * `@a2ui/web_core@0.15.0` (`src/catalogs/basic/v1/components/basic_components.js`
 * and `src/v1_0/schema/common-types.js`), not from prose.
 */
import {
  action,
  arr,
  bindingOrCall,
  bool,
  childList,
  childRef,
  dynBool,
  dynNum,
  dynNumList,
  dynStr,
  dynStrList,
  dynValue,
  fail,
  knownFunctions,
  num,
  obj,
  oneOf,
  str,
  type Check,
  type Violation,
} from './schema.js'
import { LIMITS } from './limits.js'
import { isPlainObject } from './json.js'
import { plotPoints } from './plot-data.js'
import { checkHeatmapScale, HEATMAP_SCALES, heatmapLabelInput, heatmapValueInput, timelineEventInput,
  errorRangeInput, paretoItemInput, checkRadarScale, radarAxisInput, radarScoreInput } from './display-data.js'

/** The official v1.0 basic catalog id. */
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json'
/** This plugin's extension catalog id (basic components plus data display). */
export const EXTENSION_CATALOG_ID = 'dsh-a2ui/catalog/v1'

export const PROTOCOL_VERSION = '1.0'

/** Which catalog an entry belongs to. */
export type CatalogOrigin = 'basic' | 'extension'

/** How a component declares child references, used for graph validation. */
export type ChildStyle = 'none' | 'single' | 'list' | 'tabs' | 'modal'

export interface ComponentSpec {
  readonly name: string
  readonly origin: CatalogOrigin
  readonly summary: string
  /** Property validators, excluding the common `id`/`component`/`catalogId`/`accessibility`/`metadata`/`weight`. */
  readonly properties: Record<string, Check>
  readonly required: readonly string[]
  readonly childStyle: ChildStyle
  /** Cross-property constraints for this component. */
  readonly check?: (component: Record<string, unknown>, path: string, out: Violation[]) => void
  /** Whether the component renders a selectable/editable control (used for a11y hints). */
  readonly interactive?: boolean
}

const weight: Check = num({ min: 0 })

/** `accessibility` block shared by every component. */
export const accessibilityValidator: Check = obj({
  label: dynStr,
  description: dynStr,
  live: str({ enum: ['off', 'polite', 'assertive'] }),
  hidden: dynBool,
})

/** `metadata` block shared by every component. */
export const metadataValidator: Check = obj({ extensions: obj({}, { strict: false }) })

const checks = arr(
  obj({ condition: bindingOrCall, message: str() }, { required: ['condition'] }),
  { max: LIMITS.maxChecks },
)

const justifyEnum = ['start', 'center', 'end', 'stretch', 'spaceAround', 'spaceBetween', 'spaceEvenly'] as const
const alignEnum = ['start', 'center', 'end', 'stretch'] as const

/* ------------------------------------------------------------------ */
/* Official basic catalog                                              */
/* ------------------------------------------------------------------ */

const BASIC_COMPONENTS: readonly ComponentSpec[] = [
  {
    name: 'Text',
    origin: 'basic',
    summary: 'A paragraph or caption. Supports **bold**, *italic* and `code` inline Markdown.',
    properties: {
      text: dynStr,
      variant: str({ enum: ['caption', 'body'] }),
      weight,
    },
    required: ['text'],
    childStyle: 'none',
  },
  {
    name: 'Image',
    origin: 'basic',
    summary: 'An image from an https URL or a data:image URI.',
    properties: {
      url: dynStr,
      description: dynStr,
      fit: str({ enum: ['contain', 'cover', 'fill', 'none', 'scaleDown'] }),
      variant: str({ enum: ['icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header'] }),
      weight,
    },
    required: ['url'],
    childStyle: 'none',
  },
  {
    name: 'Icon',
    origin: 'basic',
    summary: 'One glyph from the catalog icon set, a named SVG path, or a bound icon object.',
    properties: {
      name: oneOf([str(), obj({ svgPath: dynStr }), dynStr]),
      weight,
    },
    required: ['name'],
    childStyle: 'none',
  },
  {
    name: 'Video',
    origin: 'basic',
    summary: 'A video player for an https URL.',
    properties: { url: dynStr, posterUrl: dynStr, weight },
    required: ['url'],
    childStyle: 'none',
  },
  {
    name: 'AudioPlayer',
    origin: 'basic',
    summary: 'An audio player for an https URL.',
    properties: { url: dynStr, description: dynStr, weight },
    required: ['url'],
    childStyle: 'none',
  },
  {
    name: 'Row',
    origin: 'basic',
    summary: 'Horizontal layout of children.',
    properties: {
      children: childList,
      justify: str({ enum: justifyEnum }),
      align: str({ enum: alignEnum }),
      weight,
    },
    required: ['children'],
    childStyle: 'list',
  },
  {
    name: 'Column',
    origin: 'basic',
    summary: 'Vertical layout of children.',
    properties: {
      children: childList,
      justify: str({ enum: justifyEnum }),
      align: str({ enum: alignEnum }),
      weight,
    },
    required: ['children'],
    childStyle: 'list',
  },
  {
    name: 'List',
    origin: 'basic',
    summary: 'A vertical or horizontal list of children.',
    properties: {
      children: childList,
      direction: str({ enum: ['vertical', 'horizontal'] }),
      align: str({ enum: alignEnum }),
      weight,
    },
    required: ['children'],
    childStyle: 'list',
  },
  {
    name: 'Card',
    origin: 'basic',
    summary: 'A raised container around one child.',
    properties: { child: childRef, weight },
    required: ['child'],
    childStyle: 'single',
  },
  {
    name: 'Tabs',
    origin: 'basic',
    summary: 'Tabbed pages, each with a title and one child.',
    properties: {
      tabs: arr(obj({ title: dynStr, child: childRef }, { required: ['title', 'child'] }), { min: 1, max: LIMITS.maxTabs }),
      weight,
    },
    required: ['tabs'],
    childStyle: 'tabs',
  },
  {
    name: 'Modal',
    origin: 'basic',
    summary: 'A trigger component that opens a dialog containing another component.',
    properties: { trigger: childRef, content: childRef, weight },
    required: ['trigger', 'content'],
    childStyle: 'modal',
  },
  {
    name: 'Divider',
    origin: 'basic',
    summary: 'A horizontal or vertical rule.',
    properties: { axis: str({ enum: ['horizontal', 'vertical'] }), weight },
    required: [],
    childStyle: 'none',
  },
  {
    name: 'Button',
    origin: 'basic',
    summary: 'A labelled button. `action.event` sends an action to the agent; `action.functionCall` runs locally.',
    properties: {
      child: childRef,
      variant: str({ enum: ['default', 'primary', 'borderless'] }),
      action,
      checks,
      weight,
    },
    required: ['child', 'action'],
    childStyle: 'single',
    interactive: true,
  },
  {
    name: 'TextField',
    origin: 'basic',
    summary: 'A single- or multi-line text input, optionally bound to the data model.',
    properties: {
      label: dynStr,
      value: dynStr,
      placeholder: dynStr,
      variant: str({ enum: ['longText', 'number', 'shortText', 'obscured'] }),
      checks,
      weight,
    },
    required: ['label'],
    childStyle: 'none',
    interactive: true,
  },
  {
    name: 'CheckBox',
    origin: 'basic',
    summary: 'A boolean checkbox.',
    properties: { label: dynStr, value: dynBool, checks, weight },
    required: ['label', 'value'],
    childStyle: 'none',
    interactive: true,
  },
  {
    name: 'ChoicePicker',
    origin: 'basic',
    summary: 'A single- or multiple-choice selector; `value` is a string list.',
    properties: {
      label: dynStr,
      variant: str({ enum: ['multipleSelection', 'mutuallyExclusive'] }),
      options: arr(obj({ label: dynStr, value: str() }, { required: ['label', 'value'] }), { min: 1, max: LIMITS.maxOptions }),
      value: dynStrList,
      displayStyle: str({ enum: ['checkbox', 'chips'] }),
      filterable: bool,
      checks,
      weight,
    },
    required: ['options', 'value'],
    childStyle: 'none',
    interactive: true,
  },
  {
    name: 'Slider',
    origin: 'basic',
    summary: 'A numeric slider. Bind `value` to the data model to drive live updates.',
    properties: {
      label: dynStr,
      min: num(),
      max: num(),
      value: dynNum,
      steps: num({ min: 1, integer: true }),
      checks,
      weight,
    },
    required: ['max', 'value'],
    childStyle: 'none',
    interactive: true,
  },
  {
    name: 'DateTimeInput',
    origin: 'basic',
    summary: 'A date and/or time input holding an ISO 8601 string.',
    properties: {
      value: dynStr,
      enableDate: bool,
      enableTime: bool,
      min: dynStr,
      max: dynStr,
      label: dynStr,
      checks,
      weight,
    },
    required: [],
    childStyle: 'none',
    interactive: true,
  },
]

/* ------------------------------------------------------------------ */
/* Extension catalog: data display (not in the basic catalog)          */
/* ------------------------------------------------------------------ */

const colorString: Check = str({ pattern: /^(#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9-]+\)|[a-zA-Z]+)$/ })

const seriesFields = { label: dynStr, values: dynNumList, color: colorString }
const seriesEntry = obj(seriesFields, { required: ['values'] })

const chartCommon: Record<string, Check> = {
  categories: dynStrList,
  series: arr(seriesEntry, { min: 1, max: LIMITS.maxSeries }),
  caption: dynStr,
  valueSuffix: dynStr,
  yMin: num(),
  yMax: num(),
  height: num({ min: 120, max: 520 }),
  showLegend: bool,
  showValues: bool,
  weight,
}

function checkChartYRange(component: Record<string, unknown>, path: string, out: Violation[], equalMeansAuto = false): void {
  const { yMin, yMax } = component
  if (typeof yMin === 'number' && typeof yMax === 'number' && (yMin > yMax || (!equalMeansAuto && yMin === yMax))) {
    fail(out, `${path}/yMax`, 'must be greater than yMin')
  }
}

const EXTENSION_COMPONENTS: readonly ComponentSpec[] = [
  {
    name: 'Heatmap',
    origin: 'extension',
    summary: 'A numeric matrix with rowLabels, columnLabels and values; use null for missing cells and a diverging scale for signed data.',
    properties: {
      rowLabels: heatmapLabelInput,
      columnLabels: heatmapLabelInput,
      values: heatmapValueInput,
      scale: str({ enum: HEATMAP_SCALES }),
      min: num(),
      max: num(),
      unit: dynStr,
      caption: dynStr,
      weight,
    },
    required: ['rowLabels', 'columnLabels', 'values'],
    childStyle: 'none',
    check: checkHeatmapScale,
  },
  {
    name: 'Timeline',
    origin: 'extension',
    summary: 'A vertical sequence of events in input order. Each event has when and title, with optional description and status.',
    properties: { events: timelineEventInput, caption: dynStr, weight },
    required: ['events'],
    childStyle: 'none',
  },
  {
    name: 'Section',
    origin: 'extension',
    summary: 'A lightweight titled section with an optional description and stacked children.',
    properties: { title: dynStr, description: dynStr, children: childList, weight },
    required: ['title', 'children'],
    childStyle: 'list',
  },
  {
    name: 'Table',
    origin: 'extension',
    summary: `A data table with rows keyed by column key. Up to the first ${LIMITS.maxTableRows} rows can be viewed.`,
    properties: {
      columns: arr(
        obj(
          {
            key: str({ minLength: 1 }),
            label: dynStr,
            align: str({ enum: ['start', 'center', 'end'] }),
            width: num({ min: 24, max: 800 }),
            format: str({ enum: ['text', 'number', 'currency', 'percent', 'date'] }),
            decimals: num({ min: 0, max: 6, integer: true }),
            currency: str(),
          },
          { required: ['key', 'label'] },
        ),
        { min: 1, max: 24 },
      ),
      rows: dynValue,
      caption: dynStr,
      striped: bool,
      emptyText: dynStr,
      height: num({ min: 80, max: 640 }),
      weight,
    },
    required: ['columns', 'rows'],
    childStyle: 'none',
  },
  {
    name: 'BarChart',
    origin: 'extension',
    summary: 'A categorical bar chart. Supply one value per category. Vertical non-stacked series may include errorBars with absolute lower and upper bounds.',
    properties: {
      ...chartCommon,
      series: arr(obj({ ...seriesFields, errorBars: errorRangeInput, errorLabel: dynStr }, { required: ['values'] }),
        { min: 1, max: LIMITS.maxSeries }),
      horizontal: bool,
      stacked: bool,
    },
    required: ['categories', 'series'],
    childStyle: 'none',
    check: (component, path, out) => {
      checkChartYRange(component, path, out, true)
      if ((component.horizontal !== true && component.stacked !== true) || !Array.isArray(component.series)) return
      for (const [index, series] of component.series.entries()) {
        if (isPlainObject(series) && series.errorBars !== undefined) {
          fail(out, `${path}/series/${index}/errorBars`, 'only supported on vertical, non-stacked bars')
        }
      }
    },
  },
  {
    name: 'ParetoChart',
    origin: 'extension',
    summary: 'Rank nonnegative category totals in descending order and plot their cumulative share on a second axis. Pass items:[{label,value}] or bind the array.',
    properties: { items: paretoItemInput, caption: dynStr, valueSuffix: dynStr, height: num({ min: 120, max: 520 }), weight },
    required: ['items'],
    childStyle: 'none',
  },
  {
    name: 'RadarChart',
    origin: 'extension',
    summary: 'Compare profiles on 3–8 named axes with a common numeric scale (0–100 by default). Supply one score or null per axis in each series.',
    properties: {
      axes: radarAxisInput,
      series: arr(obj({ ...seriesFields, values: radarScoreInput }, { required: ['values'] }),
        { min: 1, max: LIMITS.maxSeries }),
      min: num(),
      max: num(),
      caption: dynStr,
      height: num({ min: 220, max: 520 }),
      weight,
    },
    required: ['axes', 'series'],
    childStyle: 'none',
    check: checkRadarScale,
  },
  {
    name: 'LineChart',
    origin: 'extension',
    summary: 'A line or area chart. Provide one value per category in order.',
    properties: {
      ...chartCommon,
      area: bool,
      showPoints: bool,
      curve: str({ enum: ['linear', 'smooth'] }),
      yLabel: dynStr,
    },
    required: ['categories', 'series'],
    childStyle: 'none',
    check: checkChartYRange,
  },
  {
    name: 'PieChart',
    origin: 'extension',
    summary: 'A pie or donut chart.',
    properties: {
      slices: arr(
        obj({ label: dynStr, value: dynNum, color: colorString }, { required: ['label', 'value'] }),
        { min: 1, max: LIMITS.maxSeriesPoints },
      ),
      caption: dynStr,
      donut: bool,
      valueSuffix: dynStr,
      height: num({ min: 140, max: 520 }),
      showLegend: bool,
      weight,
    },
    required: ['slices'],
    childStyle: 'none',
  },
  {
    name: 'Stat',
    origin: 'extension',
    summary: 'A KPI tile: label, value, optional unit, delta and trend.',
    properties: {
      label: dynStr,
      value: dynValue,
      unit: dynStr,
      delta: dynStr,
      trend: str({ enum: ['up', 'down', 'flat'] }),
      hint: dynStr,
      weight,
    },
    required: ['label', 'value'],
    childStyle: 'none',
  },
  {
    name: 'Progress',
    origin: 'extension',
    summary: 'A horizontal progress bar.',
    properties: {
      value: dynNum,
      max: num(),
      label: dynStr,
      tone: str({ enum: ['neutral', 'success', 'warning', 'danger'] }),
      showValue: bool,
      weight,
    },
    required: ['value'],
    childStyle: 'none',
  },
  {
    name: 'Plot',
    origin: 'extension',
    summary:
      'Numeric X/Y series. Use kind:"scatter" with points:[{x,y,label?,size?}] or a bound point array. Point size adds bubbles; regression:"linear" fits a line per scatter series. Function plots sample safe expressions and may bind variables to sliders.',
    properties: {
      plots: arr(
        obj(
          {
            label: dynStr,
            expression: str({ pattern: /^[\x20-\x7e]{1,240}$/ }),
            points: plotPoints,
            kind: str({ enum: ['function', 'scatter'] }),
            regression: str({ enum: ['linear'] }),
            color: colorString,
          },
          {},
        ),
        { min: 1, max: LIMITS.maxSeries },
      ),
      variables: dynValue,
      xMin: num(),
      xMax: num(),
      yMin: num(),
      yMax: num(),
      samples: num({ min: 8, max: 1200, integer: true }),
      xLabel: dynStr,
      yLabel: dynStr,
      sizeLabel: dynStr,
      caption: dynStr,
      height: num({ min: 140, max: 560 }),
      weight,
    },
    required: ['plots'],
    check: (component, path, out) => {
      checkChartYRange(component, path, out)
      if (!Array.isArray(component.plots) || component.plots.length === 0) return
      for (const [index, plot] of component.plots.entries()) {
        if (isPlainObject(plot) && plot.regression !== undefined && plot.kind !== 'scatter') {
          fail(out, `${path}/plots/${index}/regression`, 'requires kind "scatter"')
        }
      }
      const scatterOnly = component.plots.every((plot) => isPlainObject(plot) && plot.kind === 'scatter')
      const { xMin, xMax } = component
      if (scatterOnly && xMin === undefined && xMax === undefined) return
      if (xMin === undefined) fail(out, `${path}/xMin`, 'is required when xMax is given or a function is plotted')
      if (xMax === undefined) fail(out, `${path}/xMax`, 'is required when xMin is given or a function is plotted')
    },
    childStyle: 'none',
  },
  {
    name: 'FramePlayer',
    origin: 'extension',
    summary:
      'A step animation player for precomputed frames (for example every step of a sort). Play, pause, step, reset and speed run locally with no model round trip.',
    properties: {
      frames: arr(
        obj(
          {
            label: dynStr,
            items: arr(
              obj(
                {
                  label: dynStr,
                  value: num(),
                  state: str({ enum: ['idle', 'active', 'compare', 'sorted', 'done'] }),
                },
                { required: ['value'] },
              ),
              { max: LIMITS.maxFrameItems },
            ),
          },
          { required: ['items'] },
        ),
        { min: 1, max: LIMITS.maxFrames },
      ),
      mode: str({ enum: ['bars', 'list'] }),
      speed: num({ min: 80, max: 3000 }),
      caption: dynStr,
      autoplay: bool,
      weight,
    },
    required: ['frames'],
    childStyle: 'none',
    interactive: true,
  },
]

export const COMPONENTS: readonly ComponentSpec[] = [...BASIC_COMPONENTS, ...EXTENSION_COMPONENTS]

export const COMPONENT_BY_NAME: ReadonlyMap<string, ComponentSpec> = new Map(
  COMPONENTS.map((spec) => [spec.name, spec]),
)

/** Names accepted by the extension catalog (it contains both sets). */
export const EXTENSION_COMPONENT_NAMES: ReadonlySet<string> = new Set(
  COMPONENTS.filter((spec) => spec.origin === 'extension').map((spec) => spec.name),
)

export const CATALOG_IDS: ReadonlySet<string> = new Set([BASIC_CATALOG_ID, EXTENSION_CATALOG_ID])

/**
 * Resolve the catalog a surface or component declares.
 * @returns the effective catalog id, or `undefined` when it is unknown.
 */
export function resolveCatalogId(surfaceCatalogId: string | undefined, componentCatalogId?: string): string | undefined {
  const id = componentCatalogId ?? surfaceCatalogId ?? EXTENSION_CATALOG_ID
  if (id === BASIC_CATALOG_ID) return BASIC_CATALOG_ID
  if (id === EXTENSION_CATALOG_ID) return EXTENSION_CATALOG_ID
  return undefined
}

/** Whether `name` is defined by `catalogId`. */
export function componentAllowedIn(catalogId: string, name: string): boolean {
  const spec = COMPONENT_BY_NAME.get(name)
  if (spec === undefined) return false
  if (catalogId === BASIC_CATALOG_ID) return spec.origin === 'basic'
  return true
}

/* ------------------------------------------------------------------ */
/* Function registry                                                   */
/* ------------------------------------------------------------------ */

/** Function names the official basic catalog declares, plus the `@index` system function. */
export const BASIC_FUNCTION_NAMES = [
  'required',
  'regex',
  'length',
  'numeric',
  'email',
  'formatString',
  'formatNumber',
  'formatCurrency',
  'formatDate',
  'pluralize',
  'openUrl',
  'and',
  'or',
  'not',
  '@index',
] as const

for (const name of BASIC_FUNCTION_NAMES) knownFunctions.add(name)

/* ------------------------------------------------------------------ */
/* Model-facing documentation                                          */
/* ------------------------------------------------------------------ */

function describeProperties(spec: ComponentSpec, detail: 'brief' | 'full'): string {
  if (detail === 'brief') return spec.summary
  const required = new Set(spec.required)
  const parts: string[] = []
  for (const key of Object.keys(spec.properties)) {
    if (key === 'weight') continue
    parts.push(`${key}${required.has(key) ? '*' : ''}`)
  }
  return parts.join(', ')
}

/**
 * Compact, model-facing reference for the catalogs.
 * @param detail `brief` lists component names and purpose; `full` adds property names.
 */
export function describeCatalog(detail: 'brief' | 'full' = 'full'): string {
  const lines: string[] = []
  lines.push('A2UI 1.0 catalogs available to this plugin.')
  lines.push('')
  // The annotation states what the caller must satisfy, not the classification
  // twice: a scheme hint where a scheme is checked, and the gesture requirement.
  lines.push(
    'capabilities.rendererFunctions: ' +
      RENDERER_FUNCTION_CAPABILITIES.map((fn) => `${fn.name} (${describeCapability(fn)})`).join(', '),
  )
  lines.push('Call one with {"version":"1.0","callRendererFunction":{"surfaceId","functionCallId","callFunction":{"@call":name,"args":{...}}}}; the answer returns as agentFunctionResponse.')
  lines.push(`Default catalogId: ${EXTENSION_CATALOG_ID} (the official basic catalog ${BASIC_CATALOG_ID} is also accepted; entries marked [extension] belong to this plugin).`)
  lines.push('')
  lines.push('Components (* = required property). Every component needs "id" and "component". The root component id MUST be "root"; createSurface implicitly wraps it in the canonical Surface container.')
  lines.push('')
  for (const spec of COMPONENTS) {
    const props = describeProperties(spec, detail)
    lines.push(`- ${spec.name}${spec.origin === 'extension' ? ' [extension]' : ''}: ${detail === 'brief' ? spec.summary : props}`)
  }
  if (detail === 'full') {
    lines.push('')
    lines.push('Values: a property that takes DynamicString/DynamicNumber/DynamicBoolean may be a literal, a data binding {"@path":"/json/pointer"}, or a function call {"@call":"name","args":{...}}.')
    lines.push(`Functions: ${BASIC_FUNCTION_NAMES.join(', ')}.`)
    lines.push('Child references: Card/Button take "child"; Row/Column/List/Section take "children" (array of ids, or {"componentId","path"} for a data-model list); Tabs take "tabs":[{"title","child"}]; Modal takes "trigger" and "content".')
    lines.push('Actions: {"event":{"name":"submit","userMessage":"...","context":{"field":{"@path":"/field"}}}} sends an action to you; {"functionCall":{...}} runs locally.')
    lines.push('Layout: positive "weight" lets siblings share available space along their parent flex layout. Use it for widths in Row or horizontal List, and for heights in Column or vertical List.')
    lines.push(`Row/Column "justify" values: ${justifyEnum.join(', ')}. The CSS spellings space-around, space-between and space-evenly are accepted as aliases.`)
    lines.push(`Table rows are objects keyed by column key. The table makes only the first ${LIMITS.maxTableRows} rows available when there are more.`)
    lines.push('BarChart/LineChart: provide one value per category in the same order. Use zero only when the value is actually zero.')
    lines.push('BarChart error bars: vertical ordinary and grouped series accept errorBars:[{lower,upper},null,...] or a bound array, one slot per category. Bounds are absolute and must contain the bar value. Set errorLabel to the known meaning, e.g. "95% CI".')
    lines.push('ParetoChart: items:[{label,value}] or a bound array, with nonnegative values and a common unit in valueSuffix. The chart sorts items and calculates cumulative share.')
    lines.push('RadarChart: axes:["Speed","Quality","Cost"] and series:[{label,values:[72,90,null]}]. Each axis uses one shared scale (min 0, max 100 by default). Score arrays and axes may bind with @path. Use null for missing scores; they leave a gap.')
    lines.push('Plot: scatter points are exact numeric coordinates. Only scatter-only plots can omit both xMin and xMax. xLabel and yLabel can include units.')
    lines.push('Plot bubbles: add a finite nonnegative size to each sized point and set sizeLabel for its metric and units. Omitted size draws a normal dot. Use regression:"linear" on a scatter series to fit its original X/Y data; no formula input is needed.')
    lines.push(`Heatmap: values match rowLabels × columnLabels (max ${LIMITS.maxHeatmapAxis} on each axis). Arrays may bind with @path. Use numbers or null in cells. scale is "sequential" (default) or "diverging" (centered at zero); provide min and max together for a fixed color scale. unit and caption are optional.`)
    lines.push(`Timeline: events is an array or @path binding (max ${LIMITS.maxTimelineEvents} events). Each event has when and title, with optional description and status: done, current, upcoming, or blocked. Put events in the intended reading order and write when as ready-to-display text.`)
    lines.push('Minimal component examples:')
    lines.push('  Text: {"id":"root","component":"Text","text":"Summary","variant":"body"}')
    lines.push('  Table: {"id":"root","component":"Table","columns":[{"key":"name","label":"Name"}],"rows":[{"name":"Alpha"}]}')
    lines.push('  Weighted Row: [{"id":"root","component":"Row","children":["left","right"]},{"id":"left","component":"Text","text":"Wide","weight":2},{"id":"right","component":"Text","text":"Narrow","weight":1}]')
  }
  return lines.join('\n')
}

/** One function's requirement, as the catalog prints it. */
export function describeCapability(fn: { kind: 'pure' | 'gesture' | 'local'; name: string }): string {
  const parts: string[] = []
  if (fn.name === 'openUrl' || fn.name === 'downloadFile') parts.push('scheme=https')
  if (fn.kind === 'gesture') parts.push('gesture-required')
  if (parts.length === 0) parts.push(fn.kind === 'pure' ? 'pure' : 'local')
  return parts.join(', ')
}

/**
 * The renderer functions an agent may call, as the catalog advertises them.
 *
 * This table is the single declaration: `host/actions.ts` refuses anything not
 * named here, and the catalog tool prints it, so what the model is told and what
 * the Host accepts cannot drift. `gesture: true` means the call needs a real user
 * action; `pure` answers on its own.
 */
export const RENDERER_FUNCTION_CAPABILITIES: readonly {
  name: string
  kind: 'pure' | 'gesture' | 'local'
  gesture: boolean
  summary: string
}[] = [
  { name: 'openUrl', kind: 'gesture', gesture: true, summary: 'Open an http(s) URL in the user\'s browser.' },
  { name: 'scrollTo', kind: 'local', gesture: false, summary: 'Scroll the surface to a component id.' },
  { name: 'copyToClipboard', kind: 'gesture', gesture: true, summary: 'Copy text to the clipboard.' },
  { name: 'downloadFile', kind: 'gesture', gesture: true, summary: 'Save text as a file.' },
  { name: 'validateForm', kind: 'pure', gesture: false, summary: 'Check the bound form paths and answer immediately.' },
  { name: 'requestFilePicker', kind: 'gesture', gesture: true, summary: 'Ask the user to choose a file.' },
]

/** Every component name, in catalog order. */
export const COMPONENT_NAMES: readonly string[] = COMPONENTS.map((spec) => spec.name)

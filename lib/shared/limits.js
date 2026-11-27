/**
 * Resource limits for model-authored A2UI payloads.
 *
 * The model is an untrusted author: every A2UI payload is data that must be
 * bounded before it reaches the renderer or the session log. These limits are
 * enforced by the Host tool (rejecting the call with a precise reason) and
 * again by the browser renderer (which must stay responsive even when it reads
 * a payload written by an older or a newer plugin version).
 */
export const LIMITS = {
    /** Maximum number of A2UI messages in one tool call. */
    maxMessages: 32,
    /** Maximum number of components in one message. */
    maxComponentsPerMessage: 300,
    /** Maximum number of components on one surface. */
    maxComponentsPerSurface: 400,
    /** Maximum number of live surfaces referenced by one tool call. */
    maxSurfacesPerCall: 16,
    /** Maximum serialized payload size of one tool call, in characters. */
    maxPayloadChars: 384_000,
    /** Maximum nesting depth of the component graph (logical child edges). */
    maxDepth: 64,
    /**
     * Maximum number of component *instances* one surface may expand to after
     * template repetition, before any React element is created.
     */
    maxExpandedNodes: 4_000,
    /** Maximum rows + chart points + animation items one surface may render. */
    maxExpandedDataUnits: 5_000,
    /**
     * Maximum rendered components across *all* surfaces of one call. A payload with
     * several surfaces could otherwise stay under every per-surface cap while
     * still building a huge tree.
     */
    maxTotalExpandedNodes: 6_000,
    /** Maximum data rows + points + animation items across all surfaces of a call. */
    maxTotalExpandedDataUnits: 6_000,
    /** Maximum length of one string property value. */
    maxStringLength: 16_384,
    /** Maximum length of a component id or surface id. */
    maxIdLength: 128,
    /** Maximum number of options in a ChoicePicker. */
    maxOptions: 200,
    /** Maximum number of rows in a Table. */
    maxTableRows: 500,
    /** Maximum number of columns in a Table, or categories in a chart series. */
    maxSeriesPoints: 500,
    /** Row and column limit of each heatmap. */
    maxHeatmapAxis: 40,
    /** Dimension limit for a radar chart. */
    maxRadarAxes: 8,
    /** Maximum number of events on one timeline. */
    maxTimelineEvents: 100,
    /** Maximum number of animation frames in a FramePlayer. */
    maxFrames: 400,
    /** Maximum number of items in a FramePlayer frame. */
    maxFrameItems: 200,
    /** Maximum number of `checks` rules per input component. */
    maxChecks: 8,
    /** Maximum number of tabs. */
    maxTabs: 12,
    /** Maximum number of series in a chart. */
    maxSeries: 8,
    /** Maximum length of a chip/comment captured in an action context value. */
    maxActionContextChars: 32_768,
};
/** Stable, user-visible message for a limit breach. */
export function limitMessage(what, limit, actual) {
    return `${what} exceeds the A2UI limit of ${limit} (got ${actual})`;
}

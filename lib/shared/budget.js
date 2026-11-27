/**
 * Render-budget estimation.
 *
 * A model-authored graph can stay small as *definitions* while expanding to a
 * huge React tree: seven components that each render six children per level
 * reach 46,656 leaves, and one template bound to a long data list does the same.
 * The validator and the renderer therefore ask the same estimator — before any
 * element is created — how many nodes a surface would actually produce, and
 * reject or degrade the card when the answer is too large.
 */
import { isPlainObject } from './json.js';
import { LIMITS } from './limits.js';
import { isChildTemplate, childReferences } from './graph.js';
import { resolveBinding, resolveValue } from './binding.js';
import { plotPointList } from './plot-data.js';
import { resolveErrorRanges, resolveHeatmapData, resolveParetoItems, resolveRadarData, resolveTimelineEvents } from './display-data.js';
function contextFor(state, item) {
    return { dataModel: state.dataModel, item, locale: 'en', now: 0 };
}
/** Rows/points/items a single component would materialise. */
function dataUnitsOf(component, state, item, streaming) {
    const context = contextFor(state, item);
    const name = component.component;
    if (name === 'Heatmap' || name === 'Timeline') {
        const path = `/components/${component.id}`;
        const data = name === 'Heatmap'
            ? resolveHeatmapData(component, context, path)
            : resolveTimelineEvents(component.events, context, `${path}/events`);
        return data.kind === 'ready' || (data.kind === 'pending' && streaming) ? data.units : data.issue;
    }
    if (name === 'ParetoChart') {
        const data = resolveParetoItems(component.items, context, `/components/${component.id}/items`);
        return data.kind === 'ready' || (data.kind === 'pending' && streaming) ? data.units * 2 : data.issue;
    }
    if (name === 'RadarChart') {
        const data = resolveRadarData(component, context, `/components/${component.id}`);
        return data.kind === 'ready' || (data.kind === 'pending' && streaming) ? data.units : data.issue;
    }
    try {
        if (name === 'Table') {
            const rows = resolveValue(component.rows, context);
            return Array.isArray(rows) ? rows.length : 0;
        }
        if (name === 'BarChart' || name === 'LineChart') {
            const categories = name === 'BarChart' ? resolveValue(component.categories, context) : component.categories;
            const series = Array.isArray(component.series) ? component.series : [];
            let points = 0;
            for (const [index, entry] of series.entries()) {
                if (!isPlainObject(entry))
                    continue;
                const values = resolveValue(entry.values, context);
                points += Array.isArray(values) ? values.length : 0;
                if (name === 'BarChart' && entry.errorBars !== undefined) {
                    const path = `/components/${component.id}/series/${index}/errorBars`;
                    const ranges = resolveErrorRanges(entry.errorBars, categories, values, context, path);
                    if (ranges.kind !== 'ready' && !(ranges.kind === 'pending' && streaming))
                        return ranges.issue;
                    points += ranges.units;
                }
            }
            return (Array.isArray(categories) ? categories.length : 0) + points;
        }
        if (name === 'PieChart') {
            return Array.isArray(component.slices) ? component.slices.length : 0;
        }
        if (name === 'FramePlayer') {
            const frames = Array.isArray(component.frames) ? component.frames : [];
            let items = 0;
            for (const frame of frames) {
                if (isPlainObject(frame) && Array.isArray(frame.items))
                    items += frame.items.length;
            }
            return items;
        }
        if (name === 'Plot') {
            // Count what the renderer actually draws: every scatter point becomes a
            // circle, and every function plot adds `samples` computed points. The old
            // `plots × samples` estimate ignored data-bound scatter series entirely.
            const plots = Array.isArray(component.plots) ? component.plots : [];
            const requested = typeof component.samples === 'number' ? component.samples : 240;
            const samples = Math.max(8, Math.min(1200, requested));
            let units = 0;
            for (const [index, plot] of plots.entries()) {
                if (!isPlainObject(plot))
                    continue;
                const points = Array.isArray(plot.points) ? plot.points : resolveValue(plot.points, context);
                if (points !== undefined && points !== null && !Array.isArray(plot.points)) {
                    const errors = [];
                    plotPointList(points, `/components/${component.id}/plots/${index}/points`, errors);
                    if (errors.length > 0)
                        return errors[0];
                }
                if (Array.isArray(points)) {
                    units += points.length;
                    if (points.length >= 2 && plot.kind === 'scatter' && plot.regression === 'linear')
                        units += 2;
                }
                const scatter = plot.kind === 'scatter' || typeof plot.expression !== 'string';
                if (!scatter)
                    units += samples;
            }
            return units;
        }
    }
    catch {
        return 0;
    }
    return 0;
}
/**
 * Estimate how large a surface becomes when rendered.
 *
 * @param state folded surface (components + data model).
 * @param maxNodes override the node budget (defaults to `LIMITS.maxExpandedNodes`).
 * @param maxDataUnits override the data-unit budget.
 * @param streaming allow a new component to wait for an unresolved binding.
 */
export function estimateExpansion(state, maxNodes = LIMITS.maxExpandedNodes, maxDataUnits = LIMITS.maxExpandedDataUnits, streaming = false) {
    let nodes = 0;
    let dataUnits = 0;
    const stack = [{ id: 'root', depth: 0 }];
    while (stack.length > 0) {
        const frame = stack.pop();
        if (frame.depth > LIMITS.maxDepth) {
            nodes += 1;
            if (nodes > maxNodes)
                return { nodes, dataUnits, reason: `expands to more than ${maxNodes} rendered components` };
            continue;
        }
        const component = state.components.get(frame.id);
        if (component === undefined)
            continue;
        nodes += 1;
        if (nodes > maxNodes)
            return { nodes, dataUnits, reason: `expands to more than ${maxNodes} rendered components` };
        const units = dataUnitsOf(component, state, frame.item, streaming);
        if (typeof units !== 'number')
            return { nodes, dataUnits, reason: units.message, path: units.path };
        dataUnits += units;
        if (dataUnits > maxDataUnits)
            return { nodes, dataUnits, reason: `renders more than ${maxDataUnits} data rows, points or animation items` };
        // Template child list: expand it here so the estimate counts repetitions.
        const children = component.children;
        if (isChildTemplate(children)) {
            const list = resolveBinding(children.path, contextFor(state, frame.item));
            if (Array.isArray(list)) {
                if (nodes + list.length > maxNodes) {
                    return { nodes: nodes + list.length, dataUnits, reason: `expands to more than ${maxNodes} rendered components` };
                }
                for (const item of list)
                    stack.push({ id: children.componentId, item: item, depth: frame.depth + 1 });
                continue;
            }
        }
        for (const reference of childReferences(component)) {
            stack.push({ id: reference.id, item: frame.item, depth: frame.depth + 1 });
        }
    }
    return { nodes, dataUnits };
}

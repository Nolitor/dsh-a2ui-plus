/**
 * Styles for the A2UI renderer.
 *
 * Everything is prefixed `.a2ui-` and every colour comes from a
 * `--dsw-alias-*` theme token (or `currentColor`), so light/dark switching and
 * future token renames degrade gracefully. The categorical chart palette is the
 * one intentional exception: a data series needs distinguishable hues that are
 * legible on both backgrounds and no theme token provides a palette.
 */
export const CSS = `
.a2ui-root{--a2ui-radius:10px;--a2ui-space-xs:4px;--a2ui-space-sm:8px;--a2ui-gap:10px;--a2ui-panel-padding:14px;
  --a2ui-body-size:13px;--a2ui-heading-size:14px;--a2ui-caption-size:11.5px;
  --a2ui-fg:var(--dsw-alias-label-primary);--a2ui-muted:var(--dsw-alias-label-secondary);--a2ui-border:var(--dsw-alias-border-l1);
  --a2ui-c1:#4c8dff;--a2ui-c2:#2fb37a;--a2ui-c3:#e8a33d;--a2ui-c4:#d96a8b;--a2ui-c5:#8c7bf0;--a2ui-c6:#2ab6c6;--a2ui-c7:#e0684b;--a2ui-c8:#7d8fa8;
  container:a2ui / inline-size;display:block;min-width:0;width:100%;color:var(--a2ui-fg);font-size:var(--a2ui-body-size);line-height:1.55;box-sizing:border-box}
.a2ui-root *,.a2ui-root *::before,.a2ui-root *::after{box-sizing:border-box}
.a2ui-card{border:1px solid var(--a2ui-border);background:var(--dsw-alias-bg-layer-2);border-radius:14px;overflow:hidden;min-width:0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.a2ui-card-head{display:flex;align-items:center;gap:var(--a2ui-space-sm);padding:var(--a2ui-gap) var(--a2ui-panel-padding);border-bottom:1px solid var(--a2ui-border);min-width:0}
.a2ui-card-spark{display:inline-flex;flex:none;width:14px;height:14px;color:var(--dsw-alias-brand-primary)}
.a2ui-card-spark svg{width:100%;height:100%}
.a2ui-card-title{font-size:var(--a2ui-body-size);font-weight:600;color:var(--a2ui-fg);letter-spacing:.005em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.a2ui-card-body{padding:var(--a2ui-panel-padding);min-width:0}
.a2ui-compact{display:flex;flex-direction:column;gap:var(--a2ui-space-sm);min-width:0;padding-block:var(--a2ui-space-xs)}
.a2ui-compact-head{display:flex;align-items:baseline;gap:var(--a2ui-space-sm);min-width:0}
.a2ui-compact-head .a2ui-card-title{font-size:var(--a2ui-heading-size);white-space:normal;overflow-wrap:anywhere}
.a2ui-compact-body{min-width:0}
.a2ui-section{display:flex;flex-direction:column;gap:var(--a2ui-space-sm);min-width:0}
.a2ui-section-head{display:grid;gap:var(--a2ui-space-xs);min-width:0}
.a2ui-section-title{margin:0;font-size:var(--a2ui-heading-size);font-weight:600;line-height:1.35;overflow-wrap:anywhere}
@container a2ui (max-width:480px){
  .a2ui-compact .a2ui-row,.a2ui-section .a2ui-row{flex-direction:column;align-items:stretch!important}
  .a2ui-compact .a2ui-row>*,.a2ui-section .a2ui-row>*{flex-basis:auto!important;min-width:0;max-width:100%}
}
.a2ui-surface{display:flex;flex-direction:column;gap:var(--a2ui-gap);min-width:0}
.a2ui-stack{display:flex;flex-direction:column;gap:var(--a2ui-gap);min-width:0}
.a2ui-row{display:flex;flex-direction:row;gap:var(--a2ui-gap);min-width:0;flex-wrap:wrap}
.a2ui-list{display:flex;gap:var(--a2ui-space-sm);min-width:0}
.a2ui-text{margin:0;min-width:0;overflow-wrap:anywhere}
.a2ui-text-caption{font-size:var(--a2ui-caption-size);color:var(--a2ui-muted)}
.a2ui-text code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-markdown-inline-code);border-radius:4px;padding:1px 4px}
.a2ui-text strong{font-weight:600}
.a2ui-card-inner{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:var(--a2ui-radius);padding:12px;min-width:0}
.a2ui-divider{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:2px 0;width:100%}
.a2ui-divider-v{border-left:1px solid var(--dsw-alias-border-l1);align-self:stretch;min-height:18px;width:0}
.a2ui-btn{appearance:none;font:inherit;font-size:13px;line-height:1.4;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:8px;padding:6px 13px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer;min-height:32px;max-width:100%;transition:background .14s ease,border-color .14s ease,color .14s ease}
.a2ui-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.a2ui-btn:disabled{opacity:.55;cursor:not-allowed}
.a2ui-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.a2ui-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.a2ui-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.a2ui-btn-borderless{border-color:transparent;background:transparent;color:var(--dsw-alias-brand-primary);padding-left:4px;padding-right:4px}
.a2ui-btn-borderless:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.a2ui-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.a2ui-label{font-size:12px;font-weight:500;color:var(--a2ui-muted)}
.a2ui-input,.a2ui-textarea,.a2ui-select{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;min-height:32px;width:100%;min-width:0}
.a2ui-textarea{min-height:74px;resize:vertical;line-height:1.5}
.a2ui-input:focus-visible,.a2ui-textarea:focus-visible,.a2ui-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.a2ui-input::placeholder,.a2ui-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
.a2ui-check{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;font-size:13px}
.a2ui-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);margin:0;flex:none;cursor:pointer}
.a2ui-choice{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.a2ui-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 11px;font-size:12.5px;cursor:pointer;min-height:28px}
.a2ui-chip[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in oklab, var(--dsw-alias-brand-primary) 16%, transparent);color:var(--dsw-alias-label-primary);font-weight:500}
.a2ui-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.a2ui-slider{display:flex;flex-direction:column;gap:4px;min-width:0}
.a2ui-slider-row{display:flex;align-items:center;gap:10px;min-width:0}
.a2ui-slider input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary);height:22px}
.a2ui-slider-value{font-variant-numeric:tabular-nums;font-size:12.5px;color:var(--dsw-alias-label-secondary);min-width:44px;text-align:right}
.a2ui-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px}
.a2ui-notice{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.a2ui-notice-error{border-color:color-mix(in oklab, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}
.a2ui-notice-title{font-weight:600;color:var(--dsw-alias-label-primary);font-size:12px}
.a2ui-notice-body{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;max-height:180px;overflow:auto}
.a2ui-tabs{display:flex;flex-direction:column;gap:8px;min-width:0}
.a2ui-tabbar{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:thin}
.a2ui-tab{appearance:none;font:inherit;font-size:12.5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 10px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.a2ui-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}
.a2ui-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.a2ui-modal-trigger{display:inline-flex}
.a2ui-modal-backdrop{position:fixed;inset:0;background:color-mix(in oklab, #000 42%, transparent);display:flex;align-items:center;justify-content:center;padding:24px;z-index:60}
.a2ui-modal{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;max-width:min(560px,100%);max-height:80vh;overflow:auto;padding:16px;box-shadow:0 16px 48px rgba(0,0,0,.28);min-width:0}
.a2ui-modal-close{display:flex;justify-content:flex-end;margin-bottom:6px}
.a2ui-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--a2ui-radius);min-width:0;max-width:100%}
.a2ui-table{border-collapse:collapse;width:100%;font-size:12.5px}
.a2ui-table th,.a2ui-table td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.a2ui-table th{font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);position:sticky;top:0;z-index:1;font-size:11.5px;padding:0}
.a2ui-th-sort{appearance:none;font:inherit;font-size:11.5px;font-weight:600;color:inherit;background:none;border:0;padding:6px 10px;width:100%;text-align:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.a2ui-th-sort:hover{color:var(--dsw-alias-label-primary)}
.a2ui-th-sort:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.a2ui-th-arrow{font-size:8px;opacity:.85}
.a2ui-table tbody tr:hover td{background:color-mix(in oklab, var(--dsw-alias-label-primary) 5%, transparent)}
.a2ui-table tbody tr:nth-child(even) td{background:color-mix(in oklab, var(--dsw-alias-label-primary) 3%, transparent)}
.a2ui-table tbody tr:nth-child(even):hover td{background:color-mix(in oklab, var(--dsw-alias-label-primary) 5%, transparent)}
.a2ui-table .a2ui-num{text-align:right;font-variant-numeric:tabular-nums}
.a2ui-caption{font-size:var(--a2ui-caption-size);color:var(--a2ui-muted);margin:0;overflow-wrap:anywhere}
.a2ui-chart{display:block;width:100%;overflow:visible}
.a2ui-chart-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}
.a2ui-chart-note{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}
.a2ui-chart-svg{width:100%;height:auto;display:block;overflow:visible}
.a2ui-bar-plot{position:relative;min-width:0}
.a2ui-plot,.a2ui-plot-frame{position:relative;min-width:0}
.a2ui-plot-frame:focus,#root .a2ui-root .a2ui-plot-frame:focus{outline:none;box-shadow:none}
.a2ui-plot-frame:focus-visible::after{content:"";position:absolute;inset:0;border:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,Highlight));border-radius:var(--a2ui-radius);pointer-events:none}
.a2ui-plot-frame circle[data-plot-point]{cursor:pointer}
.a2ui-plot-label{margin:0;font-size:var(--a2ui-caption-size);color:var(--a2ui-muted);overflow-wrap:anywhere}
.a2ui-plot-label-x{text-align:center}
.a2ui-plot-key{display:flex;flex-wrap:wrap;align-items:center;gap:var(--a2ui-space-xs) var(--a2ui-gap)}
.a2ui-plot-key>span{display:inline-flex;align-items:center;gap:var(--a2ui-space-xs);min-width:0;overflow-wrap:anywhere}
.a2ui-plot-size-swatch{display:inline-block;flex:none;box-sizing:border-box;border:1px solid currentColor;border-radius:50%;background:color-mix(in oklab,currentColor 26%,transparent)}
.a2ui-plot-fit-swatch{inline-size:1rem;flex:none;border-block-start:2px dashed currentColor}
.a2ui-pareto-line-swatch{inline-size:1rem;flex:none;border-block-start:2px solid currentColor}
.a2ui-pareto [tabindex] :is([data-pareto-bar],circle){cursor:pointer}
.a2ui-radar-grid{stroke:var(--a2ui-border);stroke-width:1}
.a2ui-radar-grid .a2ui-radar-spoke-active{stroke:var(--dsw-alias-brand-primary,Highlight);stroke-width:1.5}
.a2ui-radar-frame[tabindex] [data-radar-axis]{cursor:pointer}
.a2ui-radar-frame [data-radar-label] rect{fill:transparent}
.a2ui-radar-frame [data-radar-label] text{fill:var(--a2ui-fg);font-size:12px}
.a2ui-radar-frame .a2ui-radar-label-active rect{fill:color-mix(in oklab,var(--dsw-alias-brand-primary,Highlight) 17%,transparent)}
.a2ui-radar-scale{text-align:center;overflow-wrap:anywhere}
.a2ui-radar-axis-key{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,9.5rem),1fr));
  gap:var(--a2ui-space-xs) var(--a2ui-gap);font-size:var(--a2ui-caption-size);color:var(--a2ui-muted)}
.a2ui-radar-axis-key li{display:grid;grid-template-columns:1.2em minmax(0,1fr);gap:var(--a2ui-space-xs);align-items:baseline;overflow-wrap:anywhere}
.a2ui-radar-axis-number{font-weight:600;color:var(--a2ui-fg);font-variant-numeric:tabular-nums}
.a2ui-radar-legend .a2ui-legend-item{min-inline-size:0;max-inline-size:100%;text-align:start;overflow-wrap:anywhere}
.a2ui-radar-swatch{flex:none;inline-size:23px;block-size:8px}
.a2ui-radar-readout{display:grid;gap:var(--a2ui-space-xs);border-block-start:1px solid var(--a2ui-border);padding-block-start:var(--a2ui-space-xs);
  overflow-wrap:anywhere;white-space:pre-wrap}
.a2ui-visually-hidden{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.a2ui-heatmap{--a2ui-heat-base:var(--dsw-alias-bg-layer-3,Canvas);--a2ui-heat-high:var(--dsw-alias-brand-primary,#3972d0);--a2ui-heat-low:#bd5a25;
  --a2ui-heat-row-width:7rem;--a2ui-heat-cell-width:2.65rem;--a2ui-heat-gap:3px;--a2ui-heat-fade-width:14px;position:relative;margin:0;min-width:0}
.a2ui-heatmap-scroll{align-self:flex-start;max-inline-size:100%;max-block-size:25rem;overflow:auto;
  scroll-padding-inline-start:calc(var(--a2ui-heat-row-width) + 10px + var(--a2ui-heat-gap) + var(--a2ui-heat-fade-width));
  scroll-padding-block-start:calc(var(--a2ui-heat-header-size,2rem) + var(--a2ui-heat-gap) + var(--a2ui-heat-fade-width))}
.a2ui-heatmap-table{position:relative;border-collapse:separate;border-spacing:var(--a2ui-heat-gap);table-layout:fixed;inline-size:max-content;font-size:var(--a2ui-caption-size)}
.a2ui-heatmap-table th{padding:4px 5px;font-weight:500;line-height:1.25;color:var(--a2ui-fg);overflow-wrap:anywhere;background:color-mix(in oklab,var(--dsw-alias-bg-layer-2,Canvas) 88%,Canvas)}
.a2ui-heatmap-table thead th{position:sticky;inset-block-start:0;block-size:2rem;z-index:2;max-inline-size:6rem}
.a2ui-heatmap-table th[scope=row]{position:sticky;inset-inline-start:0;z-index:1;inline-size:var(--a2ui-heat-row-width);max-inline-size:var(--a2ui-heat-row-width);text-align:start}
.a2ui-heat-corner{position:sticky;inset-inline-start:0;inset-block-start:0;z-index:3}
.a2ui-heatmap-table[data-heat-scrolled] :is(th[scope=col],td[data-heat-cell]){
  --a2ui-heat-clip-x:calc(var(--a2ui-heat-scroll-x) - var(--a2ui-heat-gap) - var(--a2ui-heat-column-x));
  --a2ui-heat-clip-left:max(0px,var(--a2ui-heat-clip-x));
  --a2ui-heat-mask-x:linear-gradient(var(--a2ui-heat-fade-direction,to right),transparent var(--a2ui-heat-clip-x),#000 calc(var(--a2ui-heat-clip-x) + var(--a2ui-heat-fade-width)))}
.a2ui-heatmap-table[data-heat-scrolled][data-heat-rtl] :is(th[scope=col],td[data-heat-cell]){
  --a2ui-heat-fade-direction:to left;--a2ui-heat-clip-left:0px;--a2ui-heat-clip-right:max(0px,var(--a2ui-heat-clip-x))}
.a2ui-heatmap-table[data-heat-scrolled-y] tbody :is(th[scope=row],td[data-heat-cell]){
  --a2ui-heat-clip-y:calc(var(--a2ui-heat-scroll-y) - var(--a2ui-heat-gap) - var(--a2ui-heat-row-y));
  --a2ui-heat-clip-top:max(0px,var(--a2ui-heat-clip-y));
  --a2ui-heat-mask-y:linear-gradient(to bottom,transparent var(--a2ui-heat-clip-y),#000 calc(var(--a2ui-heat-clip-y) + var(--a2ui-heat-fade-width)))}
.a2ui-heatmap-table[data-heat-scrolled] :is(th[scope=col],td[data-heat-cell]),
.a2ui-heatmap-table[data-heat-scrolled-y] tbody :is(th[scope=row],td[data-heat-cell]){
  clip-path:inset(var(--a2ui-heat-clip-top,0px) var(--a2ui-heat-clip-right,0px) 0 var(--a2ui-heat-clip-left,0px));
  mask-image:var(--a2ui-heat-mask-x,linear-gradient(#000,#000)),var(--a2ui-heat-mask-y,linear-gradient(#000,#000));mask-composite:intersect}
.a2ui-heatmap-table td[data-heat-cell]{min-inline-size:var(--a2ui-heat-cell-width);block-size:2rem;border:1px solid var(--a2ui-border);border-radius:4px;text-align:center;color:var(--a2ui-muted)}
.a2ui-heatmap-table td[tabindex]{cursor:pointer}
.a2ui-heatmap-table td[tabindex]:hover{box-shadow:inset 0 0 0 1px var(--a2ui-fg)}
.a2ui-heatmap-table td:focus-visible,#root .a2ui-heatmap-table td:focus-visible{outline:2px solid var(--a2ui-fg,Highlight);outline-offset:-2px}
.a2ui-heat-missing{background:repeating-linear-gradient(135deg,var(--a2ui-heat-base) 0 3px,var(--a2ui-border) 3px 4px)}
.a2ui-heatmap>.a2ui-bar-tip{z-index:3}
.a2ui-heat-legend,.a2ui-heat-key,.a2ui-heat-ticks{display:flex;align-items:center;gap:var(--a2ui-space-sm)}
.a2ui-heat-legend{flex-wrap:wrap;gap:var(--a2ui-space-xs) var(--a2ui-panel-padding)}
.a2ui-heat-scale{flex:1;min-inline-size:min(100%,10rem);max-inline-size:19rem}
.a2ui-heat-ramp{block-size:8px;border-radius:4px;border:1px solid var(--a2ui-border)}
.a2ui-heat-ticks{justify-content:space-between;font-variant-numeric:tabular-nums}
.a2ui-heat-chip{inline-size:12px;block-size:12px;border-radius:3px;flex:none;border:1px solid var(--a2ui-border)}
.a2ui-timeline{display:grid;gap:var(--a2ui-space-sm);min-width:0}
.a2ui-timeline-list{list-style:none;margin:0;padding:0;display:grid;gap:var(--a2ui-gap)}
.a2ui-timeline-item{display:grid;grid-template-columns:minmax(5rem,9rem) .8rem minmax(0,1fr);column-gap:var(--a2ui-space-sm);min-width:0}
.a2ui-timeline-when{font-size:var(--a2ui-caption-size);font-weight:500;color:var(--a2ui-muted);overflow-wrap:anywhere}
.a2ui-timeline-track{position:relative;display:flex;justify-content:center;align-items:flex-start}
.a2ui-timeline-track::before{content:"";position:absolute;inset-block:.55em calc(-1 * var(--a2ui-gap));inline-size:1px;background:var(--a2ui-border)}
.a2ui-timeline-item:last-child .a2ui-timeline-track::before{content:none}
.a2ui-timeline-dot{position:relative;margin-block-start:.36em;inline-size:8px;block-size:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,currentColor)}
.a2ui-timeline-content{min-width:0;overflow-wrap:anywhere}
.a2ui-timeline-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:var(--a2ui-space-xs) var(--a2ui-space-sm)}
.a2ui-timeline-title{font-size:var(--a2ui-body-size);font-weight:600;color:var(--a2ui-fg)}
.a2ui-timeline-description{margin:var(--a2ui-space-xs) 0 0;color:var(--a2ui-muted);white-space:pre-wrap}
.a2ui-timeline-status{font-size:var(--a2ui-caption-size);color:var(--a2ui-muted)}
.a2ui-timeline-done{color:var(--dsw-alias-state-success-primary,var(--a2ui-muted))}
.a2ui-timeline-current{color:var(--dsw-alias-brand-primary,var(--a2ui-muted))}
.a2ui-timeline-blocked{color:var(--dsw-alias-state-error-primary,var(--a2ui-muted))}
@container a2ui (max-width:480px){
  .a2ui-heatmap{--a2ui-heat-row-width:5.5rem;--a2ui-heat-cell-width:2.25rem}
  .a2ui-timeline-item{grid-template-columns:.8rem minmax(0,1fr);grid-template-rows:auto auto;row-gap:var(--a2ui-space-xs)}
  .a2ui-timeline-track{grid-column:1;grid-row:1 / span 2}
  .a2ui-timeline-when{grid-column:2;grid-row:1}
  .a2ui-timeline-content{grid-column:2;grid-row:2}
}
.a2ui-bar-tip{position:absolute;left:0;top:0;z-index:1;visibility:hidden;pointer-events:none;width:max-content;max-width:min(280px,calc(100% - 8px));max-height:calc(100% - 8px);overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4}
.a2ui-axis text{fill:var(--dsw-alias-label-secondary);font-size:10px}
.a2ui-grid line{stroke:var(--dsw-alias-border-l1);stroke-width:1}
.a2ui-legend{display:flex;flex-wrap:wrap;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.a2ui-legend-more{align-self:center;padding:0 2px;opacity:.7}
.a2ui-legend-item{appearance:none;font:inherit;font-size:11.5px;color:inherit;background:none;border:0;border-radius:6px;padding:2px 6px;display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.a2ui-legend-item:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.a2ui-legend-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.a2ui-legend-off{opacity:.45;text-decoration:line-through}
.a2ui-legend-swatch{width:8px;height:8px;border-radius:2px;flex:none}
.a2ui-stat{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:var(--a2ui-radius);padding:11px 13px;min-width:0}
.a2ui-stat-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:500}
.a2ui-stat-value{font-size:22px;font-weight:600;line-height:1.2;letter-spacing:-.01em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.a2ui-stat-unit{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary);margin-left:3px}
.a2ui-stat-delta{font-size:11.5px;font-weight:600}
.a2ui-delta-up{color:var(--dsw-alias-state-success-primary)}
.a2ui-delta-down{color:var(--dsw-alias-state-error-primary)}
.a2ui-delta-flat{color:var(--dsw-alias-label-secondary)}
.a2ui-progress{display:flex;flex-direction:column;gap:5px;min-width:0}
.a2ui-progress-track{height:7px;border-radius:999px;background:var(--dsw-alias-fill-l2);overflow:hidden}
.a2ui-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.a2ui-progress-fill.a2ui-tone-success{background:var(--dsw-alias-state-success-primary)}
.a2ui-progress-fill.a2ui-tone-warning{background:var(--dsw-alias-state-warn-primary)}
.a2ui-progress-fill.a2ui-tone-danger{background:var(--dsw-alias-state-error-primary)}
.a2ui-progress-head{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.a2ui-player{display:flex;flex-direction:column;gap:8px;min-width:0}
.a2ui-player-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.a2ui-player-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-left:auto;font-variant-numeric:tabular-nums}
.a2ui-bars{display:flex;align-items:flex-end;justify-content:safe center;gap:6px;height:120px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 2px 0}
.a2ui-bar{flex:1;min-width:6px;max-width:64px;border-radius:4px 4px 0 0;background:var(--a2ui-c1);background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--a2ui-c1)) 64%,transparent);transition:height .16s ease,background .16s ease;position:relative}
.a2ui-bar.a2ui-state-active{background:var(--dsw-alias-brand-primary)}
.a2ui-bar.a2ui-state-compare{background:var(--dsw-alias-state-warn-primary)}
.a2ui-bar.a2ui-state-sorted,.a2ui-bar.a2ui-state-done{background:var(--dsw-alias-state-success-primary)}
.a2ui-bar-value{position:absolute;top:-15px;left:0;right:0;text-align:center;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.a2ui-frame-list{display:flex;flex-wrap:wrap;gap:5px}
.a2ui-cell{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 8px;font-size:12px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-1)}
.a2ui-cell.a2ui-state-active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
.a2ui-cell.a2ui-state-compare{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
.a2ui-cell.a2ui-state-sorted,.a2ui-cell.a2ui-state-done{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-inverted);border-color:transparent}
.a2ui-image{max-width:100%;height:auto;border-radius:8px;display:block}
.a2ui-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none}
.a2ui-icon svg{width:100%;height:100%}
.a2ui-fallback{font-size:11.5px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;display:inline-block}
.a2ui-pointer{display:flex;align-items:center;gap:8px;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:7px 11px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.a2ui-pointer-icon{display:inline-flex;flex:none;width:13px;height:13px;color:var(--dsw-alias-brand-primary)}
.a2ui-pointer-icon svg{width:100%;height:100%}
.a2ui-pointer-text{color:var(--dsw-alias-label-primary);font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a2ui-pointer-meta{margin-left:auto;flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.a2ui-failure>summary{cursor:pointer;list-style:none}
.a2ui-failure>summary::before{content:'▸';flex:none}
.a2ui-failure[open]>summary::before{content:'▾'}
.a2ui-failure-details{margin:4px 0 0;padding:8px 11px}
.a2ui-tail{display:flex;flex-direction:column;gap:10px;min-width:0;margin:6px 0 2px}
.a2ui-card-streaming{border-style:dashed}
.a2ui-card-state{margin-left:auto;flex:none;font-size:11px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);opacity:.85}
.a2ui-card-streaming :is(.a2ui-card-body,.a2ui-compact-body){pointer-events:none}
.a2ui-skel{display:flex;flex-direction:column;gap:8px;min-width:0}
.a2ui-skel-line,.a2ui-skel-block{display:block;border-radius:6px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-3) 0%,var(--dsw-alias-interactive-bg-hover-solid) 45%,var(--dsw-alias-bg-layer-3) 90%);background-size:220% 100%;animation:a2ui-shimmer 1.25s ease-in-out infinite}
.a2ui-skel-line{height:9px}
.a2ui-skel-block{height:52px;border-radius:8px;animation-delay:.12s}
.a2ui-skel-w70{width:70%}
.a2ui-skel-w92{width:92%}
.a2ui-skel-w60{width:60%}
.a2ui-skel-inline{width:96px;height:10px;vertical-align:middle}
@keyframes a2ui-shimmer{0%{background-position:120% 0}100%{background-position:-40% 0}}
/* A tab opened before its snapshot arrived: a quiet placeholder, reusing the
   shimmer the card preview already animates. */
.a2ui-skeleton{display:flex;flex-direction:column;gap:10px;padding:4px 0}
.a2ui-skeleton-line{height:12px;border-radius:6px;background:linear-gradient(90deg,currentColor 0%,transparent 50%,currentColor 100%);background-size:220% 100%;opacity:.12;animation:a2ui-shimmer 1.4s linear infinite}
.a2ui-skeleton-title{height:18px;width:58%}
.a2ui-skeleton-short{width:34%}
.a2ui-skeleton-label{font-size:12px;opacity:.6}
.a2ui-hidden{display:none !important}
@media (prefers-reduced-motion: reduce){.a2ui-root *{transition:none !important;animation:none !important}}
`

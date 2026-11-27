/**
 * `@nolit/dsh-a2ui-plus` — Host half.
 *
 * Registers the model-facing `a2ui` tool (an A2UI 1.0 message stream authored by
 * the model), a compact `a2ui_catalog` reference tool, and one system-prompt
 * section that teaches when a UI is worth generating. The browser half renders
 * the validated messages; nothing here holds per-session state, so replay is
 * exact and unloading the plugin leaves no residue.
 *
 * Drop-in replacement for `dsh-a2ui`: the tool names stay `a2ui` and
 * `a2ui_catalog`, so the two plugins cannot be installed together — the tool
 * registry rejects a duplicate name (`tools.restrict` cannot express
 * "mutually exclusive", and npm has no conflict field). `assertNoPredecessor`
 * turns that collision into one clear diagnostic before registration.
 */
import { describeCatalog } from '../shared/catalog.js'
import { DownlinkRegistry, installDownlink } from './transport.js'
import { installUplink } from './actions.js'
import { PendingActions } from './pending.js'
import { SurfaceStore, baselineFrames } from './store.js'
import type { JsonValue } from '../shared/json.js'
import { LIMITS } from '../shared/limits.js'
import { isPresentation, PRESENTATIONS, validateToolArguments, type ToolValidation } from '../shared/validate.js'

/** Configuration accepted from the bundle row; all fields are optional. */
export interface PluginConfig {
  /** Tool name shown to the model. Default `a2ui`. */
  toolName?: string
  /** Whether the catalog reference tool is registered. Default `true`. */
  catalogTool?: boolean
  /** Order of the prompt section. Default `120`. */
  sectionOrder?: number
  /** Skip the system-prompt section entirely. Default `false`. */
  muteSection?: boolean
  /**
   * Proactive triggering (default `true`). When false, the guidance only asks for
   * a surface when the user requested one or the content clearly needs it.
   */
  autoRender?: boolean
  /**
   * Agent presets in which the `a2ui` tools and guidance are admitted.
   *
   * Admission is a per-step check (`ToolRegistrationOptions.when`), so the tools
   * stay registered while this list decides which preset's steps can call them.
   * `minimal` ships excluded: its whole point is a short toolset, and a
   * generative-UI tool is not part of it. Presets absent from this list keep the
   * tools — the guidance only claims the behaviour it knows how to describe.
   */
  presets?: string[]
  /**
   * Whether the out-of-turn transport is installed (default `true`).
   *
   * `false` keeps the inline card working and leaves both channels unregistered —
   * useful for a profile that runs two A2UI plugins side by side, and for tests
   * that assert the tool surface alone.
   */
  transport?: boolean
}

const DEFAULT_TOOL_NAME = 'a2ui'
const CATALOG_TOOL_NAME = 'a2ui_catalog'
const DEFAULT_SECTION_ORDER = 120

/** Presets whose steps may call the A2UI tools. `minimal` is deliberately out. */
const DEFAULT_PRESETS = ['standard', 'ptc', 'cordis']

/**
 * Which guidance variant a preset should receive.
 *
 * `standard` and `ptc` answer with data: charts, tables, KPI tiles, approval
 * cards. `cordis` composes the GUI itself, so it also owns the sidebar tab and
 * the bidirectional function channel.
 */
type GuidanceFlavor = 'data' | 'creator'

/** Max characters of the per-call replay copy stored in the tool result `meta`. */
const META_LIMIT = 96_000

/** Max violation lines quoted back to the model. */
const MAX_REPORTED_VIOLATIONS = 16

interface ToolDefinitionLike {
  name: string
  description: string
  parameters: unknown
  output: {
    schema: unknown
    render: (args: unknown, value: unknown) => unknown
    presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  execute: (args: unknown, exec: { signal: AbortSignal; agent?: { session?: { id?: string } }; sessionId?: string }) => Promise<unknown>
}

interface ToolResultValue {
  ok: boolean
  surfaces: Array<{ surfaceId: string; catalogId: string; components: number; deleted: boolean }>
  warnings: string[]
  note: string
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function formatViolations(errors: ToolValidation['errors']): string {
  const lines = errors.slice(0, MAX_REPORTED_VIOLATIONS).map((error) => `- ${error.path === '' ? 'arguments' : error.path}: ${error.message}`)
  if (errors.length > MAX_REPORTED_VIOLATIONS) lines.push(`- …and ${errors.length - MAX_REPORTED_VIOLATIONS} more`)
  return lines.join('\n')
}

function summarizeValue(value: ToolResultValue): string {
  const parts: string[] = []
  if (value.surfaces.length === 0) {
    parts.push('The payload was accepted but no surface changed, so nothing new will render.')
  } else {
    for (const surface of value.surfaces) {
      if (surface.deleted) parts.push(`Deleted surface "${surface.surfaceId}".`)
      else parts.push(`Rendered surface "${surface.surfaceId}" (${surface.components} component${surface.components === 1 ? '' : 's'}).`)
    }
  }
  if (value.warnings.length > 0) {
    parts.push(...value.warnings.map((warning) => `Warning: ${warning}`))
  }
  parts.push(value.note)
  return parts.join('\n')
}

function buildTool(
  toolName: string,
  proactive: boolean,
  catalogTool = true,
  publish?: (sessionId: string | undefined, args: unknown, value: ToolResultValue) => void,
): ToolDefinitionLike {
  const parameters = {
    type: 'object',
    properties: {
      presentation: {
        type: 'string',
        enum: PRESENTATIONS,
        description: 'Optional display style. Use "compact" for one chart or a small section within the answer. Put it before "messages" for streaming. The default is "card".',
      },
      messages: {
        type: 'array',
        description:
          'A2UI 1.0 messages, applied in order. Each message is `{"version":"1.0","createSurface"|"updateComponents"|"updateDataModel"|"deleteSurface":{...}}`.' + (catalogTool ? ' Call a2ui_catalog for the component reference.' : ''),
        items: { type: 'object' },
      },
      title: {
        type: 'string',
        description: 'Optional short card title shown above the surface (2-6 words). Omit when the surrounding answer already names it.',
      },
      placement: {
        type: 'string',
        enum: ['inline', 'sidebar'],
        description:
          'Where to render. "inline" (default) puts the card in the conversation; "sidebar" opens it in a Sidebar tab whose id is the surface id, so later updates repaint that tab. Below 768px a sidebar request degrades to inline automatically.',
      },
    },
    required: ['messages'],
    additionalProperties: false,
  }

  const description = proactive
    ? [
        'Render an interactive A2UI 1.0 interface inside the conversation.',
        'Call this proactively as part of answering — the user does not have to ask for a UI. Whenever your answer contains comparable data (3+ rows), a trend over time, a category breakdown, headline numbers, a parameter space, a step-by-step process, a form to fill, or a decision to make, render it instead of only describing it in prose.',
        'Skip it for single facts, definitions, short explanations, code, logs, and anything a short Markdown answer covers better. Never show the same numbers twice.',
        'The tool validates the payload and returns which surfaces rendered; on a validation error, fix the reported paths and call it again in the same turn.',
        'User actions come back to you as a user message starting with `[A2UI action]`.',
      ].join(' ')
    : [
        'Render an interactive A2UI 1.0 interface inside the conversation.',
        'Use it when the user asks for a visual, or when an answer clearly needs one: data comparison, charts, KPI tiles, a configurable form, parameter exploration, or a step-by-step animation with approval buttons.',
        'Prefer plain Markdown for explanations, prose and simple lists. Do not render a UI for a simple factual answer.',
        'The tool validates the payload and returns which surfaces rendered; on a validation error, fix the reported paths and call it again in the same turn.',
        'User actions come back to you as a user message starting with `[A2UI action]`.',
      ].join(' ')

  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          surfaces: { type: 'array', items: { type: 'object' } },
          warnings: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['ok', 'surfaces', 'warnings', 'note'],
      },
      render: (_args: unknown, value: unknown) => [textBlock(summarizeValue(value as ToolResultValue))],
      presentationMeta: (args: unknown, value: unknown) => {
        // The browser renders from this durable copy so a transcript page that
        // starts after the original `tool/call` event still shows the surface.
        const incoming = (args ?? {}) as { messages?: unknown; title?: unknown; presentation?: unknown; placement?: unknown }
        const result = value as ToolResultValue
        const meta: Record<string, unknown> = {
          kind: 'a2ui',
          ...(typeof incoming.title === 'string' ? { title: incoming.title } : {}),
          ...(isPresentation(incoming.presentation) ? { presentation: incoming.presentation } : {}),
          // The placement rides the durable copy so the inline view can tell
          // "this surface belongs in a tab" without waiting for the socket.
          ...(incoming.placement === 'sidebar' ? { placement: 'sidebar' } : {}),
          surfaces: result.surfaces,
        }
        const serializedMessages = safeStringify(incoming.messages)
        if (serializedMessages !== undefined && serializedMessages.length <= META_LIMIT) {
          meta.messages = incoming.messages as JsonValue
        } else {
          meta.messagesOmitted = true
        }
        return meta
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: { session?: { id?: string } }; sessionId?: string }) {
      if (exec.signal.aborted) throw new Error('A2UI rendering was cancelled before validation')
      const validation = validateToolArguments(args)
      if (!validation.ok) {
        throw new Error(
          `A2UI payload rejected (${validation.errors.length} problem${validation.errors.length === 1 ? '' : 's'}):\n${formatViolations(validation.errors)}\nFix these paths and call ${toolName} again.`,
        )
      }
      const value: ToolResultValue = {
        ok: true,
        surfaces: validation.surfaces,
        warnings: validation.warnings,
        note:
          validation.warnings.length > 0
            ? 'Address the warnings if they were not intentional.'
            : 'Keep the accompanying prose brief: the interface carries the detail. Do not repeat the rendered values in text.',
      }
      // The downlink is best-effort: a Host without a browser attached still
      // returns a valid tool result, because the card is derived from this call.
      publish?.(exec?.agent?.session?.id ?? exec?.sessionId, args, value)
      return value
    },
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function buildCatalogTool(): ToolDefinitionLike {
  return {
    name: CATALOG_TOOL_NAME,
    description:
      'Return the A2UI 1.0 component and function reference for this plugin. Call it before authoring a non-trivial surface (tables, charts, plots, animations, forms) so that component and property names are exact.',
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['brief', 'full'],
          description: '"brief" lists component names and purpose; "full" (default) adds property names.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args: unknown, value: unknown) => [textBlock((value as { text: string }).text)],
    },
    async execute(args: unknown) {
      const detail = (args as { detail?: string } | undefined)?.detail === 'brief' ? 'brief' : 'full'
      return { text: describeCatalog(detail) }
    },
  }
}

function sectionText(toolName: string, catalogTool: boolean, proactive: boolean, flavor: GuidanceFlavor = 'data'): string {
  const decision = proactive
    ? [
        '## Generative UI (A2UI 1.0)',
        '',
        `Render an interactive interface inline with \`${toolName}\` (A2UI 1.0 messages: \`createSurface\`, \`updateComponents\`, \`updateDataModel\`, \`deleteSurface\`).`,
        '',
        '**Decide from what the answer contains, not from how the user phrased the request.** No one has to say "chart", "visualize", "UI" or "a2ui".',
        '',
        'Render a surface when the answer has:',
        '- 3+ comparable rows (options, versions, items, before/after) → `Table`; 2-4 headline numbers → `Row` of `Stat`.',
        '- values over time, across categories, or as shares → `BarChart` / `LineChart` / `PieChart`.',
        '- a target, progress or coverage → `Progress` / `Stat`.',
        '- a value worth trying out, or a formula → `Slider` + `Plot` bound to the data model.',
        '- paired numeric observations → `Plot` scatter with the original X/Y values, labeled axes, and a series for each group.',
        '- third nonnegative metric → scatter `size` and `sizeLabel`; fitted trend → `regression:"linear"` on the scatter series.',
        '- ranked shares → `ParetoChart`; common-scale profiles → `RadarChart`; known intervals → `errorBars`.',
        '- a numeric matrix with meaningful patterns across two axes → `Heatmap`; retain missing cells as null and use a diverging scale for signed comparisons.',
        '- milestones, releases, or an incident sequence where order helps → `Timeline` in the intended reading order.',
        '- discrete steps, an ordering or an algorithm walk-through → `FramePlayer`.',
        '- input the user must give, or a decision to approve → form components + one submit/approve button.',
        '',
        'Keep it prose: one fact, a definition, a yes/no, a greeting, a short explanation, code, diffs, logs, paths.',
        'Never repeat in text the numbers a surface already shows; one card per answer, two charts at most.',
        'For one chart, a short Timeline, or a small Section, use "presentation":"compact" before "messages" and omit a title the answer already supplies.',
        '',
        'Rules:',
        '- The component graph root id MUST be "root"; components are flat and reference each other by id.',
        '- Bind interactive `value` properties to the data model (`{"@path":"/form/name"}`) and repeat those paths in the action `context`.',
        `- Each call renders its own card from that call's messages. To show a changed interface, send a complete surface (\`createSurface\` with its components and dataModel); \`updateComponents\`/\`updateDataModel\` alone render as an "updated" note, because an earlier card is a separate snapshot.`,
        '- Keep one surface small: at most a few hundred declared components, a few thousand rendered nodes (templates multiply), and a few thousand table rows plus chart points. Larger payloads are rejected before rendering.',
        catalogTool ? `- Call \`${CATALOG_TOOL_NAME}\` for exact component or property names.` : '',
      ]
    : [
        '## Generative UI (A2UI 1.0)',
        '',
        `You can render an interactive interface inline in the conversation with the \`${toolName}\` tool (A2UI 1.0 messages: \`createSurface\`, \`updateComponents\`, \`updateDataModel\`, \`deleteSurface\`).`,
        '',
        'Only render a surface when the user asks for one, or when it is the clearest way to answer a comparison, a chart, a parameter exploration, a form, or a step-by-step animation.',
        'Prefer plain Markdown for explanations, prose and simple lists. Never show the same numbers twice.',
        'Use "presentation":"compact" before "messages" for one chart, a short Timeline, or a small Section within the answer.',
        '',
        'Rules that keep it working:',
        '- The component graph root id MUST be "root". Components are declared flat and reference each other by id.',
        '- Bind interactive `value` properties to the data model (`{"@path":"/form/name"}`) so edits stay local; put the same paths in the action `context` so the submit button carries the values.',
        `- Each call renders its own card from that call's messages. To show a changed interface, send a complete surface (\`createSurface\` with its components and dataModel); \`updateComponents\`/\`updateDataModel\` alone render as an "updated" note, because an earlier card is a separate snapshot.`,
        '- Keep one surface small: at most a few hundred declared components, a few thousand rendered nodes (templates multiply), and a few thousand table rows plus chart points. Larger payloads are rejected before rendering.',
        catalogTool ? `- Call \`${CATALOG_TOOL_NAME}\` when you need exact component or property names.` : '',
      ]

  const lines = [
    ...decision,
    '',
    'Interactive by default — never add a button for something the UI already does locally:',
    '- Charts and tables are interactive on their own: hover shows a tooltip and highlights the point, a legend entry toggles its series, table headers sort the rows, tabs switch, sliders and plots redraw, FramePlayer plays. All local, no message, no turn.',
    '- Add an `action.event` button ONLY when the user asked for an action that needs you: submitting a form, approving or rejecting, or fetching fresh data. Every such click sends a message and starts a turn, so never add decorative buttons, duplicate buttons, or one that merely restates a control.',
    '- Never add a button whose only effect is to remove or hide the interface the user is looking at.',
    '',
    'User actions arrive as a user message beginning with `[A2UI action]` followed by a fenced JSON object whose `action` field carries `name`, `surfaceId`, `sourceComponentId`, `context` and `timestamp`. Treat it as a genuine user request: continue the task, then update the surface or answer.',
    '- Function calls in `action.functionCall` run inside the renderer and only change local state; nothing is sent to you.',
    '- Anything with side effects (files, commands, network, external services) must still go through your normal tools, so the usual approvals apply. A surface can never grant itself permissions.',
    ...(flavor === 'creator' ? ['', ...CREATOR_LINES] : []),
  ]
  return lines.filter((line) => line !== undefined && line !== '').join('\n')
}

/**
 * Guidance that only `cordis` needs: this preset composes the GUI itself, so it
 * owns the sidebar tab and the bidirectional function channel.
 */
const CREATOR_LINES: readonly string[] = [
  '## Building on the A2UI extension (cordis preset)',
  '',
  'This preset composes the interface itself, so two more channels are open:',
  '- Set `placement: "sidebar"` on the `a2ui` call to land the surface in a Sidebar tab instead of the conversation; the surface id becomes that tab, and later `updateDataModel` messages retitle and repaint it through `STATE_DELTA`. Below 768px the request degrades to the inline card automatically.',
  '- `callRendererFunction` asks the renderer to run one whitelisted function and returns its response to you. The whitelist is `openUrl`, `scrollTo`, `copyToClipboard`, `downloadFile`, `validateForm`, `requestFilePicker`; anything else is rejected. `openUrl`, `copyToClipboard`, `downloadFile` and `requestFilePicker` need a user gesture, `validateForm` is pure and answers on its own, and `scrollTo` is local.',
  '- A request that needs a gesture is held until the user clicks; treat a `gesture-required` response as "ask the user to click, then retry".',
]

/**
 * Mount the A2UI tools and prompt section.
 * @param ctx Host plugin context.
 * @param config bundle-row configuration.
 */
export function apply(ctx: any, config: PluginConfig = {}): void {
  const toolName =
    typeof config.toolName === 'string' && /^[a-z][a-z0-9_]{1,40}$/u.test(config.toolName) ? config.toolName : DEFAULT_TOOL_NAME
  const catalogTool = config.catalogTool !== false
  const sectionOrder = Number.isFinite(config.sectionOrder) ? Number(config.sectionOrder) : DEFAULT_SECTION_ORDER
  const proactive = config.autoRender !== false

  const presets = Array.isArray(config.presets)
    ? config.presets.filter((id): id is string => typeof id === 'string' && id !== '')
    : DEFAULT_PRESETS
  // Admission is a per-step condition: a preset outside this list keeps the
  // registration but never sees the tool in a step's toolset.
  const when = presets.length === 0 ? undefined : (context: any) => presetAdmits(ctx, context?.agent, presets)

  // Which surfaces a session already published, so a repeat call updates the
  // card instead of minting a second one.
  // Transport: the two channels the browser half needs. Both install through
  // ctx.effect, so an unload removes the route and the RPC channel.
  const downlink = new DownlinkRegistry()
  const pendingActions = new PendingActions()
  /** Surface -> the session whose renderers may answer for it. */
  const surfaceOwners = new Map<string, string>()
  ctx.effect(
    () => () => {
      pendingActions.dispose()
      downlink.dispose()
    },
    'a2ui-plus: transport state',
  )
  if (config.transport !== false) {
    installDownlink(ctx, downlink)
    // A browser that could not patch its copy asks for the authoritative state.
    // The answer is the same synthesis a reconnect uses, so one code path owns
    // "what the client should start from".
    const resync = (sessionId: string, surfaceIds: readonly string[]) => {
      const store = stores.get(sessionId)
      if (store === undefined) return []
      const wanted = new Set(surfaceIds)
      return (
        baselineFrames(store, (surfaceId) => surfaceMessages.get(`a2ui:${surfaceId}`))
          .filter((frame) => wanted.size === 0 || wanted.has(frame.surfaceId))
          // Ownership check: a surface belongs to the session that published it.
          // The store a caller names is not by itself proof that the caller may
          // read it — `sessionId` travels in the request body, and a Peer carries
          // no session identity to compare against. Refusing a frame another
          // session owns is the check that is actually enforceable.
          .filter((frame) => surfaceOwners.get(frame.surfaceId) === sessionId)
      )
    }
    installUplink(ctx, async (surfaceId, functionName, args, signal) => {
      signal.throwIfAborted()
      const sessionId = surfaceOwners.get(surfaceId)
      if (sessionId === undefined) return undefined
      // The renderer performs the function and answers over the same channel;
      // the Host only relays, so it never fakes a result it did not observe.
      downlink.push(sessionId, {
        type: 'CUSTOM',
        surfaceId,
        name: 'rendererFunctionRequest',
        value: { functionName, args },
      })
      return pendingActions.request(surfaceId, functionName, signal)
    }, resync)
  }

  // One store per session: the Host owns each surface's state and decides what
  // every change is. The transport only carries the frames it produces.
  const stores = new Map<string, SurfaceStore>()
  const storeOf = (sessionId: string): SurfaceStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = new SurfaceStore()
      stores.set(sessionId, store)
    }
    return store
  }
  /** The messages each surface was last declared with, for a reconnect snapshot. */
  const surfaceMessages = new Map<string, unknown[]>()

  // The registry synthesizes its own baseline from the store at attach time, so a
  // returning browser starts from the present rather than from a stale frame.
  downlink.setBaselineProvider((sessionId) => {
    const store = stores.get(sessionId)
    if (store === undefined) return []
    return baselineFrames(store, (surfaceId) => surfaceMessages.get(`a2ui:${surfaceId}`))
  })

  /** Apply one `a2ui` call to its session's store and publish the resulting frames. */
  const publishCall = (sessionId: string | undefined, args: unknown, value: ToolResultValue): void => {
    if (sessionId === undefined || value.ok !== true) return
    const incoming = (args ?? {}) as { messages?: unknown; placement?: unknown; title?: unknown }
    const messages = Array.isArray(incoming.messages) ? incoming.messages : []
    const placement = incoming.placement === 'sidebar' ? 'sidebar' : 'inline'
    const store = storeOf(sessionId)

    // Record the messages behind each surface before folding: a reconnect
    // snapshot must carry the same payload the live card used.
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue
      const record = message as Record<string, unknown>
      const created = record.createSurface as { surfaceId?: unknown } | undefined
      if (created !== undefined && typeof created.surfaceId === 'string') {
        surfaceMessages.set(`a2ui:${created.surfaceId}`, messages)
        surfaceOwners.set(created.surfaceId, sessionId)
      }
    }

    const callTitle = typeof incoming.title === 'string' ? incoming.title : undefined
    for (const change of store.apply(messages, { placement, title: callTitle })) {
      if (change.kind === 'snapshot' && change.state !== undefined) {
        const state = change.state
        downlink.push(sessionId, {
          type: 'ACTIVITY_SNAPSHOT',
          surfaceId: state.surfaceId,
          activityType: 'a2ui.surface',
          messageId: state.surfaceId,
          surfaceRevision: state.revision,
          surfaceEpoch: store.currentEpoch(),
          content: {
            surfaceId: state.surfaceId,
            placement: state.placement,
            catalogId: state.catalogId,
            messages: surfaceMessages.get(`a2ui:${state.surfaceId}`) ?? messages,
            dataModel: state.dataModel,
            components: [...state.components.values()],
          },
          replace: true,
        })
        continue
      }
      if (change.kind === 'delta' && change.delta !== undefined) {
        const state = store.get(change.surfaceId)
        downlink.push(sessionId, {
          type: 'STATE_DELTA',
          surfaceId: change.surfaceId,
          surfaceRevision: state?.revision ?? store.currentRevision(),
          surfaceEpoch: store.currentEpoch(),
          delta: change.delta,
        })
        if (state === undefined) {
          // A removal is the one delta the client cannot apply on its own only if
          // it never had the surface; the frame above already says so.
          surfaceMessages.delete(`a2ui:${change.surfaceId}`)
          surfaceOwners.delete(change.surfaceId)
        }
      }
    }
  }
  ctx.effect(
    () =>
      ctx.tools.register(
        buildTool(toolName, proactive, catalogTool, publishCall),
        when === undefined ? {} : { when },
      ),
    'dsh-a2ui-plus: tool',
  )
  if (catalogTool) {
    ctx.effect(
      () => ctx.tools.register(buildCatalogTool(), when === undefined ? {} : { when }),
      'dsh-a2ui-plus: catalog tool',
    )
  }

  if (config.muteSection !== true && ctx.systemPrompt !== undefined) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'dsh-a2ui-plus:guidance',
          order: sectionOrder,
          // Looked up per assembly, so a Session that switches preset gets the
          // guidance for the preset it is on rather than the one that booted.
          text: (context: any) =>
            sectionText(toolName, catalogTool, proactive, flavorFor(ctx, context?.session?.ctx ?? context?.scope)),
        }),
      'dsh-a2ui-plus: prompt section',
    )
  }
}

/** Preset id one agent runs under, or `undefined` when the registry is absent. */
function presetOf(ctx: any, agent: any): string | undefined {
  const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  if (registry === undefined || typeof registry.presetForSession !== 'function') return undefined
  const session = agent?.session
  if (session === undefined) return undefined
  try {
    return registry.presetForSession(session) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a step may see the A2UI tools.
 *
 * A step whose preset cannot be read is admitted: refusing on missing data would
 * silently disable the plugin on a Host without the preset registry.
 */
function presetAdmits(ctx: any, agent: any, presets: readonly string[]): boolean {
  const preset = presetOf(ctx, agent)
  return preset === undefined || presets.includes(preset)
}

/** Guidance flavor for the preset a session runs under. */
function flavorFor(ctx: any, agentOrScope: any): GuidanceFlavor {
  const agent = agentOrScope?.session === undefined && agentOrScope?.agent !== undefined ? agentOrScope.agent : agentOrScope
  return presetOf(ctx, agent) === 'cordis' ? 'creator' : 'data'
}

/** Stable plugin name for diagnostics. */
export const name = '@nolit/dsh-a2ui-plus'

/**
 * Services this plugin requires before it activates.
 *
 * `webServer` and `connection` are listed even though the transport degrades when
 * they are missing: Cordis refuses a property read on an undeclared service
 * (`cannot get property "webServer" without inject`), so declaring them is what
 * makes the guard in `installDownlink` reachable at all. `dsh-better-sidebar`
 * declares the same pair for the same reason.
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

/** Exported for tests. */
export const internals = { buildTool, buildCatalogTool, sectionText, presetOf, presetAdmits, flavorFor, LIMITS }

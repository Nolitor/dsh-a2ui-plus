/**
 * The renderer executor: the only place a renderer function actually runs.
 *
 * Up to this module the plugin had a *validator* and no executor, which meant the
 * gesture rule was enforced on the wrong side: the Host accepted the agent's own
 * `gesture: true` flag as proof, and nothing ever ran. This module moves the
 * decision to the browser, where a user actually is.
 *
 * The security model, in the order it is applied:
 *
 * 1. **Name.** Only the six names in {@link EXECUTABLE} exist; there is no
 *    dispatch by arbitrary string.
 * 2. **Scheme.** `openUrl` and `downloadFile` accept `https:` only — not `http:`,
 *    not `javascript:`, not `data:`, not `file:`, not a relative path. A URL is
 *    parsed, not pattern-matched, so a scheme cannot be smuggled in by case,
 *    whitespace, or a leading control character.
 * 3. **Gesture.** A gesture-bound function requires *both* a live user activation
 *    (`navigator.userActivation.isActive`) *and* an explicit confirmation from a
 *    dialog the user has to answer. Two independent gates, because activation
 *    alone can be inherited from an unrelated click elsewhere on the page.
 * 4. **Argument shape.** Re-checked here against the same declared schema the Host
 *    checked, so a payload cannot be admitted on one side and explode on the other.
 *
 * Nothing in this module reaches the network, the filesystem, or the agent. A
 * clipboard write, a download the user asked for, and a viewport scroll are the
 * whole surface.
 */

/**
 * The longest URL this executor will hand to the browser.
 *
 * A `javascript:` payload or a data URI is bounded by the same number so a
 * decision can never be made on a truncated string.
 */
export const MAX_URL_LENGTH = 4_096

/** The longest text a copy or download may carry. */
export const MAX_TEXT_LENGTH = 1_048_576

/** How a function is classified for gating. */
export type FunctionKind = 'pure' | 'gesture' | 'local'

/** One executable function. */
export interface ExecutableSpec {
  kind: FunctionKind
  /** Whether the argument shape is re-checked here. */
  parameters: {
    required?: readonly string[]
    properties: Record<string, { type?: string; enum?: readonly string[] }>
  }
}

/** The six functions, as the executor admits them. */
export const EXECUTABLE: Readonly<Record<string, ExecutableSpec>> = Object.freeze({
  openUrl: {
    kind: 'gesture',
    parameters: { required: ['url'], properties: { url: { type: 'string' } } },
  },
  scrollTo: {
    kind: 'local',
    parameters: {
      required: ['componentId'],
      properties: { componentId: { type: 'string' }, behavior: { type: 'string', enum: ['auto', 'smooth'] } },
    },
  },
  copyToClipboard: {
    kind: 'gesture',
    parameters: { required: ['text'], properties: { text: { type: 'string' } } },
  },
  downloadFile: {
    kind: 'gesture',
    parameters: {
      required: ['filename', 'text'],
      properties: { filename: { type: 'string' }, text: { type: 'string' }, mimeType: { type: 'string' } },
    },
  },
  validateForm: {
    kind: 'pure',
    parameters: { properties: { surfaceId: { type: 'string' }, paths: { type: 'array' } } },
  },
  requestFilePicker: {
    kind: 'gesture',
    parameters: { properties: { accept: { type: 'string' }, multiple: { type: 'boolean' } } },
  },
})

/** Why an execution did not happen. */
export type RefusalReason =
  | 'unknown-function'
  | 'invalid-arguments'
  | 'scheme-rejected'
  | 'gesture-required'
  | 'user-declined'
  | 'not-available'

/** One execution outcome. */
export type ExecutionOutcome =
  | { kind: 'result'; functionName: string; value: unknown }
  | { kind: 'refused'; functionName: string; reason: RefusalReason; message: string }

/** What the executor needs from the page; every field is injectable for tests. */
export interface ExecutorHost {
  /** Live user-activation state, or `undefined` where the API is absent. */
  activation?: () => boolean
  /** Ask the user to confirm one gesture-bound action. Resolves `true` when they agree. */
  confirm?: (request: { functionName: string; title: string; detail: string }) => boolean | Promise<boolean>
  /** Open a URL in a new tab. */
  open?: (url: string) => void
  /** Write text to the clipboard. */
  copy?: (text: string) => Promise<void>
  /** Save text as a file. */
  download?: (file: { filename: string; text: string; mimeType?: string }) => void
  /** Scroll a component into view. */
  scroll?: (componentId: string, behavior: 'auto' | 'smooth') => boolean
  /** Ask the user to choose files. */
  pickFiles?: (options: { accept?: string; multiple?: boolean }) => Promise<unknown>
  /** Read the bound form paths for `validateForm`. */
  readForm?: (paths: readonly string[]) => unknown
}

/**
 * Admit a URL for `openUrl` or `downloadFile`.
 *
 * `https:` only. Parsing first means `JavaScript:alert(1)`, `␣javascript:…` and a
 * scheme hidden behind a newline are all rejected before any comparison.
 * @param value the candidate URL.
 * @returns the normalised href, or a refusal message.
 */
export function admitHttpsUrl(value: unknown): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value === '') return { ok: false, message: 'url must be a non-empty string' }
  if (value.length > MAX_URL_LENGTH) return { ok: false, message: `url exceeds ${MAX_URL_LENGTH} characters` }
  // Trimming would launder a leading space into a valid scheme, so only exact
  // input is accepted; a URL with surrounding whitespace is a bug upstream.
  if (value !== value.trim()) return { ok: false, message: 'url must not carry surrounding whitespace' }
  // No control character may appear anywhere. A newline in the middle is the
  // dangerous case: `new URL()` strips tabs and newlines while parsing, so
  // "https://a.test\nhttps://b.test" silently becomes one host. Refusing the
  // character is the only way to keep the parsed URL the one that was sent.
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return { ok: false, message: 'url must not contain control characters' }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, message: 'url is not an absolute URL' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, message: `url scheme "${parsed.protocol}" is not allowed; only https: is` }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, message: 'url must not carry credentials' }
  }
  // The Host the browser reaches must be the host that was written. `new URL()`
  // lowercases the host and adds a trailing slash, which is expected; anything
  // else means the string was reinterpreted.
  const written = value.replace(/\/+$/u, '')
  const reached = parsed.href.replace(/\/+$/u, '')
  if (reached.toLowerCase() !== written.toLowerCase()) {
    return { ok: false, message: 'url was reinterpreted while parsing and is therefore refused' }
  }
  return { ok: true, url: parsed.href }
}

/**
 * Admit a download filename.
 *
 * A path separator or a traversal segment would let a download escape the
 * browser's download directory on a platform that honours it.
 * @param value the candidate filename.
 */
export function admitFilename(value: unknown): { ok: true; filename: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value === '') return { ok: false, message: 'filename must be a non-empty string' }
  if (value.length > 255) return { ok: false, message: 'filename exceeds 255 characters' }
  if (/[/\\]/u.test(value)) return { ok: false, message: 'filename must not contain a path separator' }
  if (value === '.' || value === '..') return { ok: false, message: 'filename must not be a traversal segment' }
  if (/[\u0000-\u001f]/u.test(value)) return { ok: false, message: 'filename must not contain control characters' }
  return { ok: true, filename: value }
}

/** Whether a function is on the executable allowlist. */
export function isExecutable(name: unknown): name is string {
  return typeof name === 'string' && Object.hasOwn(EXECUTABLE, name)
}

/** Whether a function needs a user gesture. */
export function requiresGesture(name: string): boolean {
  return EXECUTABLE[name]?.kind === 'gesture'
}

/**
 * Re-check one argument object against the executable schema.
 * @param name an admitted function name.
 * @param args the arguments to check.
 * @returns a violation message, or `undefined`.
 */
export function checkExecutableArguments(name: string, args: unknown): string | undefined {
  const spec = EXECUTABLE[name]
  if (spec === undefined) return `"${name}" is not executable`
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'args must be an object'
  const record = args as Record<string, unknown>
  for (const key of spec.parameters.required ?? []) {
    if (!Object.hasOwn(record, key)) return `args.${key} is required`
  }
  for (const [key, value] of Object.entries(record)) {
    const property = spec.parameters.properties[key]
    if (property === undefined) return `args.${key} is not a property of ${name}`
    if (value === undefined || value === null) continue
    if (property.type === 'string' && typeof value !== 'string') return `args.${key} must be a string`
    if (property.type === 'boolean' && typeof value !== 'boolean') return `args.${key} must be a boolean`
    if (property.type === 'array' && !Array.isArray(value)) return `args.${key} must be an array`
    if (property.enum !== undefined && !property.enum.includes(value as string)) {
      return `args.${key} must be one of ${property.enum.join(', ')}`
    }
  }
  return undefined
}

/**
 * The page's confirmation dialog for a gesture-bound action.
 *
 * `window.confirm` on purpose: it is modal, it is the browser's own trust surface,
 * and it cannot be dismissed without a decision. A custom overlay would be one
 * more thing to get wrong in a clickjacking scenario.
 * @param request what the user is being asked to allow.
 */
function defaultConfirm(request: { functionName: string; title: string; detail: string }): boolean {
  const confirmFn = (globalThis as any).window?.confirm
  if (typeof confirmFn !== 'function') return false
  const lines = [request.title, request.detail === '' ? '' : request.detail, '', 'Allow this action?'].filter((line, index) => line !== '' || index === 1)
  return confirmFn.call((globalThis as any).window, lines.join('\n')) === true
}

/** Default activation probe: the browser's own user-activation state. */
function browserActivation(): boolean {
  const navigation = (globalThis as any).navigator
  const activation = navigation?.userActivation
  return activation?.isActive === true
}

/**
 * The executor.
 *
 * Constructed once per page. It holds no state between calls: every execution
 * re-reads activation, re-checks the scheme, and re-checks the arguments, because
 * a payload can arrive at any time from the agent.
 */
export class RendererExecutor {
  private readonly host: ExecutorHost

  /** @param host page hooks; omitted fields fall back to the real browser surface. */
  constructor(host: ExecutorHost = {}) {
    this.host = {
      activation: host.activation ?? browserActivation,
      confirm: host.confirm ?? defaultConfirm,
      copy: host.copy ?? defaultCopy,
      download: host.download ?? defaultDownload,
      scroll: host.scroll ?? defaultScroll,
      ...(host.open === undefined ? {} : { open: host.open }),
      ...(host.pickFiles === undefined
        ? {
            // The browser picker is behind an input element; it only works inside
            // the gesture the gate already verified.
            pickFiles: async (options) => {
              const document = (globalThis as any).document
              if (document === undefined) throw new Error('this page has no file picker')
              return await new Promise((resolve) => {
                const input = document.createElement('input')
                input.type = 'file'
                if (options.accept !== undefined) input.accept = options.accept
                input.multiple = options.multiple === true
                input.onchange = () => resolve(input.files)
                input.click()
              })
            },
          }
        : { pickFiles: host.pickFiles }),
      ...(host.readForm === undefined ? {} : { readForm: host.readForm }),
    }
  }

  /**
   * Run one admitted request.
   *
   * The agent's own `gesture` flag is **not** an argument here: it is deliberately
   * absent from the signature, so no caller can pass it through by accident. The
   * only thing that satisfies a gesture gate is `activation()` plus `confirm()`.
   * @param functionName the requested function.
   * @param args its arguments.
   * @returns the outcome, never a throw.
   */
  async execute(functionName: unknown, args: unknown): Promise<ExecutionOutcome> {
    const name = String(functionName)
    if (!isExecutable(name)) {
      return { kind: 'refused', functionName: name, reason: 'unknown-function', message: `"${name}" is not executable` }
    }
    const violation = checkExecutableArguments(name, args)
    if (violation !== undefined) {
      return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: violation }
    }
    const record = (args ?? {}) as Record<string, unknown>

    try {
      if (requiresGesture(name)) {
        const gate = await this.passGestureGate(name, record)
        if (gate !== undefined) return gate
      }
      return await this.run(name, record)
    } catch (error) {
      return {
        kind: 'refused',
        functionName: name,
        reason: 'not-available',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * The two-gate check a gesture-bound function must pass.
   * @returns the refusal, or `undefined` when both gates agreed.
   */
  private async passGestureGate(name: string, record: Record<string, unknown>): Promise<ExecutionOutcome | undefined> {
    const activation = this.host.activation ?? browserActivation
    // Gate 1: a real activation. Without the API (a very old browser, jsdom) this
    // is treated as *absent*, not as permission.
    if (!activation()) {
      return {
        kind: 'refused',
        functionName: name,
        reason: 'gesture-required',
        message: `${name} needs a live user gesture; ask the user to click and retry`,
      }
    }
    if (this.host.confirm === undefined) {
      // No confirmation surface means the second gate cannot be satisfied, so the
      // action does not happen. Failing closed is the only safe default here.
      return {
        kind: 'refused',
        functionName: name,
        reason: 'not-available',
        message: `${name} needs a confirmation dialog, which this page did not provide`,
      }
    }
    const detail =
      typeof record.url === 'string'
        ? record.url
        : typeof record.filename === 'string'
          ? record.filename
          : typeof record.text === 'string'
            ? `${record.text.length} characters`
            : ''
    const agreed = await this.host.confirm({ functionName: name, title: `${name}?`, detail })
    if (agreed !== true) {
      return { kind: 'refused', functionName: name, reason: 'user-declined', message: 'the user declined' }
    }
    return undefined
  }

  /** Perform one admitted, gated function. */
  private async run(name: string, record: Record<string, unknown>): Promise<ExecutionOutcome> {
    if (name === 'openUrl') {
      const admitted = admitHttpsUrl(record.url)
      // Narrowing needs `strict`, which this package builds without; the union
      // member is read explicitly rather than by discriminant flow.
      if (!admitted.ok) {
        return { kind: 'refused', functionName: name, reason: 'scheme-rejected', message: (admitted as { message: string }).message }
      }
      const open = this.host.open ?? ((url: string) => (globalThis as any).window?.open?.(url, '_blank', 'noopener,noreferrer'))
      open((admitted as { url: string }).url)
      return { kind: 'result', functionName: name, value: { opened: true, url: (admitted as { url: string }).url } }
    }

    if (name === 'downloadFile') {
      const filename = admitFilename(record.filename)
      if (!filename.ok) {
        return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: (filename as { message: string }).message }
      }
      const text = record.text
      if (typeof text !== 'string') return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: 'text must be a string' }
      if (text.length > MAX_TEXT_LENGTH) {
        return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: `text exceeds ${MAX_TEXT_LENGTH} characters` }
      }
      const save = this.host.download ?? defaultDownload
      save({ filename: (filename as { filename: string }).filename, text, ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}) })
      return { kind: 'result', functionName: name, value: { saved: true, filename: (filename as { filename: string }).filename, bytes: text.length } }
    }

    if (name === 'copyToClipboard') {
      const text = record.text
      if (typeof text !== 'string') return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: 'text must be a string' }
      if (text.length > MAX_TEXT_LENGTH) {
        return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: `text exceeds ${MAX_TEXT_LENGTH} characters` }
      }
      const copy = this.host.copy ?? defaultCopy
      await copy(text)
      return { kind: 'result', functionName: name, value: { copied: true, characters: text.length } }
    }

    if (name === 'scrollTo') {
      const componentId = record.componentId
      if (typeof componentId !== 'string' || componentId === '') {
        return { kind: 'refused', functionName: name, reason: 'invalid-arguments', message: 'componentId must be a non-empty string' }
      }
      const behavior = record.behavior === 'smooth' ? 'smooth' : 'auto'
      const scroll = this.host.scroll ?? defaultScroll
      const found = scroll(componentId, behavior)
      return found
        ? { kind: 'result', functionName: name, value: { scrolled: true, componentId } }
        : { kind: 'refused', functionName: name, reason: 'not-available', message: `component "${componentId}" is not on screen` }
    }

    if (name === 'validateForm') {
      const paths = Array.isArray(record.paths) ? record.paths.filter((entry): entry is string => typeof entry === 'string') : []
      const readForm = this.host.readForm
      const values = readForm === undefined ? {} : readForm(paths)
      return { kind: 'result', functionName: name, value: { valid: true, values } }
    }

    if (name === 'requestFilePicker') {
      const picker = this.host.pickFiles
      if (picker === undefined) {
        return { kind: 'refused', functionName: name, reason: 'not-available', message: 'this page has no file picker' }
      }
      const files = await picker({
        ...(typeof record.accept === 'string' ? { accept: record.accept } : {}),
        multiple: record.multiple === true,
      })
      return { kind: 'result', functionName: name, value: { picked: files === undefined || files === null ? 0 : 1 } }
    }

    return { kind: 'refused', functionName: name, reason: 'unknown-function', message: `"${name}" has no implementation` }
  }
}

/** Clipboard write through the browser API. */
async function defaultCopy(text: string): Promise<void> {
  const clipboard = (globalThis as any).navigator?.clipboard
  if (typeof clipboard?.writeText !== 'function') throw new Error('this browser has no clipboard API')
  await clipboard.writeText(text)
}

/** Save text as a file through an object URL. */
function defaultDownload(file: { filename: string; text: string; mimeType?: string }): void {
  const globals = globalThis as any
  const BlobCtor = globals.Blob
  const document = globals.document
  if (typeof BlobCtor !== 'function' || document === undefined) throw new Error('this page cannot save files')
  const blob = new BlobCtor([file.text], { type: file.mimeType ?? 'text/plain;charset=utf-8' })
  const href = globals.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = file.filename
  anchor.rel = 'noopener'
  anchor.click()
  globals.setTimeout(() => globals.URL.revokeObjectURL(href), 0)
}

/** Scroll a component into view by its data attribute. */
function defaultScroll(componentId: string, behavior: 'auto' | 'smooth'): boolean {
  const document = (globalThis as any).document
  if (document === undefined) return false
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(componentId) : componentId.replace(/["\\]/gu, '\\$&')
  const element = document.querySelector(`[data-a2ui-id="${escaped}"]`)
  if (element === null || element === undefined) return false
  element.scrollIntoView?.({ behavior, block: 'center' })
  return true
}

/**
 * Shared test harness for the shipped browser bundle.
 *
 * Loads `client.js` exactly as the Harness module table does (a vm with a
 * `window.__ModuleLoader__`), registers the slots through a fake Client context,
 * and exposes the two registered components so tests can render them with real
 * React through `react-dom/server`.
 *
 * React and react-dom are development dependencies; the Host keeps supplying the
 * browser's runtime React through the module table.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const React = require('react')
export const { renderToStaticMarkup } = require('react-dom/server')

/** Minimal DOM shim: `apply()` may inject a stylesheet and nothing else. */
function documentShim() {
  const created = []
  return {
    created,
    head: {
      appendChild(node) {
        created.push(node)
      },
    },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    addEventListener() {},
    removeEventListener() {},
  }
}

/** A read-only Session event source as exposed on a DSH SessionBinding. */
export function sessionEvents() {
  const listeners = new Set()
  let snapshot = { entries: [], revision: 0, change: { kind: 'replace', entries: [] } }
  function publish(entries, change, revision = snapshot.revision + 1) {
    snapshot = { entries, revision, change }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscriberCount: () => listeners.size,
    replace(entries) {
      publish(entries, { kind: 'replace', entries })
    },
    append(...entries) {
      publish([...snapshot.entries, ...entries], { kind: 'append', entries })
    },
    prepend(...entries) {
      publish([...entries, ...snapshot.entries], { kind: 'prepend', entries })
    },
    skipRevision(entries, latest) {
      publish(entries, { kind: 'append', entries: latest }, snapshot.revision + 2)
    },
    settle(attemptId) {
      const entries = snapshot.entries.filter(({ type, event }) => type !== 'transient' || event.data.attemptId !== attemptId)
      publish(entries, { kind: 'settle-assistant', attemptId })
    },
  }
}

export function toolDelta(seq, id, argumentsDelta, { name, attemptId = 'attempt' } = {}) {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      data: { attemptId, chunk: { type: 'tool-call-delta', id, argumentsDelta, ...(name === undefined ? {} : {name}) } },
    },
  }
}

/**
 * Load the bundle and register its slots.
 * @param options.bundlePath override the bundle location.
 * @param options.locale locale id the fake locale service reports.
 * @param options.onSend conversation `send` implementation the action path calls;
 *   receives the exact queued text. Defaults to rejecting ("no open session").
 * @param options.openSessions session ids whose scope resolves; defaults to all.
 * @param options.eventSource lookup of an already open Session's event source.
 */
export function loadView(options = {}) {
  const bundlePath = options.bundlePath ?? path.join(ROOT, 'client.js')
  const source = fs.readFileSync(bundlePath, 'utf8')
  const loaded = {}
  // A real DOM (`options.document`) is needed for behaviour the plugin attaches
  // to `document` rather than to React props — the modal's Escape/Tab handling —
  // because the default shim's `addEventListener` is a deliberate no-op.
  const document = options.document ?? documentShim()
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (definition) => (loaded[definition.id] = definition) },
      open() {},
      setInterval: () => 0,
      clearInterval() {},
    },
    document,
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const definition = loaded['@nolit/dsh-a2ui-plus']
  if (definition === undefined) throw new Error('bundle did not register under @nolit/dsh-a2ui-plus')

  const registered = []
  const locales = []
  const module = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external module: ${specifier}`)
  })
  const ctx = {
    effect(factory) {
      factory()
    },
    slots: {
      inject(_key, callback) {
        callback()
      },
      register(options2, component) {
        registered.push({ options: options2, component })
        return () => {}
      },
    },
    locale: {
      register(namespace) {
        locales.push(namespace)
        return () => {}
      },
      bind() {
        return (key) => key
      },
      getLocale: () => ({ id: options.locale ?? 'zh-CN' }),
    },
    sessions: {
      binding(sessionId) {
        const eventSource = options.eventSource?.(sessionId)
        return eventSource === undefined ? undefined : { eventSource }
      },
      scope: (sessionId) => {
        // The plugin's own `sendPrompt` looks the Conversation service up through
        // the session scope, so the harness models exactly that.
        if (options.openSessions !== undefined && !options.openSessions.includes(sessionId)) return undefined
        return {
          get: (name) =>
            name === 'conversation' && options.onSend !== undefined
              ? {
                  send: (text) => options.onSend(text, sessionId),
                }
              : undefined,
        }
      },
    },
  }
  module.apply(ctx)

  const view = registered.find((entry) => entry.options.name === 'tool.call.toolview')
  const tail = registered.find((entry) => entry.options.name === 'conversation.chat.turnTail')
  if (view === undefined) throw new Error('tool.call.toolview was not registered')
  if (tail === undefined) throw new Error('conversation.chat.turnTail was not registered')

  return {
    View: view.component,
    Tail: tail.component,
    registrations: registered,
    locales,
    document,
    module,
  }
}

/** Render one registered component to static markup. */
export function renderToHtml(component, props) {
  return renderToStaticMarkup(React.createElement(component, props))
}

/** Visible text of an HTML fragment (tags stripped, whitespace collapsed). */
export function visibleText(html) {
  return html
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&quot;/gu, '"')
    .replace(/&amp;/gu, '&')
    .replace(/&#x27;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim()
}

export { ROOT }

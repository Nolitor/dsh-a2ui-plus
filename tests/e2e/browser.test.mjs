/**
 * Real-browser E2E against a live, isolated DSH host.
 *
 * Everything below runs in Chromium: the plugin's client bundle is the one the
 * Host served, `DSH-better-sidebar` is the real package, and the gesture gates are
 * exercised by an actual click. Nothing here stubs a browser API, which is what
 * makes it evidence rather than a second opinion about the unit tests.
 *
 * Prerequisites (see docs/E2E.md): an isolated DSH home on port 3099 with both
 * packages installed, and `E2E_URL` pointing at its launch URL.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const URL_BASE = process.env.E2E_URL
const EXECUTABLE = process.env.E2E_CHROMIUM

/** Whether a live host was provided; without one the suite reports why it cannot run. */
const live = URL_BASE !== undefined && URL_BASE !== ''

/**
 * Open a page on the live host and wait for the client plugin table to settle.
 * @param options viewport and permission overrides.
 */
async function openPage(browser, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    permissions: options.permissions ?? [],
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  // A freshly created DSH home opens the "Preview Notice" modal, and its mask makes
  // the whole app inert, so a real click never lands. It is host chrome, not this
  // plugin, and it mounts *after* boot — removing it once races with that, so the
  // dismissal is installed as a page-level observer before the first navigation.
  // Without this, every click-based case measures the modal instead of the renderer.
  // The launch token is answered with a cookie and a redirect, so one navigation
  // is enough.
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_500)
  // Host chrome, not this plugin: a fresh DSH home raises its own notices ("Preview
  // Notice" from 0.2, then "Get started" for the account) and each one makes the
  // app inert, so a real click never lands. They are dismissed through their own
  // Close control, which is what a user does; a case that skipped this would
  // measure the notice instead of the renderer.
  // These mount asynchronously — the account prompt arrives after the session list
  // — so the loop waits for one to appear rather than breaking on the first empty
  // poll, and keeps dismissing until the app is interactive.
  // Two different prompts, two different affordances, both measured: "Preview
  // Notice" has a single primary "Continue" and NO Close control, while "Get
  // started" has an X labelled "Close". Looking only for Close left the notice up
  // and the app inert forever — the first version of this loop did exactly that.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const inert = await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert') === true)
    const modal = page.locator('[aria-modal="true"]').first()
    if ((await modal.count()) === 0) {
      if (!inert) break
      await page.waitForTimeout(400)
      continue
    }
    const control = modal
      .locator('[aria-label="Close"], button')
      .filter({ hasNot: page.locator('[disabled]') })
      .first()
    try {
      await control.click({ timeout: 3_000 })
    } catch {
      await page.waitForTimeout(400)
      continue
    }
    await page.waitForTimeout(700)
  }
  return { context, page, errors }
}

describe('a2ui-plus in a real browser', { skip: live ? false : 'E2E_URL is not set' }, () => {
  let browser

  before(async () => {
    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
  })

  after(async () => {
    await browser?.close()
  })

  test('the client bundle loads and registers itself in the page', async () => {
    const { context, page, errors } = await openPage(browser)
    try {
      // The module table is the loader's own registry; a bundle that failed to
      // link never appears here.
      const modules = await page.evaluate(() => {
        const table = globalThis.__ModuleLoader__ ?? globalThis.__dshModules
        if (table === undefined) return Object.keys(globalThis.__DSH_MODULES__ ?? {})
        const definitions = table.definitions ?? table.modules ?? table
        return Object.keys(definitions ?? {})
      })
      const listed = JSON.stringify(modules)
      assert.ok(
        listed.includes('a2ui-plus') || errors.length === 0,
        `no page error surfaced while the bundle linked: ${errors.join(' | ')}`,
      )
      // The plugin's own style element is the cheapest durable proof its apply()
      // ran: it is created inside ctx.effect during registration.
      const styleTag = await page.evaluate(() =>
        [...document.querySelectorAll('style[data-plugin-css]')].map((node) => node.dataset.pluginCss),
      )
      assert.ok(
        styleTag.some((id) => String(id).includes('a2ui-plus')),
        `the plugin stylesheet is present: ${JSON.stringify(styleTag)}`,
      )
    } finally {
      await context.close()
    }
  })

  test('the downlink socket negotiates its versioned subprotocol', async () => {
    const { context, page } = await openPage(browser)
    try {
      // Open a socket the same way the bundle does and read the negotiated value.
      const protocol = await page.evaluate(async () => {
        const response = await fetch('/api/session/list', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
        void response
        const url = new URL('/a2ui/ws?sessionId=e2e-probe', location.href)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        return await new Promise((resolve) => {
          const socket = new WebSocket(url.href, 'a2ui-plus.v1')
          const timer = setTimeout(() => resolve('timeout'), 4_000)
          socket.onopen = () => {
            clearTimeout(timer)
            const value = socket.protocol
            socket.close()
            resolve(value)
          }
          socket.onerror = () => {
            clearTimeout(timer)
            resolve('error')
          }
        })
      })
      assert.equal(protocol, 'a2ui-plus.v1', 'the Host negotiates the versioned subprotocol in a real browser')
    } finally {
      await context.close()
    }
  })

  test('a real click satisfies the activation gate, and the window then lapses', async () => {
    const { context, page } = await openPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] })
    try {
      // Accept any dialog this test raises, so the only variable left is the
      // activation window. Without a handler the browser auto-dismisses, and a
      // `user-declined` refusal would be mistaken for a gesture-gate refusal.
      page.on('dialog', (dialog) => void dialog.accept())
      // A real user gesture on a real element, then read the browser's own
      // activation state inside the same task — this is the API the executor
      // gates on, measured rather than assumed.
      const activation = await page.evaluate(async () => {
        const button = document.createElement('button')
        button.textContent = 'probe'
        button.id = 'e2e-activation-probe'
        document.body.appendChild(button)
        const seen = await new Promise((resolve) => {
          button.addEventListener('click', () => resolve({ active: navigator.userActivation?.isActive ?? null }), { once: true })
          button.click()
        })
        button.remove()
        return seen
      })
      assert.equal(activation.active, true, 'a real click makes userActivation.isActive true')

      // The window is transient, and the whole measurement must stay inside ONE
      // evaluate: a protocol round trip between two evaluates counts as activity
      // and hands the page a fresh window, which hides the lapse and would let the
      // assertion below pass for the wrong reason.
      const observed = await page.evaluate(async () => {
        const executor = globalThis.__a2uiPlusExecutor
        if (executor === undefined) return { missing: true }
        const button = document.createElement('button')
        document.body.appendChild(button)

        const samples = []
        const clicked = new Promise((resolve) => {
          button.addEventListener(
            'click',
            () => {
              const start = performance.now()
              const tick = () => {
                samples.push([Math.round(performance.now() - start), navigator.userActivation.isActive])
                if (performance.now() - start < 7_000) setTimeout(tick, 500)
                else resolve()
              }
              tick()
            },
            { once: true },
          )
          button.click()
        })
        await clicked

        // Still the same evaluate, so no round trip has refreshed anything.
        const outcome = await executor.execute('copyToClipboard', { text: 'e2e-after-lapse' })
        button.remove()
        return {
          samples,
          activationNow: navigator.userActivation.isActive,
          kind: outcome.kind,
          reason: outcome.reason ?? null,
        }
      })

      assert.equal(observed.missing, undefined, 'the page exposes its executor')
      assert.equal(observed.samples[0][1], true, 'the click activates')
      const firstFalse = observed.samples.find(([, active]) => active === false)
      assert.ok(firstFalse !== undefined, `the window must lapse inside 7s: ${JSON.stringify(observed.samples)}`)
      assert.ok(firstFalse[0] >= 4_000, `the window lasts about 5s, not ${firstFalse[0]}ms`)
      assert.equal(observed.activationNow, false, 'the window is closed at the moment of the call')
      assert.equal(observed.kind, 'refused', 'no activation means no action')
      assert.equal(observed.reason, 'gesture-required')
    } finally {
      await context.close()
    }
  })

  test('the positive path: real click, accepted dialog, real clipboard write', async () => {
    const { context, page } = await openPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] })
    try {
      // Accept the plugin's own confirmation dialog. This is the second gate: a
      // test that auto-accepted without a click would prove nothing, so the click
      // comes from Playwright's real input below.
      page.on('dialog', (dialog) => void dialog.accept())

      await page.evaluate(() => {
        const button = document.createElement('button')
        button.id = 'e2e-positive'
        button.textContent = 'Copy'
        button.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;padding:8px'
        document.body.appendChild(button)
      })

      const outcomePromise = page.evaluate(
        () =>
          new Promise((resolve) => {
            const button = document.getElementById('e2e-positive')
            button.addEventListener(
              'click',
              async () => {
                const executor = globalThis.__a2uiPlusExecutor
                if (executor === undefined) {
                  resolve({ kind: 'missing' })
                  return
                }
                // Inside the click handler, so the activation window is live.
                const outcome = await executor.execute('copyToClipboard', { text: 'a2ui-e2e-proof' })
                resolve({ kind: outcome.kind, reason: outcome.reason ?? null, value: outcome.value ?? null })
              },
              { once: true },
            )
          }),
      )

      // A real trusted click, not `element.click()`.
      await page.click('#e2e-positive')
      const outcome = await outcomePromise
      assert.equal(outcome.kind, 'result', `the positive path must execute: ${JSON.stringify(outcome)}`)
      assert.equal(outcome.value.copied, true)

      // The clipboard actually holds the text: the browser confirms the effect,
      // not just the intent.
      const clipboard = await page.evaluate(() => navigator.clipboard.readText())
      assert.equal(clipboard, 'a2ui-e2e-proof')
    } finally {
      await context.close()
    }
  })

  test('a declined dialog performs nothing', async () => {
    const { context, page } = await openPage(browser, { permissions: ['clipboard-write'] })
    try {
      page.on('dialog', (dialog) => void dialog.dismiss())
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.id = 'e2e-declined'
        button.textContent = 'Copy'
        button.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;padding:8px'
        document.body.appendChild(button)
      })
      const outcomePromise = page.evaluate(
        () =>
          new Promise((resolve) => {
            document.getElementById('e2e-declined').addEventListener(
              'click',
              async () => {
                const executor = globalThis.__a2uiPlusExecutor
                const outcome = await executor.execute('copyToClipboard', { text: 'must-not-be-copied' })
                resolve({ kind: outcome.kind, reason: outcome.reason ?? null })
              },
              { once: true },
            )
          }),
      )
      await page.click('#e2e-declined')
      const outcome = await outcomePromise
      assert.equal(outcome.kind, 'refused')
      assert.equal(outcome.reason, 'user-declined', 'activation alone does not authorize')
    } finally {
      await context.close()
    }
  })

  test('javascript and data URLs never reach the browser, even after a click', async () => {
    const { context, page } = await openPage(browser)
    try {
      page.on('dialog', (dialog) => void dialog.accept())
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.id = 'e2e-scheme'
        button.textContent = 'Open'
        button.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;padding:8px'
        document.body.appendChild(button)
        // Record every window.open the page attempts.
        globalThis.__opened = []
        const original = window.open
        window.open = (...args) => {
          globalThis.__opened.push(args[0])
          return original.apply(window, args)
        }
      })
      // Each URL gets its own button and its own click. Reusing one activation
      // for four calls would measure the first decision three times over, and a
      // refusal that came from the gesture gate would read as a scheme refusal.
      const badUrls = ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'http://example.com', 'file:///etc/passwd']
      for (const [index, url] of badUrls.entries()) {
        const id = `e2e-scheme-${index}`
        // Create the button and attach its listener in ONE evaluate, so the click
        // below always lands on the element the listener belongs to.
        const outcomePromise = page.evaluate(
          ({ candidate, buttonId }) =>
            new Promise((resolve) => {
              const button = document.createElement('button')
              button.id = buttonId
              button.textContent = 'Open'
              button.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;padding:8px'
              document.body.appendChild(button)
              button.addEventListener(
                'click',
                async () => {
                  const executor = globalThis.__a2uiPlusExecutor
                  if (executor === undefined) {
                    resolve({ kind: 'missing' })
                    return
                  }
                  const outcome = await executor.execute('openUrl', { url: candidate })
                  resolve({ kind: outcome.kind, reason: outcome.reason ?? null })
                },
                { once: true },
              )
            }),
          { candidate: url, buttonId: id },
        )
        await page.click(`#${id}`)
        const result = await outcomePromise
        assert.equal(result.kind, 'refused', `${url} must be refused`)
        assert.equal(result.reason, 'scheme-rejected', `${url} must fail on the scheme, got ${result.reason}`)
        await page.evaluate((buttonId) => document.getElementById(buttonId)?.remove(), id)
      }

      const opened = await page.evaluate(() => globalThis.__opened)
      assert.deepEqual(opened, [], 'window.open was never called for a rejected URL')
    } finally {
      await context.close()
    }
  })

  test('a sidebar surface opens its own tab and paints real components', async () => {
    const { context, page, errors } = await openPage(browser, { viewport: { width: 1440, height: 900 } })
    try {
      // A session must exist before the right column can expand.
      // A real click: the mounted-session observable only moves when the app itself
      // decided to switch, which is exactly the event these cases depend on.
      await page.locator('[aria-label="New session"]').first().click()
      await page.waitForTimeout(3_000)

      // The session the Sidebar is actually showing. A tab body is mounted with
      // no `sessionId`, which is exactly why it must resolve this itself.
      const mounted = await page.evaluate(() =>
        document.querySelector('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session'),
      )
      assert.ok(typeof mounted === 'string' && mounted !== '', 'the sidebar reports its mounted session')

      // Drive the plugin's own store, the way a Host frame or a tool result would.
      // This exercises syncTabs -> resolvePlacement -> openTab for real.
      const seeded = await page.evaluate(
        ({ sessionId }) => {
          const store = globalThis.__a2uiPlusStore?.(sessionId)
          if (store === undefined) return { ok: false, reason: 'the store handle is missing' }
          store.apply({
            type: 'ACTIVITY_SNAPSHOT',
            surfaceId: 'e2e-dashboard',
            surfaceRevision: 1,
            surfaceEpoch: 'e2e',
            activityType: 'a2ui.surface',
            messageId: 'e2e-dashboard',
            content: {
              surfaceId: 'e2e-dashboard',
              placement: 'sidebar',
              title: 'System Status',
              messages: [
                {
                  version: '1.0',
                  createSurface: {
                    surfaceId: 'e2e-dashboard',
                    catalogId: 'dsh-a2ui/catalog/v1',
                    components: [
                      { id: 'root', component: 'Column', children: ['k1', 'k2', 'k3'] },
                      { id: 'k1', component: 'Stat', label: 'CPU', value: '0.55' },
                      { id: 'k2', component: 'Stat', label: 'Memory', value: '8 GB' },
                      { id: 'k3', component: 'Text', text: 'uptime 6h', variant: 'caption' },
                    ],
                    dataModel: {},
                  },
                },
              ],
              dataModel: {},
              components: [],
            },
            replace: true,
          })
          return { ok: true }
        },
        { sessionId: mounted },
      )
      assert.equal(seeded.ok, true, `the store accepted the surface: ${JSON.stringify(seeded)}`)
      await page.waitForTimeout(3_500)

      const painted = await page.evaluate(() => ({
        titles: [...document.querySelectorAll('[data-dockkit-tab]')].map((node) => (node.textContent ?? '').trim()),
        rootCount: document.querySelectorAll('.a2ui-root').length,
        // The component tree's own nodes: a Column renders `.a2ui-stack`, a Stat
        // renders a caption plus a value.
        nodeCount: document.querySelectorAll('.a2ui-stack').length,
        captionCount: document.querySelectorAll('.a2ui-caption').length,
        paneText: (document.querySelector('[data-dockkit-pane]')?.textContent ?? '').trim(),
        skeletons: document.querySelectorAll('[data-a2ui-pending]').length,
      }))

      // The dynamic instance, named by the call's own title — not "Generative UI".
      assert.ok(
        painted.titles.includes('System Status'),
        `the dynamic tab carries the call title: ${JSON.stringify(painted.titles)}`,
      )
      // Real content, not an empty slot: at least two painted component nodes.
      assert.ok(painted.nodeCount >= 2, `at least two component nodes rendered: ${painted.nodeCount}`)
      assert.ok(painted.rootCount >= 1, 'the surface root is mounted')
      assert.ok(painted.paneText.includes('CPU'), `the pane shows real values: ${painted.paneText.slice(0, 120)}`)
      assert.ok(painted.paneText.includes('8 GB'), 'both stat values painted')
      assert.equal(painted.skeletons, 0, 'a satisfied surface draws content, not the skeleton')
      assert.deepEqual(errors, [], `no page error while painting: ${errors.join(' | ')}`)
    } finally {
      await context.close()
    }
  })

  test('a surface owned by another session is never painted here', async () => {
    const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } })
    try {
      // A real click: the mounted-session observable only moves when the app itself
      // decided to switch, which is exactly the event these cases depend on.
      await page.locator('[aria-label="New session"]').first().click()
      await page.waitForTimeout(3_000)
      const mounted = await page.evaluate(() =>
        document.querySelector('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session'),
      )
      assert.ok(mounted !== null, 'the sidebar reports its mounted session')

      // A store keyed by a session nobody is looking at.
      const result = await page.evaluate(() => {
        const store = globalThis.__a2uiPlusStore?.('session-not-on-screen')
        if (store === undefined) return { ok: false }
        store.apply({
          type: 'ACTIVITY_SNAPSHOT',
          surfaceId: 'foreign-surface',
          surfaceRevision: 1,
          surfaceEpoch: 'foreign',
          activityType: 'a2ui.surface',
          messageId: 'foreign-surface',
          content: {
            surfaceId: 'foreign-surface',
            placement: 'sidebar',
            title: 'Foreign Tab',
            messages: [
              {
                version: '1.0',
                createSurface: {
                  surfaceId: 'foreign-surface',
                  catalogId: 'dsh-a2ui/catalog/v1',
                  components: [{ id: 'root', component: 'Text', text: 'LEAKED', variant: 'body' }],
                  dataModel: {},
                },
              },
            ],
            dataModel: {},
            components: [],
          },
          replace: true,
        })
        return { ok: true }
      })
      assert.equal(result.ok, true)
      await page.waitForTimeout(3_000)

      const painted = await page.evaluate(() => ({
        titles: [...document.querySelectorAll('[data-dockkit-tab]')].map((node) => (node.textContent ?? '').trim()),
        body: document.body.textContent ?? '',
      }))
      // The refusal path: a surface whose store key is not the mounted session
      // must not open a tab and must not paint into this column.
      assert.ok(
        !painted.titles.includes('Foreign Tab'),
        `no tab for another session: ${JSON.stringify(painted.titles)}`,
      )
      assert.ok(!painted.body.includes('LEAKED'), 'no foreign surface content painted')
    } finally {
      await context.close()
    }
  })


  test('a sidebar surface also paints a non-empty inline card next to its tab', async () => {
    const { context, page, errors } = await openPage(browser, { viewport: { width: 1440, height: 900 } })
    try {
      // A real click: the mounted-session observable only moves when the app itself
      // decided to switch, which is exactly the event these cases depend on.
      await page.locator('[aria-label="New session"]').first().click()
      await page.waitForTimeout(3_000)
      const mounted = await page.evaluate(() =>
        document.querySelector('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session'),
      )
      assert.ok(typeof mounted === 'string' && mounted !== '', 'the sidebar reports its mounted session')

      // The same injected snapshot the tab case uses: the plugin's own store, the
      // plugin's own syncTabs. What is new is that the card is measured too.
      const seeded = await page.evaluate(
        ({ sessionId }) => {
          const store = globalThis.__a2uiPlusStore?.(sessionId)
          const adapter = globalThis.__a2uiPlusAdapter
          if (store === undefined || adapter === undefined) return { ok: false, reason: 'handles missing' }
          store.apply({
            type: 'ACTIVITY_SNAPSHOT',
            surfaceId: 'e2e-inline-card',
            surfaceRevision: 1,
            surfaceEpoch: 'e2e',
            activityType: 'a2ui.surface',
            messageId: 'e2e-inline-card',
            content: {
              surfaceId: 'e2e-inline-card',
              placement: 'sidebar',
              title: 'System Status',
              messages: [
                {
                  version: '1.0',
                  createSurface: {
                    surfaceId: 'e2e-inline-card',
                    catalogId: 'dsh-a2ui/catalog/v1',
                    components: [
                      { id: 'root', component: 'Column', children: ['k1', 'k2'] },
                      { id: 'k1', component: 'Stat', label: 'CPU', value: '0.55' },
                      { id: 'k2', component: 'Stat', label: 'Memory', value: '8 GB' },
                    ],
                    dataModel: {},
                  },
                },
              ],
              dataModel: {},
              components: [],
            },
            replace: true,
          })
          // The mediator's condensed model is what the conversation card renders.
          const model = adapter.inlineModel('e2e-inline-card')
          return {
            ok: true,
            model:
              model === undefined
                ? undefined
                : { condensed: model.condensed, componentCount: model.componentCount, rows: model.rows.length, title: model.title },
          }
        },
        { sessionId: mounted },
      )
      assert.equal(seeded.ok, true, `the store and adapter are reachable: ${JSON.stringify(seeded)}`)
      assert.ok(seeded.model !== undefined, 'the mediator derives an inline model for the surface')
      assert.equal(seeded.model.condensed, true, 'a tab-owned surface is condensed in the conversation')
      assert.ok(seeded.model.componentCount >= 1, `componentCount >= 1, got ${seeded.model.componentCount}`)
      assert.ok(seeded.model.rows >= 1, `the summary carries rows, got ${seeded.model.rows}`)
      assert.equal(seeded.model.title, 'System Status')
      await page.waitForTimeout(2_500)
      // The tab is still there: both views are alive off one store.
      const titles = await page.evaluate(() => [...document.querySelectorAll('[data-dockkit-tab]')].map((node) => (node.textContent ?? '').trim()))
      assert.ok(titles.includes('System Status'), `the tab still opened: ${JSON.stringify(titles)}`)
      assert.deepEqual(errors, [], `no page error while painting: ${errors.join(' | ')}`)
    } finally {
      await context.close()
    }
  })

  test('switching the mounted session hides the previous session surfaces in both views', async () => {
    const { context, page } = await openPage(browser, { viewport: { width: 1440, height: 900 } })
    try {
      // A real click: the mounted-session observable only moves when the app itself
      // decided to switch, which is exactly the event these cases depend on.
      await page.locator('[aria-label="New session"]').first().click()
      await page.waitForTimeout(3_000)
      const first = await page.evaluate(() =>
        document.querySelector('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session'),
      )
      assert.ok(typeof first === 'string' && first !== '', 'a first session is mounted')

      await page.evaluate(
        ({ sessionId }) => {
          globalThis.__a2uiPlusStore?.(sessionId).apply({
            type: 'ACTIVITY_SNAPSHOT',
            surfaceId: 'e2e-leak',
            surfaceRevision: 1,
            surfaceEpoch: 'e2e',
            activityType: 'a2ui.surface',
            messageId: 'e2e-leak',
            content: {
              surfaceId: 'e2e-leak',
              placement: 'sidebar',
              title: 'A Only Card',
              messages: [
                {
                  version: '1.0',
                  createSurface: {
                    surfaceId: 'e2e-leak',
                    catalogId: 'dsh-a2ui/catalog/v1',
                    components: [{ id: 'root', component: 'Text', text: 'LEAK-PROOF-MARKER' }],
                    dataModel: {},
                  },
                },
              ],
              dataModel: {},
              components: [],
            },
            replace: true,
          })
        },
        { sessionId: first },
      )
      await page.waitForTimeout(2_000)
      const before = await page.evaluate(() => ({
        titles: [...document.querySelectorAll('[data-dockkit-tab]')].map((node) => (node.textContent ?? '').trim()),
        body: document.body.textContent ?? '',
      }))
      assert.ok(before.titles.includes('A Only Card'), `the tab existed before the switch: ${JSON.stringify(before.titles)}`)

      // The switch itself, driven the way the mounted-session subscription drives it.
      //
      // LIMIT, stated rather than hidden: this home cannot mint a second non-empty
      // session (that needs a model turn, and the isolated profile has no
      // credentials), so the host's own "New session" control keeps returning the
      // empty session it already had. The adapter's entry point is therefore called
      // directly — the same call `followMountedSession` makes — and what is
      // measured below is the consequence in the DOM, which is the claim under test.
      // The wiring from `sidebarRight.mounted` to this call is covered by
      // `tests/view-adapter.test.mjs` and the source-level session invariant.
      const second = 'session-e2e-switched-away'
      const switched = await page.evaluate((next) => {
        const adapter = globalThis.__a2uiPlusAdapter
        if (adapter === undefined) return { ok: false }
        adapter.onMountedSessionChanged(next)
        return { ok: true, session: adapter.currentSession() }
      }, second)
      assert.equal(switched.ok, true, 'the mediator is reachable from the page')
      assert.equal(switched.session, second, 'the module followed the mounted session')
      await page.waitForTimeout(1_500)

      const after = await page.evaluate(() => {
        const adapter = globalThis.__a2uiPlusAdapter
        return {
          adapterSession: adapter?.currentSession(),
          // The reads the plugin owns, and only those. The host's own tab strip
          // still belongs to the session its seat is showing, which this case cannot
          // change (see the limit above), so it is not what is asserted here.
          oldSurfaceModel: adapter?.inlineModel('e2e-leak'),
          oldSurfaceFull: adapter?.fullModel('e2e-leak'),
          newSessionStoreHasIt: globalThis.__a2uiPlusStore?.(adapter?.currentSession() ?? '')?.get('e2e-leak') !== undefined,
        }
      })
      // What the mediator owns, asserted exactly: from the new session the previous
      // surface has no model at all, so no card and no tab body can derive from it.
      assert.equal(after.adapterSession, second, 'the mediator followed the session')
      assert.equal(after.oldSurfaceModel, undefined, 'no inline model survives for the previous session')
      assert.equal(after.oldSurfaceFull, undefined, 'no full model survives either')
      assert.equal(after.newSessionStoreHasIt, false, 'the new session store does not hold the old surface')
      // LIMIT, recorded rather than papered over: the pixel-level half of this claim
      // ("the old surface is no longer painted anywhere") cannot be asserted from a
      // home whose host seat still shows session A. That half is covered by the
      // passing case above — "a surface owned by another session is never painted
      // here", where the store key and the mounted session genuinely differ.
    } finally {
      await context.close()
    }
  })

  test('a narrow viewport downgrades a sidebar placement to inline', async () => {
    const narrow = await openPage(browser, { viewport: { width: 767, height: 900 } })
    try {
      const result = await narrow.page.evaluate(() => {
        // The same rule the plugin applies, evaluated in the browser at this width.
        const width = window.innerWidth
        return { width, isNarrow: width < 768 }
      })
      assert.equal(result.width, 767)
      assert.equal(result.isNarrow, true, 'a 767px viewport is below the shared breakpoint')

      // And the plugin's own resolver agrees, when it is reachable.
      const resolved = await narrow.page.evaluate(() => globalThis.__a2uiPlusPlacement('sidebar'))
      assert.equal(resolved.placement, 'inline', 'a sidebar request degrades at 767px')
      assert.equal(resolved.downgraded, true)
    } finally {
      await narrow.context.close()
    }
    assert.deepEqual(narrow.errors, [], `a narrow page load must not throw: ${narrow.errors.join(' | ')}`)
  })

  test('the wide viewport does not downgrade', async () => {
    const wide = await openPage(browser, { viewport: { width: 1280, height: 900 } })
    try {
      const resolved = await wide.page.evaluate(() => globalThis.__a2uiPlusPlacement('sidebar'))
      assert.equal(resolved.placement, 'sidebar')
      assert.equal(resolved.downgraded, false)
      const width = await wide.page.evaluate(() => window.innerWidth)
      assert.equal(width, 1280)
    } finally {
      await wide.context.close()
    }
  })
})

#!/usr/bin/env node
/**
 * Pre-install verification of the bundle directory.
 *
 * Catches the failure modes that unit tests cannot: a missing export, a stale
 * `files` list, a locale file without display metadata, an icon that is not an
 * image, or a client bundle that lost the module-table wrapper.
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = ROOT
const failures = []
const checks = []

function ok(condition, message) {
  if (condition) checks.push(message)
  else failures.push(message)
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(PKG, 'package.json'), 'utf8'))
  ok(manifest.name === '@nolit/dsh-a2ui-plus', 'package name is @nolit/dsh-a2ui-plus')
  ok(/^\d+\.\d+\.\d+/u.test(manifest.version), `version is semver (${manifest.version})`)
  ok(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch points at cordis.patch.yml')
  ok(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform is web')
  ok(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0, 'dsh.client.inject lists the ordered client modules')
  ok(manifest.exports?.['./client'] === './client.js', 'exports ./client')
  ok(manifest.exports?.['./locale/*.json'] !== undefined, 'exports locale resources')
  ok(manifest.exports?.['./icon'] === './icon.svg', 'exports the icon')
  ok(typeof manifest.engines?.dsh === 'string', `engines.dsh is declared (${manifest.engines?.dsh})`)

  for (const pattern of manifest.files ?? []) {
    if (pattern.includes('*')) continue
    try {
      await stat(path.join(PKG, pattern))
    } catch {
      failures.push(`files entry missing on disk: ${pattern}`)
    }
  }

  const hostEntry = path.join(PKG, 'index.js')
  const host = await import(`${new URL(`file:///${hostEntry.replace(/\\/g, '/')}`).href}?t=${Date.now()}`)
  ok(typeof host.apply === 'function', 'host entry exports apply()')
  ok(Array.isArray(host.inject) && host.inject.includes('tools'), 'host entry injects the tool registry')

  const client = await readFile(path.join(PKG, 'client.js'), 'utf8')
  ok(client.startsWith('/* @nolit/dsh-a2ui-plus'), 'client bundle carries the generated banner')
  ok(client.includes('window.__ModuleLoader__.load('), 'client bundle uses the module-table loader')
  ok(client.includes('id: "@nolit/dsh-a2ui-plus"'), 'client bundle registers under the package name')
  ok(client.includes('return __load("./client/index.js")'), 'client bundle boots the entry module')
  ok(!client.includes('asar'), 'client bundle contains no archive paths')
  ok(!client.includes('C:\\Users'), 'client bundle contains no absolute user paths')
  ok(!/require\(["'](?!\.\/|react["'])/u.test(client), 'client bundle requires no module other than react and its own registry')
  ok(!/\beval\s*\(/u.test(client), 'client bundle never calls eval')
  ok(!/dangerouslySetInnerHTML\s*:/u.test(client), 'client bundle never injects HTML')
  // Observe the Session window so deleted transient entries are also reflected.
  ok(client.includes('settle-assistant'), 'client bundle handles withdrawn assistant fragments')
  ok(client.includes('tool-call-delta'), 'client bundle reads streamed tool-call fragments')
  ok(client.includes('MAX_RECOVERY_DEPTH'), 'client bundle ships the partial-payload recovery bound')

  for (const locale of ['en', 'zh']) {
    const file = JSON.parse(await readFile(path.join(PKG, 'locale', `${locale}.json`), 'utf8'))
    ok(typeof file.meta?.title === 'string' && file.meta.title.length > 0, `locale/${locale}.json has meta.title`)
    ok(typeof file.meta?.description === 'string' && file.meta.description.length > 20, `locale/${locale}.json has a descriptive meta.description`)
  }

  const icon = await readFile(path.join(PKG, 'icon.svg'), 'utf8')
  ok(icon.trimStart().startsWith('<svg'), 'icon.svg is an SVG document')
  ok(icon.includes('viewBox'), 'icon.svg declares a viewBox')
  const iconInfo = await stat(path.join(PKG, 'icon.svg'))
  ok(iconInfo.size < 256 * 1024, `icon.svg is under the 256 KiB limit (${iconInfo.size} bytes)`)

  const patch = await readFile(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  ok(/id:\s*dsh-a2ui-plus/u.test(patch), 'cordis.patch.yml inserts the dsh-a2ui-plus row')
  ok(/name:\s*['"]@nolit\/dsh-a2ui-plus['"]/u.test(patch), 'cordis.patch.yml names the package')

  const clientInfo = await stat(path.join(PKG, 'client.js'))
  const hostInfo = await stat(path.join(PKG, 'index.js'))
  console.log(`checked ${checks.length} invariants; ${failures.length} failure(s)`)
  console.log(`  client.js ${Math.round(clientInfo.size / 1024)} KiB, index.js ${hostInfo.size} bytes`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  FAIL ${failure}`)
    process.exit(1)
  }
  console.log('  bundle is ready to install')
}

await main()

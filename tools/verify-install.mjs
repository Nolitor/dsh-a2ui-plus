import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishedFiles } from './lib/published-files.mjs'

const root = resolve(import.meta.dirname, '..')

function verifyPackage(source, read, check) {
  const manifest = read('package.json')
  if (manifest === undefined) check(false, 'package.json exists')
  else {
    const actual = JSON.parse(manifest.toString('utf8'))
    check(actual.name === source.name, `package name is ${source.name}`)
    check(actual.version === source.version, `package version is ${actual.version} (source ${source.version})`)
  }
  for (const relative of publishedFiles(root, source)) {
    if (relative === 'package.json' || !/\.(?:[cm]?js|json|ya?ml|svg)$/u.test(relative)) continue
    const actual = read(relative)
    if (actual === undefined) check(false, `package file missing: ${relative}`)
    else {
      check(readFileSync(join(root, relative)).equals(actual), `byte-identical: ${relative}`)
      if (relative === 'cordis.patch.yml') check(actual.toString('utf8').includes("id: dsh-a2ui-plus"), 'patch inserts the dsh-a2ui-plus row')
    }
  }
}

/** Check a local tarball before DSH changes an installed profile. No files are extracted to disk. */
export function verifyTarball(path) {
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const archive = resolve(path)
  const command = process.platform === 'win32' ? 'tar.exe' : 'tar'
  const exec = (args) => execFileSync(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const passes = []
  const failures = []
  const check = (ok, message) => (ok ? passes : failures).push(message)
  try {
    const entries = new Set(exec(['-tzf', archive]).toString('utf8').split(/\r?\n/u))
    verifyPackage(source, (relative) => {
      const name = `package/${relative}`
      return entries.has(name) ? exec(['-xOf', archive, name]) : undefined
    }, check)
  } catch (error) {
    failures.push(`could not verify tarball: ${error.message}`)
  }
  return { archive, passes, failures }
}

/**
 * Verify that a profile directory holds a self-consistent install of this plugin.
 *
 * Checks the profile manifest (dependency + bundle list), the installed copy's
 * manifest, every published runtime file byte-for-byte against the repository, and the
 * Cordis patch row. Importable so an isolated-home harness can reuse it.
 *
 * @param options.dshHome DSH home to inspect.
 * @param options.profile profile name inside that home.
 * @returns the passing and failing check descriptions.
 */
export function verifyInstall(options = {}) {
  const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const profile = options.profile ?? process.env.DSH_PROFILE ?? 'desktop'
  const profileDir = join(dshHome, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  const installedDir = join(profileDir, 'node_modules', sourceManifest.name)

  const failures = []
  const passes = []
  const check = (condition, message) => (condition ? passes.push(message) : failures.push(message))

  check(existsSync(manifestPath), `profile manifest exists: ${manifestPath}`)
  if (existsSync(manifestPath)) {
    const profileManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const dependency = profileManifest.dependencies?.[sourceManifest.name]
    check(typeof dependency === 'string', `dependency "${sourceManifest.name}" is present`)
    check(
      Array.isArray(profileManifest.dsh?.profile?.bundles) && profileManifest.dsh.profile.bundles.includes(sourceManifest.name),
      `bundle list contains "${sourceManifest.name}"`,
    )
  }

  check(existsSync(installedDir), `installed package exists: ${installedDir}`)
  if (existsSync(installedDir)) {
    try {
      verifyPackage(sourceManifest, (relative) => {
        const file = join(installedDir, relative)
        return existsSync(file) ? readFileSync(file) : undefined
      }, check)
    } catch (error) {
      failures.push(`could not verify installed files: ${error.message}`)
    }
  }

  return { dshHome, profile, installedDir, passes, failures, sourceManifest }
}

/** CLI entry: print the checks and exit non-zero on failure. */
function main() {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 ? args[index + 1] : fallback
  }
  const tarball = option('tarball', undefined)
  const result = tarball === undefined
    ? verifyInstall({ dshHome: option('dsh-home', undefined), profile: option('profile', undefined) })
    : verifyTarball(tarball)
  if (tarball === undefined) {
    console.log('@nolit/dsh-a2ui-plus install verification')
    console.log(`  DSH home : ${result.dshHome}`)
    console.log(`  Profile  : ${result.profile}`)
    console.log(`  Installed: ${result.installedDir}`)
  } else {
    console.log(`@nolit/dsh-a2ui-plus tarball verification: ${result.archive}`)
  }
  for (const line of result.passes) console.log(`  PASS  ${line}`)
  for (const line of result.failures) console.log(`  FAIL  ${line}`)
  if (result.failures.length > 0) {
    console.error(`\n${result.failures.length} check(s) failed.`)
    process.exit(1)
  }
  console.log(`\nAll ${result.passes.length} checks passed.`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

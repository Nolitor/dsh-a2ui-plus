#!/usr/bin/env node
/**
 * Build the installable bundle without a bundler process.
 *
 * Why not esbuild: it talks to a native service over pipes, which the DSH file
 * sandbox refuses to create (`spawn EPERM`). Everything here runs in-process:
 *
 *   1. `typescript` compiles `src/**` to ESM in memory.
 *   2. The Host half is shipped as ordinary ESM files (`lib/**`), so
 *      Node resolves its imports natively.
 *   3. The browser half is linked into ONE file (`client.js`) by a
 *      small registry linker, wrapped in the `__ModuleLoader__` factory the
 *      Harness module table expects, with `react` left external.
 *
 * The linker only needs the ESM forms this repository emits (named/namespace
 * imports, named exports); `tools/verify-bundle.mjs` fails the build if the
 * output does not expose `apply`/`inject`.
 */
import ts from 'typescript'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const BUILD = path.join(ROOT, 'build')
const ESM = path.join(BUILD, 'esm')
const PKG = ROOT
const CLIENT_ID = '@nolit/dsh-a2ui-plus'

/* ------------------------------------------------------------------ */
/* No deletion, ever                                                    */
/* ------------------------------------------------------------------ */

/**
 * Report generated files that belong to no current module instead of removing
 * them.
 *
 * This build never deletes anything: the compiler emits into memory, so there is
 * no intermediate directory to clean, and `lib/` is only ever written to. When a
 * source module disappears, its stale `lib/` copy is named here so a human can
 * remove that exact file if they want to; silently wiping a directory (even one
 * file at a time in a loop) is not this script's decision to make.
 *
 * @param folder `lib` subfolder to inspect.
 * @param expected relative ids this build produced for that folder.
 */
async function reportStale(folder, expected) {
  const dir = path.join(PKG, 'lib', folder)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const wanted = new Set(expected.map((id) => id.split('/').pop()))
  const stale = entries.filter((entry) => entry.isFile() && !wanted.has(entry.name)).map((entry) => path.join(dir, entry.name))
  if (stale.length > 0) {
    console.warn(`\nnote: ${stale.length} file(s) under lib/${folder} are not part of this build:`)
    for (const file of stale) console.warn(`  ${file}`)
    console.warn('  (left untouched; remove a specific file yourself if it is no longer wanted)')
  }
}

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.React,
  jsxFactory: 'h',
  jsxFragmentFactory: 'Fragment',
  rootDir: SRC,
  outDir: ESM,
  declaration: false,
  sourceMap: false,
  removeComments: false,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  isolatedModules: true,
  skipLibCheck: true,
  strict: false,
  noEmitOnError: false,
}

function collectSources(dir) {
  return readdir(dir, { withFileTypes: true }).then(async (entries) => {
    const out = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await collectSources(full)))
      else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) out.push(full)
    }
    return out
  })
}

/**
 * Compile `src/**` entirely in memory.
 *
 * Nothing is written to disk here, which is why the build has no cleanup step at
 * all: the emitted module map *is* this build's manifest, and every later step
 * (client link, test harness, `lib/` copy) reads from it. A leftover file on disk
 * therefore cannot leak into the output.
 *
 * @returns source file list and `Map<relativeId, emittedJs>`.
 */
async function compile() {
  const files = await collectSources(SRC)
  const program = ts.createProgram(files, COMPILER_OPTIONS)
  const outputs = new Map()
  const result = program.emit(undefined, (fileName, text) => {
    const id = path.relative(ESM, fileName).split(path.sep).join('/')
    if (!id.startsWith('..')) outputs.set(id, text)
  })
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics]
  const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const host = {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => '\n',
    }
    throw new Error(`TypeScript emitted ${errors.length} error(s):\n${ts.formatDiagnostics(errors, host)}`)
  }
  return { files, outputs }
}

/**
 * Module ids this build produced under one folder, in a stable order.
 * @param outputs the in-memory emit map.
 * @param prefix `host`, `shared` or `client`.
 */
function listOutputs(outputs, prefix) {
  return [...outputs.keys()].filter((id) => id.startsWith(`${prefix}/`) && id.endsWith('.js')).sort()
}

/* ------------------------------------------------------------------ */
/* ESM -> registry linker                                              */
/* ------------------------------------------------------------------ */

const IMPORT_FROM = /^import\s+([^;]*?)\s+from\s+(['"])([^'"]+)\2;?[ \t]*$/gm
const IMPORT_SIDE_EFFECT = /^import\s+(['"])([^'"]+)\1;?[ \t]*$/gm
const EXPORT_STAR = /^export\s+\*\s+from\s+(['"])([^'"]+)\1;?[ \t]*$/gm
const EXPORT_FROM_LIST = /^export\s*\{([^}]*)\}\s+from\s+(['"])([^'"]+)\2;?[ \t]*$/gm
const EXPORT_DECL = /^export\s+(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST = /^export\s*\{([^}]*)\};?[ \t]*$/gm

function resolveSpecifier(fromId, specifier) {
  if (!specifier.startsWith('.')) return specifier
  const base = path.posix.dirname(`/${fromId}`)
  const joint = path.posix.normalize(path.posix.join(base, specifier))
  return `.${joint}`
}

function importClauseToRequire(clause, targetId) {
  const target = JSON.stringify(targetId)
  const trimmed = clause.trim()
  if (trimmed.startsWith('* as ')) return `const ${trimmed.slice(5).trim()} = require(${target});`
  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, trimmed.lastIndexOf('}'))
    const bindings = inner
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const alias = entry.split(/\s+as\s+/u)
        return alias.length === 2 ? `${alias[0].trim()}: ${alias[1].trim()}` : entry
      })
    return `const { ${bindings.join(', ')} } = require(${target});`
  }
  return `const ${trimmed} = require(${target});`
}

function linkModule(id, source) {
  const exported = new Set()
  const aliases = []
  let body = source

  body = body.replace(IMPORT_FROM, (_match, clause, _quote, specifier) =>
    importClauseToRequire(clause, resolveSpecifier(id, specifier)),
  )
  body = body.replace(IMPORT_SIDE_EFFECT, (_match, _quote, specifier) =>
    `require(${JSON.stringify(resolveSpecifier(id, specifier))});`,
  )
  body = body.replace(EXPORT_STAR, (_match, _quote, specifier) =>
    `Object.assign(exports, require(${JSON.stringify(resolveSpecifier(id, specifier))}));`,
  )
  // `export { a, b as c } from './x.js'`
  body = body.replace(EXPORT_FROM_LIST, (_match, inner, _quote, specifier) => {
    const target = JSON.stringify(resolveSpecifier(id, specifier))
    const statements = inner
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const alias = entry.split(/\s+as\s+/u)
        const local = alias[0].trim()
        const exported = (alias[1] ?? alias[0]).trim()
        return `exports[${JSON.stringify(exported)}] = __reexport[${JSON.stringify(local)}];`
      })
    return `{ const __reexport = require(${target}); ${statements.join(' ')} }`
  })
  body = body.replace(EXPORT_DECL, (_match, kind, name) => {
    exported.add(name)
    return `${kind} ${name}`
  })
  body = body.replace(EXPORT_LIST, (_match, inner) => {
    for (const entry of inner.split(',')) {
      const trimmed = entry.trim()
      if (trimmed === '') continue
      const alias = trimmed.split(/\s+as\s+/u)
      if (alias.length === 2) {
        const local = alias[0].trim()
        const name = alias[1].trim()
        exported.add(name)
        aliases.push(`${name} = ${local}`)
      } else {
        exported.add(trimmed)
      }
    }
    return ''
  })
  if (/\bexport\s+default\b/u.test(body)) throw new Error(`${id}: default exports are not supported by the linker`)

  const tail = []
  for (const alias of aliases) {
    const [name, local] = alias.split(' = ')
    tail.push(`exports[${JSON.stringify(name)}] = ${local};`)
  }
  for (const name of exported) if (!aliases.some((alias) => alias.startsWith(`${name} =`))) tail.push(`exports[${JSON.stringify(name)}] = ${name};`)

  return `${body}\n${tail.join('\n')}`
}

async function buildClient(outputs) {
  const ids = [...listOutputs(outputs, 'shared'), ...listOutputs(outputs, 'client')]
  const modules = new Map()
  const dependencies = new Map()
  for (const id of ids) {
    const source = outputs.get(id)
    modules.set(`./${id}`, linkModule(`./${id}`, source))
    const specs = new Set()
    for (const match of source.matchAll(/^\s*import\s+(?:[^;]*?\s+from\s+)?(['"])([^'"]+)\1/gmu)) {
      const resolved = resolveSpecifier(`./${id}`, match[2])
      if (resolved.startsWith('.')) specs.add(resolved)
    }
    dependencies.set(`./${id}`, [...specs])
  }

  // Topological order so a module's dependencies initialize first.
  const order = []
  const state = new Map()
  const visit = (id) => {
    const status = state.get(id)
    if (status === 'done') return
    if (status === 'visiting') throw new Error(`circular client import involving ${id}`)
    state.set(id, 'visiting')
    for (const dependency of dependencies.get(id) ?? []) {
      if (modules.has(dependency)) visit(dependency)
      else if (dependency.startsWith('.')) throw new Error(`unresolved client import ${dependency} from ${id}`)
    }
    state.set(id, 'done')
    order.push(id)
  }
  visit('./client/index.js')

  const chunks = []
  chunks.push(`window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_ID)},
  factory(require) {
    "use strict";
    var __cache = {};
    var __registry = {};
    function __load(id) {
      var hit = __cache[id];
      if (hit !== undefined) return hit.exports;
      var factory = __registry[id];
      if (factory === undefined) throw new Error("@nolit/dsh-a2ui-plus: unknown module " + id);
      var module = { exports: {} };
      __cache[id] = module;
      factory(module, module.exports, __require);
      return module.exports;
    }
    function __require(specifier) {
      return specifier.charAt(0) === "." ? __load(specifier) : require(specifier);
    }
`)
  for (const id of order) {
    chunks.push(`__registry[${JSON.stringify(id)}] = function(module, exports, require) {\n${modules.get(id)}\n};`)
  }
  chunks.push(`    return __load("./client/index.js");`)
  chunks.push(`  },`)
  chunks.push(`});`)
  // Strip trailing spaces: the emit can leave them at line ends, and the
  // generated bundle is committed, so `git diff --check` must stay clean.
  const output = `/* @nolit/dsh-a2ui-plus — generated by tools/build.mjs. Do not edit. */\n${chunks.join('\n').replace(/[ \t]+$/gmu, '')}\n`
  await writeFile(path.join(PKG, 'client.js'), output, 'utf8')
  return output.length
}

async function buildHost(outputs) {
  const ids = [...listOutputs(outputs, 'host'), ...listOutputs(outputs, 'shared')]
  for (const id of ids) await writeEmitted(outputs, id)
  await reportStale('host', listOutputs(outputs, 'host'))
  await reportStale('shared', listOutputs(outputs, 'shared'))
  await writeFile(
    path.join(PKG, 'index.js'),
    `/* @nolit/dsh-a2ui-plus — generated by tools/build.mjs. Do not edit. */
export { apply, inject, name } from './lib/host/index.js'
`,
    'utf8',
  )
  return ids.length
}

/**
 * Write one emitted module to its runtime path (`lib/<id>`), creating only the
 * directories that are missing.
 */
async function writeEmitted(outputs, id) {
  const source = outputs.get(id)
  const target = path.join(PKG, 'lib', ...id.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, source, 'utf8')
}

async function buildSharedForTests(outputs) {
  const target = path.join(BUILD, 'shared.mjs')
  await mkdir(BUILD, { recursive: true })
  const ids = [...listOutputs(outputs, 'shared'), ...listOutputs(outputs, 'client')]
  const modules = new Map()
  for (const id of ids) modules.set(`./${id}`, linkModule(`./${id}`, outputs.get(id)))
  const chunks = [
    `/* @nolit/dsh-a2ui-plus — generated by tools/build.mjs. Do not edit. */`,
    `import * as React from 'react';`,
    `var __cache = {}; var __registry = {};`,
    `function __load(id) { var hit = __cache[id]; if (hit !== undefined) return hit.exports; var f = __registry[id]; if (f === undefined) throw new Error("unknown module " + id); var m = { exports: {} }; __cache[id] = m; f(m, m.exports, __require); return m.exports; }`,
    `function __require(specifier) { return specifier === "react" ? React : __load(specifier); }`,
  ]
  for (const [id, source] of modules) chunks.push(`__registry[${JSON.stringify(id)}] = function(module, exports, require) {\n${source}\n};`)
  chunks.push(`export const shared = __load("./shared/index.js");`)
  chunks.push(`export const client = Object.fromEntries(["action", "charts", "claims", "datetime", "stream-store", "surfaces", "surface-store", "socket", "tabs", "executor", "view-adapter"].map(name => [name, __load("./client/" + name + ".js")]));`)
  // Flat re-export so a test reads `shared.ClientSurfaceStore`, not a nested path.
  chunks.push(`export const ClientSurfaceStore = client["surface-store"].ClientSurfaceStore;`)
  chunks.push(`export const applyOperation = client["surface-store"].applyOperation;`)
  chunks.push(`export const effectivePlacement = client["surface-store"].effectivePlacement;`)
  chunks.push(`export const isNarrowWidth = client["surface-store"].isNarrowWidth;`)
  chunks.push(`export const escapePointer = client["surface-store"].escapePointer;`)
  chunks.push(`export const segmentsOf = client["surface-store"].segmentsOf;`)
  chunks.push(`export const DownlinkClient = client["socket"].DownlinkClient;`)
  chunks.push(`export const downlinkUrl = client["socket"].downlinkUrl;`)
  for (const name of ["TabRouter", "TAB_ID", "TAB_ID_PREFIX", "TAB_MAP_KEY", "TAB_EPOCH_KEY", "tabIdOf", "isSurfaceTabId", "surfaceIdOf", "tabMapStorage", "makeTabBody", "surfaceIdOfTab"]) chunks.push(`export const ${name} = client["tabs"].${name};`)
  for (const name of ["RendererExecutor", "EXECUTABLE", "admitHttpsUrl", "admitFilename", "checkExecutableArguments", "isExecutable", "requiresGesture", "MAX_URL_LENGTH", "MAX_TEXT_LENGTH"]) chunks.push(`export const ${name} = client["executor"].${name};`)
  for (const name of ["ViewAdapter", "inlineModelOf", "summaryOf", "ACTION_DEDUPE_MS", "INLINE_ROW_LIMIT"]) chunks.push(`export const ${name} = client["view-adapter"].${name};`)
  await writeFile(target, `${chunks.join('\n')}\n`, 'utf8')
}

async function main() {
  const started = Date.now()
  const { files, outputs } = await compile()
  const clientBytes = await buildClient(outputs)
  const hostFiles = await buildHost(outputs)
  await buildSharedForTests(outputs)
  console.log(`built ${files.length} TypeScript modules in ${Date.now() - started} ms`)
  console.log(`  index.js  (host ESM entry)`)
  console.log(`  lib/**    (${hostFiles} generated modules written in place)`)
  console.log(`  client.js (${Math.round(clientBytes / 1024)} KiB browser bundle)`)
  console.log(`  build/shared.mjs  (test harness)`)
  console.log('  no files were deleted: this build only writes, and reports stale lib/ files by name')
}

await main()

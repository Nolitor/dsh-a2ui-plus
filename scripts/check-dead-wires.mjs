#!/usr/bin/env node
/**
 * Dead-wire gate: every hook on the client runtime surface must have a reader.
 *
 * Why this exists. Three separate defects in this plugin had the same shape: a
 * function was declared, exported, assigned — and never called. `registerTab`
 * probed once and gave up; `openSurfaceTab` had no caller; `connectDownlink` had
 * no caller. Unit tests passed throughout, because a test can call anything. Only
 * a live browser showed the wiring was absent.
 *
 * A reader here means a use of `runtime.<name>` or a destructuring of it from a
 * runtime object **outside the assignment line in the plugin entry**. That
 * excludes the assignment itself, which is what made the earlier hand-written
 * grep look green while four hooks were dead.
 *
 * Usage:
 *   node scripts/check-dead-wires.mjs            # report and exit 1 on a dead wire
 *   node scripts/check-dead-wires.mjs --quiet    # exit code only
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const ENTRY = path.join(SRC, 'client', 'index.ts')
const CONTRACT = path.join(SRC, 'client', 'tool-view.tsx')

/**
 * Every runtime member declared on the contract interface.
 * @param source the contract file's text.
 * @returns the member names, in declaration order.
 */
function declaredMembers(source) {
  const block = /export interface ClientRuntime \{([\s\S]*?)\n\}/u.exec(source)
  if (block === null) throw new Error('ClientRuntime interface not found in the contract file')
  return [...block[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??:/gmu)].map((match) => match[1])
}

/** Every `.ts`/`.tsx` file under `src`. */
async function sourceFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)))
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Lines that actually consume a runtime member.
 *
 * An assignment (`runtime.foo = …`) is not a use: that is the definition the gate
 * exists to check. A read on the same line as an assignment is also skipped, so
 * `runtime.foo = (…) => runtime.foo(…)` cannot launder itself green.
 * @param name the member to look for.
 * @param files the collected sources.
 */
function readers(name, files) {
  const sites = []
  for (const file of files) {
    const text = file.text
    const isEntry = file.path === ENTRY
    for (const match of text.matchAll(new RegExp(`\\bruntime\\s*\\.\\s*${name}\\b`, 'gu'))) {
      const line = text.slice(0, match.index).split('\n').length
      const lineText = text.split('\n')[line - 1] ?? ''
      const isAssignment = new RegExp(`runtime\\s*\\.\\s*${name}\\s*=`, 'u').test(lineText)
      if (isEntry && isAssignment) continue
      sites.push(`${path.relative(ROOT, file.path)}:${line}`)
    }
    // `const { a, b } = runtime` also counts as a read.
    for (const match of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*[^;\n]*\bruntime\b/gu)) {
      if (new RegExp(`\\b${name}\\b`, 'u').test(match[1])) {
        const line = text.slice(0, match.index).split('\n').length
        sites.push(`${path.relative(ROOT, file.path)}:${line} (destructured)`)
      }
    }
  }
  return sites
}

/**
 * Members assigned by the entry but never read anywhere.
 * @returns `{ name, assignedAt, readers }` per dead wire.
 */
export async function findDeadWires() {
  const contract = await readFile(CONTRACT, 'utf8')
  const entry = await readFile(ENTRY, 'utf8')
  const files = await Promise.all(
    (await sourceFiles(SRC)).map(async (file) => ({ path: file, text: await readFile(file, 'utf8') })),
  )
  const declared = declaredMembers(contract)
  // A hook the entry assigns but the contract never declares is just as dead: the
  // view cannot type it, so nothing can read it. Checking only the interface let
  // exactly that regression through once already.
  const assigned = [...entry.matchAll(/runtime\s*\.\s*([A-Za-z][A-Za-z0-9]*)\s*=/gu)].map((match) => match[1])
  const members = [...new Set([...declared, ...assigned])]
  const dead = []
  for (const name of members) {
    const assignedInEntry = new RegExp(`runtime\\s*\\.\\s*${name}\\s*=`, 'u').test(entry)
    const declaredInContract = declared.includes(name)
    const found = readers(name, files)
    if (found.length === 0) {
      dead.push({ name, assignedInEntry, declaredInContract, readers: [] })
    } else if (assignedInEntry && !declaredInContract) {
      // Read somewhere but not part of the contract: a hook the view cannot see.
      dead.push({ name, assignedInEntry, declaredInContract, readers: found, undeclared: true })
    }
  }
  return { members, dead }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const quiet = process.argv.includes('--quiet')
  const { members, dead } = await findDeadWires()
  if (!quiet) {
    console.log(`checked ${members.length} client runtime member(s)`)
    for (const member of members) {
      const isDead = dead.some((entry) => entry.name === member)
      if (!isDead) continue
    }
  }
  if (dead.length > 0) {
    console.error(`FAIL: ${dead.length} dead wire(s) — reachable from no entry point:`)
    for (const entry of dead) {
      const why = entry.undeclared
        ? ' (assigned and read, but missing from ClientRuntime — the view cannot type it)'
        : entry.assignedInEntry
          ? ' (assigned in the entry, no reader anywhere)'
          : ' (declared on ClientRuntime, assigned nowhere)'
      console.error(`  ${entry.name}${why}`)
    }
    console.error('A hook nobody reads is a feature nobody wired. Either call it from the view that needs it, or delete it.')
    process.exit(1)
  }
  if (!quiet) console.log('every client runtime member has a reader')
}

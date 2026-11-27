#!/usr/bin/env node
/**
 * In-process test runner.
 *
 * `node --test tests/` spawns one child process per file, which the DSH Windows
 * sandbox refuses (`spawn EPERM`). Importing the files into this process runs
 * the same `node:test` suites without spawning anything, and still prints the
 * TAP summary and exits non-zero on failure.
 *
 * @example node tools/run-tests.mjs dom
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(ROOT, 'tests')
const filter = process.argv[2]
const files = (await readdir(dir))
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filter === undefined || name.includes(filter))
  .sort()

for (const file of files) {
  await import(new URL(`../tests/${file}`, import.meta.url))
}
console.log(`\nloaded ${files.length} test file(s): ${files.join(', ')}`)

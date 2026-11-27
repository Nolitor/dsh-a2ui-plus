#!/usr/bin/env node
/**
 * Download the pinned upstream A2UI fixtures into `tests/fixtures/examples/`.
 *
 * The catalog examples are the compatibility baseline this plugin is measured
 * against, so they live in the repository rather than being fetched at test
 * time. Pinned to the commit named in the delivery notes.
 *
 * Usage: node tools/fetch-fixtures.mjs [--spec-section]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT = '58379ad4c7b23289992acea44e99126374e41063'
const REPO = 'a2ui-project/a2ui'
const EXAMPLES = path.join(ROOT, 'tests', 'fixtures', 'examples')
const SPEC_DOC = 'specification/v1_0/docs/a2ui_protocol.md'

async function listExamples() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/contents/catalogs/basic/v1/examples?ref=${COMMIT}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-a2ui-fixtures' },
  })
  if (!response.ok) throw new Error(`listing failed: ${response.status}`)
  const entries = await response.json()
  return entries.filter((entry) => entry.type === 'file' && entry.name.endsWith('.json')).map((entry) => entry.name)
}

async function main() {
  if (process.argv.includes('--spec-section')) {
    const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/${SPEC_DOC}`)
    const text = await response.text()
    const start = text.indexOf('Regex Safety')
    const from = start < 0 ? text.indexOf('regex-safety-check') : start
    console.log(text.slice(Math.max(0, from - 200), from + 3_500))
    return
  }

  const names = await listExamples()
  await mkdir(EXAMPLES, { recursive: true })
  let downloaded = 0
  for (const name of names) {
    const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${COMMIT}/catalogs/basic/v1/examples/${name}`)
    if (!response.ok) {
      console.error(`skip ${name}: ${response.status}`)
      continue
    }
    const text = await response.text()
    await writeFile(path.join(EXAMPLES, name), text, 'utf8')
    downloaded += 1
  }
  console.log(`downloaded ${downloaded}/${names.length} examples into tests/fixtures/examples`)
}

await main()

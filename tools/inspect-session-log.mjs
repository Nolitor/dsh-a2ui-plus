#!/usr/bin/env node
/**
 * Report the durable replay copy of every `a2ui` tool call in this workspace's
 * newest session logs.
 *
 * Read-only: the logs live outside the workspace and nothing is written.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = 'C:\\Users\\ChimeSky\\.dsh\\sessions'
const workspace = '--C-Users-ChimeSky-Desktop-DSH-plugins-a2ui--'

/** Decode an append-only zstd log (one frame per flush). */
function decodeLog(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let cursor = buffer.indexOf(magic)
  while (cursor >= 0) {
    starts.push(cursor)
    cursor = buffer.indexOf(magic, cursor + 4)
  }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buffer).toString('utf8')
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8'))
    } catch {
      /* partial trailing frame while the session is still writing */
    }
  }
  return parts.join('')
}

const dir = path.join(SESSIONS, workspace)
const files = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(dir, entry.name, 'session.v4.jsonl.zstd'))
  .filter((file) => fs.existsSync(file))
  .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

let found = 0
for (const candidate of files.slice(0, 4)) {
  const events = decodeLog(fs.readFileSync(candidate.file))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)

  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call' && (event.data?.name === 'a2ui' || event.data?.name === 'a2ui_catalog')) {
      calls.set(event.data.callId, event.data.name)
    }
  }
  if (calls.size === 0) continue

  console.log(`\n${path.basename(path.dirname(candidate.file))}  (${events.length} events)`)
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (!calls.has(callId)) continue
    found += 1
    const meta = event.data?.meta
    const content = (event.data?.message?.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
    console.log(`  ${calls.get(callId)} (call ${callId}, seq ${event.seq})`)
    console.log(`    content: ${content.split('\n')[0].slice(0, 120)}`)
    console.log(`    meta.kind=${meta?.kind} title=${JSON.stringify(meta?.title)} surfaces=${Array.isArray(meta?.surfaces) ? meta.surfaces.length : 0} replayCopy=${Array.isArray(meta?.messages) ? `${meta.messages.length} message(s)` : meta?.messagesOmitted === true ? 'omitted' : 'none'}`)
    if (Array.isArray(meta?.messages)) {
      const first = meta.messages[0] ?? {}
      const surface = first.createSurface ?? first.updateComponents ?? {}
      console.log(`    replay payload: version=${first.version} surfaceId=${surface.surfaceId} components=${surface.components?.length ?? '-'} catalogId=${surface.catalogId ?? '-'}`)
    }
  }
}

if (found === 0) {
  console.log('no a2ui tool results found in the newest session logs')
  process.exit(1)
}

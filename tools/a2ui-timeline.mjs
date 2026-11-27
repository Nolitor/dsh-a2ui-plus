#!/usr/bin/env node
/**
 * Timeline of `a2ui` activity across recent sessions.
 *
 * Prints, per session: each `a2ui` tool call with the message kinds and surface
 * ids it carried, plus every `[A2UI action]` user message, so a "the card
 * vanished after I clicked" report can be traced to the actual payloads.
 *
 * Read-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = 'C:\\Users\\ChimeSky\\.dsh\\sessions'

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
      /* partial trailing frame */
    }
  }
  return parts.join('')
}

function collectLogs(root) {
  const out = []
  for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const dir = path.join(root, workspace.name)
    for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = path.join(dir, session.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      out.push({ workspace: workspace.name, session: session.name, file, mtime: fs.statSync(file).mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function summarizeCall(args) {
  let parsed
  try {
    parsed = JSON.parse(args)
  } catch {
    return { error: 'unparseable arguments' }
  }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
  return {
    title: parsed?.title,
    kinds: messages.map((message) => {
      const key = Object.keys(message).find((name) => name !== 'version')
      const payload = message[key] ?? {}
      return `${key}(${payload.surfaceId ?? '?'}${payload.components ? `,${payload.components.length}c` : ''})`
    }),
  }
}

const logs = collectLogs(SESSIONS)
let printed = 0

for (const log of logs.slice(0, 12)) {
  const events = decodeLog(fs.readFileSync(log.file))
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
  const lines = []
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.name === 'a2ui') {
      const summary = summarizeCall(event.data.arguments ?? '')
      calls.set(event.data.callId, summary)
      lines.push(`  call   seq=${event.seq} ${summary.title ?? ''} :: ${(summary.kinds ?? []).join(' + ') || summary.error}`)
    }
    if (event.type === 'user/message') {
      const text = (event.data?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
      if (text.includes('[A2UI action]')) {
        const match = text.match(/\{"version":"1.0","action":([\s\S]*?)\}\s*$/u)
        lines.push(`  ACTION seq=${event.seq} ${match ? match[0].slice(0, 320) : text.slice(0, 200)}`)
      }
    }
  }
  if (lines.length === 0) continue
  printed += 1
  console.log(`\n=== ${log.workspace}/${log.session} (${events.length} events) ===`)
  console.log(lines.join('\n'))
  if (printed >= 4) break
}

if (printed === 0) console.log('no a2ui activity found')

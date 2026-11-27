#!/usr/bin/env node
/**
 * Print the event window around one session's `[A2UI action]` message so a
 * "card vanished after I clicked" report can be traced to real turn boundaries.
 *
 * Read-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const FILE = path.join(
  'C:\\Users\\ChimeSky\\.dsh\\sessions',
  '--C-Users-ChimeSky-Desktop-DSH-Chat--',
  'session-67a4e997-7423-422a-8ddd-cde707492792',
  'session.v4.jsonl.zstd',
)

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

const events = decodeLog(fs.readFileSync(FILE))
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

const from = Number(process.argv[2] ?? 390)
const to = Number(process.argv[3] ?? 470)

for (const event of events) {
  if (event.seq < from || event.seq > to) continue
  const data = event.data ?? {}
  let detail = ''
  if (event.type === 'assistant/message') {
    const text = (data.content ?? data.message?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
    detail = text.slice(0, 120)
  } else if (event.type === 'tool/call') {
    detail = `${data.name} ${String(data.arguments ?? '').slice(0, 90)}`
  } else if (event.type === 'tool/result') {
    detail = `${data.message?.source?.callId ?? ''} isError=${data.message?.isError} metaKind=${data.meta?.kind ?? '-'}`
  } else if (event.type === 'user/message') {
    detail = (data.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ').slice(0, 120)
  } else if (event.type.startsWith('turn/')) {
    detail = JSON.stringify(data).slice(0, 120)
  } else if (event.type === 'assistant/attempt') {
    detail = JSON.stringify(data).slice(0, 140)
  }
  console.log(`${String(event.seq).padStart(5)}  ${event.type.padEnd(22)} ${detail}`)
}

#!/usr/bin/env node
/** Dump the shape of the newest session log: event types and one sample per type. */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dir = path.join('C:\\Users\\ChimeSky\\.dsh\\sessions', '--C-Users-ChimeSky-Desktop-DSH-plugins-a2ui--')
const files = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(dir, entry.name, 'session.v4.jsonl.zstd'))
  .filter((file) => fs.existsSync(file))
  .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

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

const target = files[0]
const events = decodeLog(fs.readFileSync(target.file))
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

const types = new Map()
for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1)
console.log('event types:', [...types.entries()].map(([type, count]) => `${type}×${count}`).join(', '))

for (const event of events) {
  if (event.type === 'tool/result' && JSON.stringify(event).includes('a2ui')) {
    console.log('\nfound tool/result containing "a2ui":')
    console.log(JSON.stringify(event).slice(0, 1200))
  }
}

const callEvent = events.find((event) => event.type === 'tool/call' && JSON.stringify(event).includes('a2ui'))
if (callEvent !== undefined) {
  console.log('\nfound tool/call for a2ui:')
  console.log(JSON.stringify(callEvent).slice(0, 700))
}

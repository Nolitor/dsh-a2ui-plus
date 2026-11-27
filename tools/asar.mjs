#!/usr/bin/env node
/**
 * Minimal Electron ASAR reader used for read-only research of the installed
 * DeepSeek Harness package tree (app.asar). Nothing here writes to the archive.
 *
 * Usage:
 *   node tools/asar.mjs list  <archive> [filter]        -> print matching paths
 *   node tools/asar.mjs read  <archive> <innerPath>     -> print one file
 *   node tools/asar.mjs extract <archive> <innerPath> <outFile>
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function openArchive(archive) {
  const fd = fs.openSync(archive, 'r')
  const head = Buffer.alloc(8)
  fs.readSync(fd, head, 0, 8, 0)
  const headerPickleSize = head.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerPickleSize)
  fs.readSync(fd, headerBuf, 0, headerPickleSize, 8)
  const jsonLength = headerBuf.readUInt32LE(4)
  const json = headerBuf.toString('utf8', 8, 8 + jsonLength)
  const header = JSON.parse(json)
  const baseOffset = 8 + headerPickleSize
  return { fd, header, baseOffset }
}

function walk(node, prefix, out) {
  if (node == null) return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix === '' ? name : `${prefix}/${name}`, out)
    }
    return
  }
  if (node.link !== undefined) {
    out.push({ path: prefix, link: node.link })
    return
  }
  if (node.offset !== undefined) {
    out.push({ path: prefix, offset: Number(node.offset), size: node.size, unpacked: node.unpacked === true })
  }
}

function list(fd, header, baseOffset, filter) {
  const entries = []
  walk(header, '', entries)
  const needle = filter ? filter.toLowerCase() : null
  return entries.filter((e) => !needle || e.path.toLowerCase().includes(needle))
}

const [cmd, archive, a, b] = process.argv.slice(2)
if (!cmd || !archive) {
  console.error('usage: asar.mjs <list|read|extract> <archive> [args]')
  process.exit(2)
}
const { fd, header, baseOffset } = openArchive(archive)

if (cmd === 'tree') {
  // Extract every file under prefix `a` into directory `b`.
  const prefix = a.replace(/\\/g, '/')
  const outDir = b
  let count = 0
  for (const entry of list(fd, header, baseOffset, null)) {
    if (entry.link !== undefined) continue
    if (entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) continue
    const rel = entry.path.slice(prefix.length + 1)
    if (rel === '' ) continue
    let data
    if (entry.unpacked) {
      data = fs.readFileSync(path.join(`${archive}.unpacked`, ...entry.path.split('/')))
    } else {
      data = Buffer.alloc(entry.size)
      fs.readSync(fd, data, 0, entry.size, baseOffset + entry.offset)
    }
    const target = path.join(outDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    count += 1
  }
  console.log(`extracted ${count} files from ${prefix} -> ${outDir}`)
  process.exit(0)
}

if (cmd === 'list') {
  const entries = list(fd, header, baseOffset, a)
  for (const e of entries) {
    if (e.link) console.log(`L ${e.path} -> ${e.link}`)
    else console.log(`${e.unpacked ? 'U' : 'F'} ${e.path}`)
  }
} else {
  const inner = a.replace(/\\/g, '/')
  const entries = list(fd, header, baseOffset, null)
  const entry = entries.find((e) => e.path === inner)
  if (!entry) {
    console.error('not found:', inner)
    process.exit(1)
  }
  let data
  if (entry.unpacked) {
    const unpackedRoot = `${archive}.unpacked`
    data = fs.readFileSync(path.join(unpackedRoot, ...inner.split('/')))
  } else {
    data = Buffer.alloc(entry.size)
    fs.readSync(fd, data, 0, entry.size, baseOffset + entry.offset)
  }
  if (cmd === 'read') process.stdout.write(data)
  else if (cmd === 'extract') {
    fs.mkdirSync(path.dirname(b), { recursive: true })
    fs.writeFileSync(b, data)
    console.log(`wrote ${b} (${data.length} bytes)`)
  } else {
    console.error('unknown command', cmd)
    process.exit(2)
  }
}

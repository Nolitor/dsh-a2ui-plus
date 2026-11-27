import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Expand the literals and suffix globs used by package.json's files list. */
export function publishedFiles(root, manifest) {
  const files = new Set(['package.json'])
  const walk = (dir, suffix, recursive) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`
      if (entry.isDirectory() && recursive) walk(name, suffix, true)
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.add(name)
    }
  }
  for (const pattern of manifest.files) {
    const mapping = /^([^*]+)\/(\*\*\/)?\*(\.[^/*]+)$/u.exec(pattern)
    if (mapping) walk(mapping[1], mapping[3], mapping[2] !== undefined)
    else if (pattern.includes('*')) throw new Error(`Unsupported files pattern: ${pattern}`)
    else files.add(pattern)
  }
  return [...files].sort()
}

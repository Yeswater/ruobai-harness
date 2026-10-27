import { describe, expect, it } from 'vitest'
import { unzipEntries } from '../src/index.ts'

/** Build a stored (method 0) zip; the reader ignores CRC, so zero is enough. */
function makeZip(files: Record<string, string>, external: Record<string, number> = {}) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const full = Buffer.concat([local, nameBuf, data])
    locals.push(full)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE((external[name] ?? 0) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([entry, nameBuf]))
    offset += full.length
  }

  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

describe('skill package zip reader', () => {
  it('reads nested files', () => {
    const archive = makeZip({
      'SKILL.md': '# skill',
      'scripts/run.sh': 'echo hi',
    })
    expect(unzipEntries(archive).map(entry => entry.name)).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(unzipEntries(archive)[1]!.data.toString()).toBe('echo hi')
  })

  it('rejects paths that escape the package root', () => {
    expect(() => unzipEntries(makeZip({ '../evil.sh': 'x' }))).toThrow(/unsafe path/)
    expect(() => unzipEntries(makeZip({ '/etc/passwd': 'x' }))).toThrow(/unsafe path/)
  })

  it('rejects symlink entries', () => {
    const symlink = 0o120777 << 16
    expect(() => unzipEntries(makeZip({ 'link': 'target' }, { link: symlink }))).toThrow(/symlinks/)
  })
})

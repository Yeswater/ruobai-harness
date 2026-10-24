import { describe, expect, it } from 'vitest'
import {
  filesToAttachments, folderManifest, formatBytes, MAX_ATTACHMENTS,
} from '../src/attachments.ts'

function file(content: string, name: string, type = 'text/plain') {
  return new File([content], name, { type })
}

function asFileList(files: File[]) {
  const list = files as unknown as FileList
  Object.defineProperty(list, 'item', { value: (index: number) => files[index] ?? null })
  return list
}

describe('composer attachments', () => {
  it('converts text files with size limits', async () => {
    const [attachment] = await filesToAttachments([file('hello', 'a.txt')])
    expect(attachment).toMatchObject({
      kind: 'file',
      name: 'a.txt',
      mime: 'text/plain',
      text: 'hello',
      size: 5,
    })
  })

  it('rejects unsupported binaries and too many attachments', async () => {
    await expect(filesToAttachments([file('x', 'a.bin', 'application/zip')])).rejects.toThrow('不支持的文件类型')
    await expect(filesToAttachments(
      Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => file('x', `${index}.txt`)),
    )).rejects.toThrow(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
  })

  it('builds a bounded folder manifest', () => {
    const first = file('a', 'a.txt')
    Object.defineProperty(first, 'webkitRelativePath', { value: 'project/a.txt' })
    const second = file('b', 'b.txt')
    Object.defineProperty(second, 'webkitRelativePath', { value: 'project/sub/b.txt' })
    const manifest = folderManifest(asFileList([first, second]))
    expect(manifest.name).toBe('project.manifest.txt')
    expect(manifest.text).toContain('project/a.txt')
    expect(manifest.text).toContain('project/sub/b.txt')
    expect(manifest.size).toBeGreaterThan(0)
  })

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})

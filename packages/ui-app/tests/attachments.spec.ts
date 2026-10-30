import { describe, expect, it } from 'vitest'
import {
  filesToAttachments, formatBytes, MAX_ATTACHMENTS,
} from '../src/attachments.ts'

function file(content: string, name: string, type = 'text/plain') {
  return new File([content], name, { type })
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

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })
})

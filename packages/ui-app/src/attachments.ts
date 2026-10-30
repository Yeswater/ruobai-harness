import type { AttachmentMeta } from '@ruobai/chat-protocol'

export const MAX_ATTACHMENTS = 20
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_BYTES = 1 * 1024 * 1024
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'jsonl', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'html',
  'yml', 'yaml', 'toml', 'xml', 'csv', 'py', 'go', 'rs', 'java', 'kt', 'sh', 'sql',
])

export function formatBytes(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function extension(name: string) {
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error(`读取 ${file.name} 失败`))
    reader.readAsDataURL(file)
  })
}

export function attachmentSize(attachment: AttachmentMeta) {
  return attachment.size
}

export function totalSize(attachments: AttachmentMeta[]) {
  return attachments.reduce((sum, item) => sum + item.size, 0)
}

export async function fileToAttachment(file: File): Promise<AttachmentMeta> {
  const mime = (file.type || '').toLowerCase()
  if (IMAGE_MIMES.has(mime)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`图片 ${file.name} 超过 5 MB`)
    const data = await readBase64(file)
    return { id: newId(), kind: 'image', name: file.name, mime, size: file.size, data }
  }
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(extension(file.name))) {
    if (file.size > MAX_TEXT_BYTES) throw new Error(`文件 ${file.name} 超过 1 MB`)
    const text = await file.text()
    if (text.includes('\0')) throw new Error(`文件 ${file.name} 是二进制内容`)
    return { id: newId(), kind: 'file', name: file.name, mime: mime || 'text/plain', size: file.size, text }
  }
  throw new Error(`不支持的文件类型：${file.name}`)
}

/** Convert browser files, enforcing the same caps the server applies. */
export async function filesToAttachments(
  files: Iterable<File>,
  existing: AttachmentMeta[] = [],
): Promise<AttachmentMeta[]> {
  const list = [...files]
  if (!list.length) return []
  if (existing.length + list.length > MAX_ATTACHMENTS) {
    throw new Error(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
  }
  const converted: AttachmentMeta[] = []
  let total = totalSize(existing)
  for (const file of list) {
    const attachment = await fileToAttachment(file)
    total += attachment.size
    if (total > MAX_TOTAL_BYTES) throw new Error('附件总大小超过 25 MB')
    converted.push(attachment)
  }
  return converted
}

import { randomUUID } from 'node:crypto'
import type { AttachmentMeta } from '@ruobai/chat-protocol'
import { HttpError } from '@ruobai/web-server'

export const MAX_ATTACHMENTS = 20
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_BYTES = 1 * 1024 * 1024
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024
/** Attachment messages are JSON with base64 payloads, so they need more room. */
export const MAX_MESSAGE_BODY_BYTES = 40 * 1024 * 1024

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'jsonl', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'html',
  'yml', 'yaml', 'toml', 'xml', 'csv', 'py', 'go', 'rs', 'java', 'kt', 'sh', 'sql',
])
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'])

function fail(message: string, status = 400): never {
  throw new HttpError(status, message)
}

function cleanName(value: unknown, fallback: string) {
  const name = typeof value === 'string' ? value : fallback
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/["'`]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 200)
  return cleaned || fallback
}

function extension(name: string) {
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value) fail('attachment data is required')
  const raw = value.replace(/^data:[^;]+;base64,/, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    fail('attachment data is not valid base64')
  }
  return Buffer.from(raw, 'base64')
}

function textOf(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text
  if (typeof item.data === 'string') return decodeBase64(item.data).toString('utf8')
  fail('text attachment content is required')
}

/** Validate and normalize the browser's attachment draft list. */
export function normalizeAttachments(input: unknown): AttachmentMeta[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) fail('attachments must be an array')
  if (input.length > MAX_ATTACHMENTS) fail(`at most ${MAX_ATTACHMENTS} attachments are allowed`, 413)

  const attachments: AttachmentMeta[] = []
  let total = 0

  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object') fail(`attachment ${index + 1} is invalid`)
    const item = raw as Record<string, unknown>
    const mime = typeof item.mime === 'string' ? item.mime.trim().toLowerCase() : ''
    const name = cleanName(item.name, `attachment-${index + 1}`)
    const kind = item.kind === 'image' || mime.startsWith('image/') ? 'image' : 'file'

    if (kind === 'image') {
      if (!IMAGE_MIMES.has(mime)) fail(`unsupported image type: ${mime || 'unknown'}`)
      const buffer = decodeBase64(item.data)
      if (buffer.length > MAX_IMAGE_BYTES) fail(`image "${name}" is larger than 5 MB`, 413)
      total += buffer.length
      if (total > MAX_TOTAL_BYTES) fail('attachments are larger than 25 MB in total', 413)
      attachments.push({
        id: randomUUID(),
        kind,
        name,
        mime,
        size: buffer.length,
        data: buffer.toString('base64'),
        ...(typeof item.path === 'string' && item.path ? { path: item.path.slice(0, 500) } : {}),
      })
      continue
    }

    if (!TEXT_MIMES.has(mime) && !mime.startsWith('text/') && !TEXT_EXTENSIONS.has(extension(name))) {
      fail(`unsupported file type: ${name}`)
    }
    const text = textOf(item)
    const size = Buffer.byteLength(text)
    if (size > MAX_TEXT_BYTES) fail(`file "${name}" is larger than 1 MB`, 413)
    if (text.includes('\0')) fail(`file "${name}" is binary`)
    total += size
    if (total > MAX_TOTAL_BYTES) fail('attachments are larger than 25 MB in total', 413)
    attachments.push({
      id: randomUUID(),
      kind,
      name,
      mime: mime || 'text/plain',
      size,
      text,
      ...(typeof item.path === 'string' && item.path ? { path: item.path.slice(0, 500) } : {}),
    })
  }

  return attachments
}

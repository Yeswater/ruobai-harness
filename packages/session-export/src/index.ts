import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatBlock, ChatMessage, ChatSession } from '@ruobai/chat-protocol'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/chat'
import type {} from '@ruobai/session'
import { HttpError } from '@ruobai/web-server'

export const name = 'session-export'
export const inject = ['web', 'chat', 'sessions']

const TOOL_OUTPUT_LIMIT = 4_000

/**
 * Read-only export of a session.
 *
 * Markdown is built from the chat projection (the same fold the browser sees),
 * so exports match the transcript without re-implementing event folding. The
 * JSONL form is the raw append-only log, for replay or external tooling.
 */
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.web.register({
        prefix: '/api/export',
        handler: (req, res, url) => handle(ctx, req, res, url),
      }),
    'session-export.api',
  )
}

export default { name, inject, apply }

function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'method not allowed')

  const match = /^\/api\/export\/session\/([^/]+?)(?:\.(md|markdown|jsonl))?$/.exec(url.pathname)
  if (!match) throw new HttpError(404, 'not found')

  const id = decodeURIComponent(match[1]!)
  const format = match[2] ?? url.searchParams.get('format') ?? 'md'
  const session = ctx.chat.get(id)
  if (!session) throw new HttpError(404, `unknown session: ${id}`)

  if (format === 'jsonl') {
    const record = ctx.sessions.get(id)
    if (!record) throw new HttpError(404, `unknown session: ${id}`)
    const body = record.events.map(event => JSON.stringify(event)).join('\n') + '\n'
    download(res, `${fileName(session)}.jsonl`, 'application/x-ndjson; charset=utf-8', body, 'session.jsonl')
    return true
  }

  if (format !== 'md' && format !== 'markdown') {
    throw new HttpError(400, `unsupported format: ${format}`)
  }

  download(res, `${fileName(session)}.md`, 'text/markdown; charset=utf-8', renderMarkdown(session), 'session.md')
  return true
}

export function renderMarkdown(session: ChatSession): string {
  const meta = [
    `- 会话 ID：\`${session.id}\``,
    `- 模型：${session.provider ? `${session.provider}/` : ''}${session.model || '未知'}`,
    ...(session.mode ? [`- 模式：${session.mode}`] : []),
    ...(session.workspace ? [`- 工作区：\`${session.workspace}\``] : []),
    `- 导出时间：${new Date().toISOString()}`,
  ]

  const body: string[] = [`# ${session.title || '会话'}`, '', ...meta, '']
  for (const message of session.messages) {
    body.push(...renderMessage(message))
  }
  return body.join('\n').replace(/\n{4,}/g, '\n\n\n')
}

function renderMessage(message: ChatMessage): string[] {
  const lines: string[] = []
  const heading = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '工具'
  lines.push(`## ${heading}`, '')

  for (const block of message.blocks) {
    lines.push(...renderBlock(block))
  }
  lines.push('')
  return lines
}

function renderBlock(block: ChatBlock): string[] {
  if (block.type === 'text') {
    return block.text.trim() ? [block.text.trim(), ''] : []
  }
  if (block.type === 'reasoning') {
    if (!block.text.trim()) return []
    return ['<details><summary>思考</summary>', '', block.text.trim(), '', '</details>', '']
  }
  if (block.type === 'attachment') {
    return [`> 附件：${block.attachment.name}（${block.attachment.mime}，${block.attachment.size} 字节）`, '']
  }
  const input = truncate(block.input)
  const output = truncate(block.output)
  return [
    `<details><summary>工具 ${block.name}${block.isError ? '（失败）' : ''}</summary>`,
    '',
    '```json',
    input || '{}',
    '```',
    '',
    ...(output ? ['```text', output, '```', ''] : []),
    '</details>',
    '',
  ]
}

function truncate(text: string): string {
  if (!text) return ''
  if (text.length <= TOOL_OUTPUT_LIMIT) return text
  return `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n…（已截断，共 ${text.length} 字符）`
}

function fileName(session: ChatSession): string {
  const cleaned = (session.title || 'session')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned || `session-${session.id.slice(0, 8)}`
}

function download(res: ServerResponse, name: string, type: string, body: string, fallback: string) {
  // HTTP headers are latin-1: keep an ASCII fallback and put the real name in
  // RFC 5987 form so Chinese titles survive.
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export const meta = {
  title: '会话导出',
  description: '把会话导出为 Markdown 或原始事件 JSONL。',
}

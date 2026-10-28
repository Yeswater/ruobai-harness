import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../../tests/harness.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function setup() {
  harness = await createHarness()
  const { ctx } = harness
  const session = ctx.sessions.create({ title: '导出/测试 会话', workspace: harness.dir })
  const at = Date.now()
  ctx.sessions.append(session.id, 'message/user', { id: 'u1', text: '帮我看看 a.ts', at })
  ctx.sessions.append(session.id, 'message/assistant', {
    id: 'a1',
    at,
    parts: [
      { type: 'reasoning', text: '先读文件' },
      { type: 'text', text: '读一下。' },
      { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ],
  })
  ctx.sessions.append(session.id, 'tool/result', {
    callId: 'c1',
    name: 'read_file',
    content: 'export const a = 1',
    isError: false,
  })
  return { ctx, sessionId: session.id }
}

describe('session export', () => {
  it('renders the chat projection as Markdown', async () => {
    const { ctx, sessionId } = await setup()
    const response = await fetch(`${ctx.web.url}/api/export/session/${sessionId}.md`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/markdown')
    const body = await response.text()
    expect(body).toContain('# 导出/测试 会话')
    expect(body).toContain('## 用户')
    expect(body).toContain('帮我看看 a.ts')
    expect(body).toContain('## 助手')
    expect(body).toContain('<details><summary>思考</summary>')
    expect(body).toContain('<details><summary>工具 read_file</summary>')
    expect(body).toContain('export const a = 1')
    expect(body).toContain(`\`${sessionId}\``)
  })

  it('exports the raw event log as JSONL', async () => {
    const { ctx, sessionId } = await setup()
    const response = await fetch(`${ctx.web.url}/api/export/session/${sessionId}?format=jsonl`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('ndjson')
    const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(event => event.type).filter(type => !type.startsWith('session/'))).toEqual([
      'message/user',
      'message/assistant',
      'tool/result',
    ])
    expect(lines.find(event => event.type === 'message/user').data.text).toBe('帮我看看 a.ts')
  })

  it('rejects unknown sessions and formats', async () => {
    const { ctx, sessionId } = await setup()
    expect((await fetch(`${ctx.web.url}/api/export/session/nope.md`)).status).toBe(404)
    expect((await fetch(`${ctx.web.url}/api/export/session/${sessionId}?format=pdf`)).status).toBe(400)
    expect((await fetch(`${ctx.web.url}/api/export/session/${sessionId}`, { method: 'POST' })).status).toBe(405)
  })
})

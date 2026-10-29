import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '@ruobai/chat-protocol'
import { awaitingAnswer, describeTool, isRunning, toolDetail } from '../src/tool-summary.ts'

function tool(name: string, input: Record<string, unknown> = {}, extra: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: 'tool',
    name,
    input: JSON.stringify(input),
    output: 'ok',
    ...extra,
  }
}

describe('tool detail', () => {
  it('splits a shell row into verb and command, keeping the full text', () => {
    const detail = toolDetail(tool('bash', { command: 'grep -rn "轨迹" packages/ui-app/src | head -40' }))
    expect(detail.row).toBe('运行命令')
    expect(detail.summary).toBe('grep -rn "轨迹" packages/ui-app/src | head -40')
    expect(detail.command).toContain('head -40')
  })

  it('uses the model-provided action title when the tool carries one', () => {
    const detail = toolDetail(tool('bash', {
      command: 'grep -n "process" packages/ui-app/src/styles.css',
      description: '查看过程组样式',
    }))
    expect(detail.title).toBe('查看过程组样式')
  })

  it('splits file rows into verb and path', () => {
    expect(describeTool(tool('read_file', { path: 'src/App.tsx' }))).toBe('读取文件 src/App.tsx')
    expect(describeTool(tool('write_file', { path: 'src/new.ts', content: 'x' }))).toBe('创建文件 src/new.ts')
    expect(describeTool(tool('list_dir', { path: 'packages' }))).toBe('查看目录 packages')
  })

  it('falls back to the tool name when the input is unusable', () => {
    expect(describeTool({ type: 'tool', name: 'mcp__github__search', input: 'not json', output: '' }))
      .toBe('mcp__github__search')
  })

  it('treats a call without output as running', () => {
    expect(isRunning(tool('bash', {}, { output: '' }))).toBe(true)
    expect(isRunning(tool('bash'))).toBe(false)
    expect(isRunning(tool('bash', {}, { output: '', isError: true }))).toBe(false)
  })
})

describe('questions to the human', () => {
  it('titles the row with the question instead of the tool name', () => {
    const detail = toolDetail(tool('ask_user', {
      question: '面板与后端一致，问题出在清单只写了一次。你想按哪种方式收口？',
      options: ['兜底', '只改提示'],
    }))
    expect(detail.row).toBe('向你提问')
    expect(detail.title).toContain('面板与后端一致')
    expect(detail.ask).toEqual({
      question: '面板与后端一致，问题出在清单只写了一次。你想按哪种方式收口？',
      options: ['兜底', '只改提示'],
      pages: [{
        question: '面板与后端一致，问题出在清单只写了一次。你想按哪种方式收口？',
        options: ['兜底', '只改提示'],
        allowFreeText: true,
      }],
    })
  })

  it('reads a multi-question ask as ordered pages', () => {
    const detail = toolDetail(tool('ask_user', {
      questions: [
        { question: '部署到哪？', options: ['本机', 'VPS'] },
        { question: '开鉴权吗？', options: ['开', '不开'], allowFreeText: false },
      ],
    }))
    expect(detail.row).toBe('向你提问')
    expect(detail.ask?.pages.map(page => page.question)).toEqual(['部署到哪？', '开鉴权吗？'])
    expect(detail.ask?.pages[1]?.allowFreeText).toBe(false)
    expect(detail.ask?.question).toBe('部署到哪？')
  })

  it('reads a pending question as waiting, not as output-less', () => {
    const pending = tool('ask_user', { question: '选哪个？' }, { output: '', finishedAt: undefined })
    expect(awaitingAnswer(pending)).toBe(true)
    expect(isRunning(pending)).toBe(true)
    expect(awaitingAnswer({ ...pending, output: '用户回答：第一个' })).toBe(false)
    expect(awaitingAnswer(tool('bash', {}, { output: '', finishedAt: undefined }))).toBe(false)
  })
})

describe('plans submitted for approval', () => {
  const plan = '## 登录页拆分\n\n1. 抽出表单组件\n2. 接路由\n'

  it('titles the row with the plan title and keeps the markdown', () => {
    const detail = toolDetail(tool('plan_submit', { title: '登录页拆分', plan }))
    expect(detail.row).toBe('提交计划')
    expect(detail.title).toBe('登录页拆分')
    expect(detail.plan).toEqual({ title: '登录页拆分', plan: plan.trim() })
  })

  it('falls back to the plan heading, then to a generic title', () => {
    expect(toolDetail(tool('plan_submit', { plan })).title).toBe('登录页拆分')
    expect(toolDetail(tool('plan_submit', { plan: '1. 改一下\n' })).title).toBe('实施计划')
  })

  it('is not a plan when the tool is unrelated or the body is empty', () => {
    expect(toolDetail(tool('bash', { command: 'ls' })).plan).toBeUndefined()
    expect(toolDetail(tool('plan_submit', { plan: '  ' })).plan).toBeUndefined()
  })
})

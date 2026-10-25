import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '@ruobai/chat-protocol'
import { describeTool, describeToolRun, isRunning, toolDetail } from '../src/tool-summary.ts'

function tool(name: string, input: Record<string, unknown> = {}, extra: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: 'tool',
    name,
    input: JSON.stringify(input),
    output: 'ok',
    ...extra,
  }
}

describe('tool run summary', () => {
  it('groups calls by what the user sees, loudest first', () => {
    const summary = describeToolRun([
      tool('read_file', { path: 'a.ts' }),
      tool('read_file', { path: 'b.ts' }),
      tool('bash', { command: 'git status' }),
      tool('bash', { command: 'pnpm test' }),
      tool('bash', { command: 'pnpm build' }),
      tool('read_file', { path: 'c.ts' }),
      tool('edit_file', { path: 'd.ts' }),
    ])
    expect(summary).toBe('运行 3 条命令，读取 3 个文件，编辑 1 个文件')
  })

  it('counts failures inline so a folded run still reports them', () => {
    const summary = describeToolRun([
      tool('bash', { command: 'false' }, { isError: true }),
      tool('read_file', { path: 'a.ts' }),
    ])
    expect(summary).toBe('运行 1 条命令，读取 1 个文件（1 个失败）')
  })

  it('keeps unknown and MCP tools in a trailing bucket', () => {
    const summary = describeToolRun([
      tool('mcp__github__search'),
      tool('read_file', { path: 'a.ts' }),
      tool('goal_complete'),
    ])
    expect(summary).toBe('读取 1 个文件，执行 2 项其他操作')
  })

  it('describes an empty run without crashing', () => {
    expect(describeToolRun([])).toBe('无工具调用')
  })
})

describe('tool detail', () => {
  it('titles a shell call with its command and keeps the full text', () => {
    const detail = toolDetail(tool('bash', { command: 'grep -rn "轨迹" packages/ui-app/src | head -40' }))
    expect(detail.title).toBe('运行 grep -rn "轨迹" packages/ui-app/src | head -40')
    expect(detail.command).toContain('head -40')
  })

  it('titles file calls with verb and path', () => {
    expect(describeTool(tool('read_file', { path: 'src/App.tsx' }))).toBe('读取 src/App.tsx')
    expect(describeTool(tool('write_file', { path: 'src/new.ts', content: 'x' }))).toBe('创建 src/new.ts')
    expect(describeTool(tool('list_dir', { path: 'packages' }))).toBe('查看 packages')
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

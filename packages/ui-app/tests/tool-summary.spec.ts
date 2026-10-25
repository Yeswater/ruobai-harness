import { describe, expect, it } from 'vitest'
import type { ToolBlock } from '@ruobai/chat-protocol'
import { describeTool, isRunning, toolDetail } from '../src/tool-summary.ts'

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

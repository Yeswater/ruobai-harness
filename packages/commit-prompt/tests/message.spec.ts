import { describe, expect, it } from 'vitest'
import { inferType, proposeMessage, scopeOf } from '../src/message.ts'

const file = (path: string, extra: { untracked?: boolean; index?: string } = {}) => ({ path, ...extra })

describe('commit message proposal', () => {
  it('uses the session title, typed by what the diff touches', () => {
    const { message } = proposeMessage({
      title: '修复 输入框有两个输入按钮问题',
      changes: [file('packages/ui-app/src/components/Composer.tsx')],
    })
    expect(message).toBe('fix: 修复 输入框有两个输入按钮问题')
  })

  it('lets docs and tests name themselves regardless of the title', () => {
    expect(inferType('修复 拼写', [file('docs/todo.md')])).toBe('docs')
    expect(inferType('新增功能', [file('packages/git/tests/api.spec.ts')])).toBe('test')
    expect(inferType('更新依赖', [file('pnpm-lock.yaml'), file('package.json')])).toBe('chore')
  })

  it('reads the wording when the paths are mixed', () => {
    const mixed = [file('packages/ui-app/src/App.tsx'), file('docs/session-runtime.md')]
    expect(inferType('重构设置面板', mixed)).toBe('refactor')
    expect(inferType('修复 轨迹不跟随', mixed)).toBe('fix')
    expect(inferType('支持运行中切换权限', mixed)).toBe('feat')
  })

  it('falls back to added-vs-edited when the title says nothing', () => {
    expect(inferType('', [file('packages/new/src/index.ts', { untracked: true })])).toBe('feat')
    expect(inferType('', [file('packages/new/src/index.ts')])).toBe('fix')
  })

  it('offers a diff-shaped alternative next to the title', () => {
    const { message, candidates } = proposeMessage({
      title: '修复 ask 组件显示无输出',
      changes: [
        file('packages/ui-app/src/components/Transcript.tsx'),
        file('packages/ui-app/src/tool-summary.ts'),
        file('docs/session-runtime.md'),
      ],
    })
    expect(message).toBe('fix: 修复 ask 组件显示无输出')
    expect(candidates[0]).toBe(message)
    expect(candidates[1]).toBe('fix: 更新 packages/ui-app、docs（3 个文件）')
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('describes the diff by area, most-changed first', () => {
    expect(scopeOf([
      file('packages/ui-app/src/a.ts'),
      file('packages/ui-app/src/b.ts'),
      file('docs/x.md'),
      file('apps/cli/src/bin.ts'),
    ])).toBe('packages/ui-app、apps/cli')
  })

  it('keeps the subject short enough for an oneline log', () => {
    const { message } = proposeMessage({
      title: '修复 '.repeat(40),
      changes: [file('packages/ui-app/src/App.tsx')],
    })
    expect(message.length).toBeLessThanOrEqual(60)
    expect(message.endsWith('…')).toBe(true)
  })
})

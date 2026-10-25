import { useState } from 'react'
import type { ContextInfo } from '../api.ts'
import { ChevronRightIcon } from './Icons.tsx'

interface ContextCardProps {
  context: ContextInfo | null
}

const SLICES = [
  { key: 'messages', label: '消息' },
  { key: 'mcpTools', label: 'MCP 工具' },
  { key: 'systemTools', label: '系统工具' },
  { key: 'systemPrompt', label: '系统提示' },
] as const

export function formatTokens(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(tokens)}`
}

export function ContextCard({ context }: ContextCardProps) {
  const [mcpOpen, setMcpOpen] = useState(false)

  if (!context) return <div className="ctx-empty">正在统计上下文…</div>

  const compactAt = Math.max(1, context.compactAt)
  const budget = Math.max(1, context.contextWindow ?? context.compactAt)
  const used = context.estimatedTokens
  const free = Math.max(0, budget - used)
  const percent = (value: number) => Math.min(100, (value / budget) * 100)
  const rows = [
    ...SLICES.map(slice => ({ ...slice, tokens: context.breakdown[slice.key] })),
    { key: 'free' as const, label: '空闲', tokens: free },
  ]

  return (
    <>
      <div className="ctx-summary">
        <span>已使用 {Math.min(100, Math.round(percent(used)))}%</span>
        <span className="ctx-budget">{formatTokens(used)} / {formatTokens(budget)}</span>
      </div>

      <div className="ctx-bar" aria-hidden="true">
        {rows.map(row => row.tokens > 0
          ? <span key={row.key} className={`ctx-seg seg-${row.key}`} style={{ width: `${percent(row.tokens)}%` }} />
          : null)}
      </div>
      {context.contextWindow ? (
        <div className="ctx-hint">压缩阈值 {formatTokens(compactAt)}</div>
      ) : null}
      {context.prunedToolResults
        ? <div className="ctx-hint">已裁剪 {context.prunedToolResults} 条旧工具输出</div>
        : null}
      {Math.abs(context.calibration - 1) >= 0.05
        ? <div className="ctx-hint">估算校准 ×{context.calibration.toFixed(2)}</div>
        : null}
      {context.compaction.lastAt
        ? (
          <div className="ctx-hint">
            上次压缩 {formatTokens(context.compaction.lastBefore ?? 0)}
            {' → '}
            {formatTokens(context.compaction.lastAfter ?? 0)}
          </div>
        )
        : null}
      {context.compaction.disabled
        ? (
          <div className="ctx-hint error">
            自动压缩已暂停（连续失败 {context.compaction.failures} 次）
          </div>
        )
        : null}
      {!context.compaction.disabled && context.compaction.lastError
        ? <div className="ctx-hint error">{context.compaction.lastError}</div>
        : null}

      <div className="ctx-legend">
        {rows.map(row => (
          <div className="ctx-row" key={row.key}>
            <span className={`ctx-dot seg-${row.key}`} />
            <span className="ctx-label">{row.label}</span>
            <span className="ctx-tokens">{formatTokens(row.tokens)}</span>
            <span className="ctx-percent">{percent(row.tokens).toFixed(1)}%</span>
          </div>
        ))}
      </div>

      {context.mcpTools.length
        ? (
          <>
            <button
              type="button"
              className={`ctx-mcp-toggle ${mcpOpen ? 'open' : ''}`}
              aria-expanded={mcpOpen}
              onClick={() => setMcpOpen(current => !current)}
            >
              <span className="ctx-mcp-chevron"><ChevronRightIcon size={11} /></span>
              <span>MCP 工具</span>
              <span className="ctx-mcp-count">{context.mcpTools.length}</span>
            </button>
            {mcpOpen
              ? (
                <div className="ctx-mcp-list">
                  {context.mcpTools.map(name => <span key={name} className="ctx-mcp-name mono">{name}</span>)}
                </div>
              )
              : null}
          </>
        )
        : null}
    </>
  )
}

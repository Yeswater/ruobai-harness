import { useMemo } from 'react'
import { ExternalLinkIcon } from '../Icons.tsx'
import { countDiff, parseDiff } from './model.ts'

interface DiffPaneProps {
  path: string
  diff?: string
  binary?: boolean
  loading?: boolean
  error?: string
  /** "已暂存", "工作区" or a short commit hash. */
  badge?: string
  onOpen?: () => void
}

/** Unified diff with line numbers, sized for a narrow panel or a wide pane. */
export function DiffPane({
  path, diff, binary, loading, error, badge, onOpen,
}: DiffPaneProps) {
  const stats = useMemo(() => countDiff(diff), [diff])
  const lines = useMemo(() => (diff ? parseDiff(diff) : []), [diff])

  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <span className="git-diff-path" title={path}>{path}</span>
        {badge ? <span className="git-badge">{badge}</span> : null}
        {diff ? (
          <span className="change-stats">
            <span className="add">+{stats.added}</span>
            <span className="del">-{stats.removed}</span>
          </span>
        ) : null}
        {onOpen
          ? (
            <button className="icon-btn subtle" onClick={onOpen} title="在编辑器中打开" aria-label="在编辑器中打开">
              <ExternalLinkIcon size={13} />
            </button>
          )
          : null}
      </div>
      <div className="git-diff-body">
        {loading
          ? <div className="detail-note">正在读取 diff…</div>
          : error
            ? <div className="detail-note error">{error}</div>
            : binary
              ? <div className="detail-note">二进制文件，无法显示文本差异。</div>
              : diff === undefined
                ? <div className="detail-note">选择一个文件查看改动。</div>
                : !diff.trim()
                  ? <div className="detail-note">没有可显示的 diff。</div>
                  : lines.map((line, index) => (
                    <div className={`diff-row ${line.kind}`} key={index}>
                      <span className="diff-gutter">{line.oldLine ?? ''}</span>
                      <span className="diff-gutter">{line.newLine ?? ''}</span>
                      <span className="diff-text">{line.text || ' '}</span>
                    </div>
                  ))}
      </div>
    </div>
  )
}

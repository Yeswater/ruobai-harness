import {
  useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent,
} from 'react'
import { api, type GitChange, type GitInfo } from '../../api.ts'
import { ClockIcon, FolderTreeIcon, ListIcon } from '../Icons.tsx'
import { useContextMenu } from '../ContextMenu.tsx'
import { ChangeTree } from './ChangeTree.tsx'
import { buildTree, groupChanges, type ChangeEntry } from './model.ts'

const MESSAGES_KEY = 'rbh-git-messages'
const GROUP_KEY = 'rbh-git-group'

function loadMessages(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MESSAGES_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, 20) : []
  } catch {
    return []
  }
}

function loadGrouped() {
  return localStorage.getItem(GROUP_KEY) !== '0'
}

interface ChangesPaneProps {
  sessionId: string
  changes: GitChange[]
  info: GitInfo
  activeKey?: string
  onSelect: (entry: ChangeEntry) => void
  onChanged: () => Promise<void> | void
  onNotice: (text: string | null) => void
  onError: (text: string | null) => void
}

/** Working-tree changes as a directory tree, with the commit box above it. */
export function ChangesPane({
  sessionId, changes, info, activeKey, onSelect, onChanged, onNotice, onError,
}: ChangesPaneProps) {
  const contextMenu = useContextMenu()
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [grouped, setGrouped] = useState(loadGrouped)
  const [messages, setMessages] = useState<string[]>(loadMessages)

  const groups = useMemo(() => groupChanges(changes), [changes])
  const trees = useMemo(() => ({
    conflicted: buildTree(groups.conflicted),
    staged: buildTree(groups.staged),
    unstaged: buildTree(groups.unstaged),
  }), [groups])

  const signature = groups.unstaged.map(entry => entry.change.path).join('\n')
  useEffect(() => {
    setSelected((current) => {
      const next: Record<string, boolean> = {}
      for (const entry of groups.unstaged) {
        next[entry.change.path] = current[entry.change.path] ?? true
      }
      return next
    })
  }, [signature])

  const chosen = groups.unstaged
    .filter(entry => selected[entry.change.path])
    .map(entry => entry.change.path)
  const stagedCount = groups.staged.length
  const nothing = stagedCount + chosen.length === 0

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    onError(null)
    onNotice(null)
    try {
      await action()
      await onChanged()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const stage = (paths: string[]) => run('stage', async () => {
    await api.stageGitPaths(sessionId, paths)
  })
  const unstage = (paths: string[]) => run('unstage', async () => {
    await api.unstageGitPaths(sessionId, paths)
  })
  const discard = (paths: string[]) => {
    if (!confirm(`丢弃 ${paths.length} 个文件的改动？此操作无法撤销。`)) return
    void run('discard', async () => {
      await api.discardGitPaths(sessionId, paths)
    })
  }

  const commit = async (push: boolean) => {
    if (!message.trim()) return
    setBusy(push ? 'push' : 'commit')
    onError(null)
    onNotice(null)
    try {
      const result = await api.commitGit(sessionId, {
        message: message.trim(),
        amend,
        paths: chosen,
      })
      const history = [message.trim(), ...messages.filter(item => item !== message.trim())].slice(0, 20)
      localStorage.setItem(MESSAGES_KEY, JSON.stringify(history))
      setMessages(history)
      setMessage('')
      setAmend(false)
      await onChanged()
      if (!push) {
        onNotice(`已提交 ${result.commit}`)
        return
      }
      try {
        const pushed = await api.gitPush(sessionId)
        onNotice(`已提交并推送 ${result.commit}${pushed.output ? ` · ${pushed.output}` : ''}`)
        await onChanged()
      } catch (caught) {
        const reason = caught instanceof Error ? caught.message : String(caught)
        onNotice(`已提交 ${result.commit}`)
        onError(`推送失败：${reason}`)
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (!amend || message.trim()) return
    let cancelled = false
    api.getGitCommit(sessionId, 'HEAD')
      .then((commit) => {
        if (!cancelled && !message.trim()) setMessage(commit.body || commit.subject)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [amend, sessionId])

  const openMenu = (event: ReactMouseEvent, entry: ChangeEntry) => {
    const staged = entry.side === 'staged'
    contextMenu.open(event, [
      { label: '查看 diff', onSelect: () => onSelect(entry) },
      staged
        ? { label: '取消暂存', disabled: busy !== null, onSelect: () => void unstage([entry.change.path]) }
        : { label: '暂存', disabled: busy !== null, onSelect: () => void stage([entry.change.path]) },
      {
        label: '丢弃更改…',
        danger: true,
        disabled: busy !== null,
        onSelect: () => discard([entry.change.path]),
      },
      { separator: true },
      {
        label: '在编辑器中打开',
        onSelect: () => { void api.openWorkspaceFile(entry.change.path, sessionId).catch(() => undefined) },
      },
      {
        label: '复制路径',
        onSelect: () => { void navigator.clipboard.writeText(entry.change.path).catch(() => undefined) },
      },
    ])
  }

  const toggleDir = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const togglePaths = (paths: string[], value: boolean) => {
    setSelected((current) => {
      const next = { ...current }
      for (const path of paths) next[path] = value
      return next
    })
  }

  const tree = useCallback((entries: ChangeEntry[], node: keyof typeof trees, selectable: boolean) => (
    <ChangeTree
      entries={entries}
      tree={trees[node]}
      grouped={grouped}
      selectable={selectable}
      selected={selected}
      collapsed={collapsed}
      activeKey={activeKey}
      onToggle={(path, value) => setSelected(current => ({ ...current, [path]: value }))}
      onTogglePaths={togglePaths}
      onToggleDir={toggleDir}
      onActivate={onSelect}
      onContextMenu={openMenu}
      emptyText="没有文件"
    />
  ), [trees, grouped, selected, collapsed, activeKey, onSelect, openMenu])

  return (
    <section className="git-nav-section git-changes">
      <div className="git-message-box">
        <textarea
          className="commit-message"
          value={message}
          rows={2}
          placeholder={amend ? '修正上次提交的说明' : '提交说明，⌘Enter 提交'}
          onChange={event => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void commit(false)
            }
          }}
        />
        <div className="git-commit-actions">
          <label className="git-check">
            <input
              type="checkbox"
              checked={amend}
              onChange={event => setAmend(event.target.checked)}
            />
            修正上次提交
          </label>
          <button
            className="icon-btn subtle"
            title="从历史记录中选择提交说明"
            aria-label="提交说明历史"
            disabled={!messages.length}
            onClick={(event) => {
              contextMenu.open(event, messages.map(item => ({
                label: item.split('\n')[0]!.slice(0, 60),
                onSelect: () => setMessage(item),
              })))
            }}
          >
            <ClockIcon size={13} />
          </button>
          <span className="spacer" />
          <button
            className="btn compact"
            disabled={busy !== null || !message.trim() || (nothing && !amend)}
            onClick={() => void commit(false)}
          >
            {busy === 'commit' ? '提交中…' : amend ? '修正提交' : '提交'}
          </button>
          <button
            className="btn ghost compact"
            disabled={busy !== null || !message.trim() || (nothing && !amend)}
            onClick={() => void commit(true)}
            title="提交并推送到上游分支"
          >
            {busy === 'push' ? '推送中…' : '提交并推送'}
          </button>
        </div>
        <div className="git-selection-summary">
          <span>
            已选 {chosen.length} / {groups.unstaged.length}
            {stagedCount ? ` · ${stagedCount} 个已暂存将一并提交` : ''}
          </span>
          <button
            className={`icon-btn subtle ${grouped ? 'active' : ''}`}
            onClick={() => {
              const next = !grouped
              setGrouped(next)
              localStorage.setItem(GROUP_KEY, next ? '1' : '0')
            }}
            title={grouped ? '按文件平铺' : '按目录分组'}
            aria-label={grouped ? '按文件平铺' : '按目录分组'}
          >
            {grouped ? <ListIcon size={13} /> : <FolderTreeIcon size={13} />}
          </button>
        </div>
      </div>

      <div className="git-nav-head">
        <span className="git-nav-title">更改</span>
        <span className="git-count">{info.files}</span>
      </div>

      {groups.conflicted.length
        ? (
          <div className="git-group">
            <div className="git-group-head">
              <span className="git-group-title">冲突</span>
              <span className="git-count">{groups.conflicted.length}</span>
            </div>
            {tree(groups.conflicted, 'conflicted', false)}
          </div>
        )
        : null}

      <div className="git-group">
        <div className="git-group-head">
          <span className="git-group-title">已暂存</span>
          <span className="git-count">{groups.staged.length}</span>
          <span className="spacer" />
          {groups.staged.length
            ? (
              <button
                className="btn ghost compact"
                disabled={busy !== null}
                onClick={() => void unstage(groups.staged.map(entry => entry.change.path))}
              >
                全部取消暂存
              </button>
            )
            : null}
        </div>
        {stagedCount
          ? tree(groups.staged, 'staged', false)
          : <div className="detail-note">暂存区为空；勾选下面的文件后提交会自动暂存。</div>}
      </div>

      <div className="git-group">
        <div className="git-group-head">
          <span className="git-group-title">未暂存</span>
          <span className="git-count">{groups.unstaged.length}</span>
          <span className="spacer" />
          {groups.unstaged.length
            ? (
              <>
                <button
                  className="btn ghost compact"
                  disabled={busy !== null}
                  onClick={() => void stage(groups.unstaged.map(entry => entry.change.path))}
                >
                  全部暂存
                </button>
                <button
                  className="btn ghost compact danger"
                  disabled={busy !== null}
                  onClick={() => discard(groups.unstaged.map(entry => entry.change.path))}
                >
                  全部丢弃
                </button>
              </>
            )
            : null}
        </div>
        {groups.unstaged.length
          ? tree(groups.unstaged, 'unstaged', true)
          : <div className="detail-note">工作区没有未暂存的改动。</div>}
      </div>
    </section>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type GitHostInfo } from '../../api.ts'
import { ChevronDownIcon, SparkIcon } from '../Icons.tsx'

interface CommitBarProps {
  sessionId: string
  /** Workspace-relative paths to commit; empty disables the commit actions. */
  paths: string[]
  onChanged: () => Promise<void> | void
  onNotice: (message: string | null) => void
  onError: (message: string | null) => void
}

type Busy = 'commit' | 'smart' | 'push' | null

/**
 * Commit and push for the changes panel.
 *
 * Hosts come from the git registry (`/api/git/hosts`): a hosting plugin that is
 * loaded and configured shows up in the push menu, one that is missing simply
 * does not appear. Pushing uses the remote that host points at.
 */
export function CommitBar({ sessionId, paths, onChanged, onNotice, onError }: CommitBarProps) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [hosts, setHosts] = useState<GitHostInfo[]>([])
  const [hostsReady, setHostsReady] = useState(false)
  const [menu, setMenu] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const nothing = paths.length === 0

  const loadHosts = useCallback(async () => {
    try {
      setHosts(await api.getGitHosts(sessionId))
    } catch {
      setHosts([])
    } finally {
      setHostsReady(true)
    }
  }, [sessionId])

  useEffect(() => {
    void loadHosts()
  }, [loadHosts])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setMenu(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [menu])

  const fail = (caught: unknown) => {
    onError(caught instanceof Error ? caught.message : String(caught))
  }

  const commit = async () => {
    const text = message.trim()
    if (!text || nothing) return
    setBusy('commit')
    onError(null)
    onNotice(null)
    try {
      const result = await api.commitGit(sessionId, { message: text, paths })
      setMessage('')
      await onChanged()
      onNotice(`已提交 ${result.commit}`)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy(null)
    }
  }

  /** Ask the server for a message from the actual diff, then commit it. */
  const smartCommit = async () => {
    if (nothing) return
    setBusy('smart')
    onError(null)
    onNotice(null)
    try {
      const { message: proposal } = await api.getCommitSuggestion(sessionId)
      const text = proposal.trim()
      if (!text) throw new Error('没有可用的提交说明')
      setMessage(text)
      const result = await api.commitGit(sessionId, { message: text, paths })
      setMessage('')
      await onChanged()
      onNotice(`已智能提交 ${result.commit}`)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy(null)
    }
  }

  const usable = hosts.filter(host => host.configured && host.remotes.length > 0)
  const primary = usable[0]

  const push = async (host?: GitHostInfo) => {
    setMenu(false)
    setBusy('push')
    onError(null)
    onNotice(null)
    try {
      const remote = host
        ? (host.remotes.find(item => item.name === 'origin') ?? host.remotes[0])?.name
        : undefined
      const result = await api.gitPush(sessionId, remote)
      await onChanged()
      onNotice(`已推送到 ${host?.label ?? '上游'}${result.output ? ` · ${result.output}` : ''}`)
    } catch (caught) {
      fail(caught)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="commit-bar" ref={boxRef}>
      <textarea
        className="commit-message"
        value={message}
        rows={2}
        placeholder="提交说明，⌘Enter 提交"
        onChange={event => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void commit()
          }
        }}
      />
      <div className="commit-bar-actions">
        <button
          className="btn ghost compact"
          disabled={busy !== null || nothing}
          onClick={() => void smartCommit()}
          title="根据当前改动生成提交说明并提交"
        >
          <SparkIcon size={12} />
          {busy === 'smart' ? '提交中…' : '智能提交'}
        </button>
        <span className="spacer" />
        <button
          className="btn compact"
          disabled={busy !== null || nothing || !message.trim()}
          onClick={() => void commit()}
        >
          {busy === 'commit' ? '提交中…' : '提交'}
        </button>
        <div className="commit-push">
          <button
            className="btn ghost compact"
            disabled={busy !== null || !hostsReady}
            onClick={() => void push(primary)}
            title={primary ? `推送到 ${primary.label}（${primary.remotes.map(remote => remote.name).join('、')}）` : '推送到上游分支'}
          >
            {busy === 'push' ? '推送中…' : hostsReady ? `推送到 ${primary?.label ?? '上游'}` : '推送到…'}
          </button>
          <button
            className={`icon-btn subtle commit-push-more ${menu ? 'active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label="选择推送目标"
            title="选择推送目标"
            disabled={busy !== null}
            onClick={() => {
              if (!menu) void loadHosts()
              setMenu(current => !current)
            }}
          >
            <ChevronDownIcon size={11} />
          </button>

          {menu
            ? (
              <div className="commit-push-menu" role="menu">
                <div className="commit-push-head">推送到</div>
                {hosts.map(host => (
                  <button
                    type="button"
                    role="menuitem"
                    key={host.id}
                    disabled={busy !== null || !host.configured || !host.remotes.length}
                    title={host.remotes.map(remote => `${remote.name}: ${remote.url}`).join('\n') || undefined}
                    onClick={() => void push(host)}
                  >
                    <span className="commit-host-name">{host.label}</span>
                    <span className={`commit-host-state is-${hostState(host)}`}>{hostStatus(host)}</span>
                  </button>
                ))}
                {!hosts.length
                  ? (
                    <div className="commit-push-empty">
                      {hostsReady ? '没有注册的代码托管插件' : '正在读取平台状态…'}
                    </div>
                  )
                  : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy !== null}
                  onClick={() => void push()}
                >
                  <span className="commit-host-name">上游分支</span>
                  <span className="commit-host-state is-idle">git push</span>
                </button>
              </div>
            )
            : null}
        </div>
      </div>
    </div>
  )
}

function hostState(host: GitHostInfo): 'ok' | 'idle' | 'error' {
  if (host.error) return 'error'
  if (!host.configured) return 'idle'
  if (!host.remotes.length) return 'idle'
  return 'ok'
}

function hostStatus(host: GitHostInfo): string {
  if (host.error) return `连接失败 · ${host.error.slice(0, 40)}`
  if (!host.configured) return host.detail ?? '未配置'
  if (!host.remotes.length) return '无匹配远程'
  return host.account ? `已连接 · ${host.account}` : '已连接'
}

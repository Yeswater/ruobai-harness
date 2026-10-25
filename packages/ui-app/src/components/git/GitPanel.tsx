import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type GitBranch, type GitChange, type GitInfo } from '../../api.ts'
import { AlertIcon, ArrowDownIcon, ArrowUpIcon, BranchIcon, RefreshIcon, SyncIcon } from '../Icons.tsx'
import { BranchTree, type HistoryFilter } from './BranchTree.tsx'
import { ChangesPane } from './ChangesPane.tsx'
import { CommitDetails } from './CommitDetails.tsx'
import { DiffPane } from './DiffPane.tsx'
import { HistoryList } from './HistoryList.tsx'
import { entryKey, type ChangeEntry, type ChangeSide } from './model.ts'

const WIDE_AT = 620
const HEAD_FILTER: HistoryFilter = { ref: null, all: false, label: 'HEAD' }

type Selection =
  | { kind: 'file'; key: string; entry: ChangeEntry }
  | { kind: 'commit'; hash: string }
  | null

interface FileDiff {
  key: string
  loading: boolean
  diff?: string
  binary?: boolean
  error?: string
}

const OPERATIONS: Record<string, string> = {
  merge: '合并进行中：解决冲突后提交，或中止合并。',
  rebase: '变基进行中：解决冲突并继续，或中止变基。',
  'cherry-pick': '拣选进行中：解决冲突后继续。',
  revert: '回滚提交进行中：解决冲突后继续。',
  bisect: '二分查找进行中：标记 good / bad 以继续。',
}

interface GitPanelProps {
  sessionId: string
  expanded: boolean
}

/** Git workbench: branches, changes and history on the left, details on the right. */
export function GitPanel({ sessionId, expanded }: GitPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [changes, setChanges] = useState<GitChange[]>([])
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [filter, setFilter] = useState<HistoryFilter>(HEAD_FILTER)
  const [selection, setSelection] = useState<Selection>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const fileRequest = useRef(0)

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setWide(width >= WIDE_AT)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded])

  const loadStatus = useCallback(async () => {
    try {
      const status = await api.getGitStatus(sessionId)
      setInfo(status.info)
      setChanges(status.changes)
      setError(null)
      return status.info
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return null
    }
  }, [sessionId])

  const loadBranches = useCallback(async () => {
    try {
      setBranches(await api.getGitBranches(sessionId))
    } catch {
      setBranches([])
    }
  }, [sessionId])

  useEffect(() => {
    setInfo(null)
    setChanges([])
    setBranches([])
    setSelection(null)
    setFileDiff(null)
    setFilter(HEAD_FILTER)
    setError(null)
    setNotice(null)
    void loadStatus()
    void loadBranches()
  }, [loadStatus, loadBranches])

  useEffect(() => {
    if (busy) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadStatus()
    }, 5_000)
    return () => clearInterval(timer)
  }, [busy, loadStatus])

  useEffect(() => {
    if (selection?.kind !== 'file') {
      setFileDiff(null)
      return
    }
    const key = selection.key
    const request = fileRequest.current + 1
    fileRequest.current = request
    setFileDiff({ key, loading: true })
    api.getGitDiff(sessionId, {
      path: selection.entry.change.path,
      scope: selection.entry.side === 'staged' ? 'staged' : 'working',
    })
      .then((result) => {
        if (fileRequest.current !== request) return
        setFileDiff({ key, loading: false, diff: result.diff, binary: result.binary })
      })
      .catch((caught) => {
        if (fileRequest.current !== request) return
        setFileDiff({
          key,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught),
        })
      })
  }, [selection, sessionId, revision])

  // Keep a selected file alive across stage/unstage, and drop it once committed.
  useEffect(() => {
    if (selection?.kind !== 'file') return
    const path = selection.entry.change.path
    const change = changes.find(item => item.path === path)
    if (!change) {
      setSelection(null)
      return
    }
    const preferred: ChangeSide = selection.entry.side
    const side = change[preferred === 'staged' ? 'staged' : 'unstaged']
      ? preferred
      : change[preferred === 'staged' ? 'unstaged' : 'staged'] ? (preferred === 'staged' ? 'working' : 'staged') : null
    if (!side) {
      setSelection(null)
      return
    }
    const key = `${side}:${path}`
    if (key !== selection.key) {
      setSelection({ kind: 'file', key, entry: { change, side } })
    }
  }, [changes])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadBranches()])
    setRevision(current => current + 1)
  }, [loadStatus, loadBranches])

  const checkout = async (branch: GitBranch) => {
    setBusy(branch.name)
    setError(null)
    setNotice(null)
    try {
      const switched = await api.checkoutGitBranch(sessionId, branch.name)
      setNotice(`已切换到 ${switched}`)
      setFilter(HEAD_FILTER)
      setSelection(null)
      await refreshAll()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const createBranch = async (name: string) => {
    setBusy('create')
    setError(null)
    setNotice(null)
    try {
      const created = await api.createGitBranch(sessionId, name)
      setNotice(`已创建并切换到 ${created}`)
      setFilter(HEAD_FILTER)
      setSelection(null)
      await refreshAll()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const sync = async (kind: 'fetch' | 'pull' | 'push') => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      const action = kind === 'fetch' ? api.gitFetch : kind === 'pull' ? api.gitPull : api.gitPush
      const result = await action(sessionId)
      setNotice(result.output)
      setSelection(null)
      await refreshAll()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const selectEntry = (entry: ChangeEntry) => {
    setSelection({ kind: 'file', key: entryKey(entry), entry })
  }

  const remotes = [...new Set(
    branches.filter(branch => branch.remote).map(branch => branch.name.split('/')[0]!),
  )]
  const available = info?.available ?? true
  const operation = info?.operation && info.operation !== 'clean' ? OPERATIONS[info.operation] : null
  const showNav = wide || !selection
  const showDetail = wide || Boolean(selection)
  const selectedHash = selection?.kind === 'commit' ? selection.hash : null
  const autoSelect = wide && selection === null

  return (
    <div className={`git-workspace ${expanded ? 'expanded' : ''}`} ref={rootRef}>
      <div className="git-topbar">
        <span className="git-current-branch" title={info?.detached ? '分离 HEAD' : info?.branch ?? ''}>
          <BranchIcon size={13} />
          <span className="git-branch-name">
            {info ? (info.detached ? `detached@${info.branch ?? 'HEAD'}` : info.branch ?? '—') : '…'}
          </span>
          {info?.ahead ? <span className="git-sync" title="领先上游">↑{info.ahead}</span> : null}
          {info?.behind ? <span className="git-sync" title="落后上游">↓{info.behind}</span> : null}
        </span>
        <span className="spacer" />
        <button
          className="icon-btn subtle"
          title="获取远程更新 (fetch)"
          aria-label="获取远程更新"
          disabled={!available || busy !== null}
          onClick={() => void sync('fetch')}
        >
          <SyncIcon size={14} />
        </button>
        <button
          className="icon-btn subtle"
          title={info?.behind ? `拉取 ${info.behind} 个提交` : '拉取 (pull)'}
          aria-label="拉取"
          disabled={!available || busy !== null}
          onClick={() => void sync('pull')}
        >
          <ArrowDownIcon size={14} />
        </button>
        <button
          className="icon-btn subtle"
          title={info?.ahead ? `推送 ${info.ahead} 个提交` : '推送 (push)'}
          aria-label="推送"
          disabled={!available || busy !== null}
          onClick={() => void sync('push')}
        >
          <ArrowUpIcon size={14} />
        </button>
        <button
          className="icon-btn subtle"
          title="刷新"
          aria-label="刷新"
          disabled={busy !== null}
          onClick={() => void refreshAll()}
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {operation ? (
        <div className="git-banner">
          <AlertIcon size={13} />
          <span>{operation}</span>
        </div>
      ) : null}
      {error ? <div className="git-flash error">{error}</div> : null}
      {notice ? (
        <button className="git-flash" onClick={() => setNotice(null)} title="点击关闭">
          {notice}
        </button>
      ) : null}

      {!info
        ? <div className="detail-note git-loading">正在读取 Git 状态…</div>
        : !available
          ? <div className="detail-note git-loading">当前工作区不是 Git 仓库。</div>
          : (
            <div className={`git-workbench ${wide ? 'wide' : 'narrow'}`}>
              {showNav
                ? (
                  <div className="git-nav">
                    <div className="git-nav-scroll">
                      <BranchTree
                        branches={branches}
                        info={info}
                        filter={filter}
                        disabled={busy !== null}
                        onFilter={(next) => {
                          setFilter(next)
                          if (selection?.kind === 'commit') setSelection(null)
                        }}
                        onCheckout={(branch) => void checkout(branch)}
                        onCreate={(name) => void createBranch(name)}
                      />
                      <ChangesPane
                        sessionId={sessionId}
                        changes={changes}
                        info={info}
                        activeKey={selection?.kind === 'file' ? selection.key : undefined}
                        onSelect={selectEntry}
                        onChanged={refreshAll}
                        onNotice={setNotice}
                        onError={setError}
                      />
                    </div>
                    <div className="git-nav-history">
                      <HistoryList
                        sessionId={sessionId}
                        filter={filter}
                        revision={revision}
                        remotes={remotes}
                        selectedHash={selectedHash}
                        autoSelect={autoSelect}
                        onSelect={hash => setSelection({ kind: 'commit', hash })}
                        onError={setError}
                      />
                    </div>
                  </div>
                )
                : null}

              {showDetail
                ? (
                  <div className={`git-detail-pane ${selection?.kind === 'file' ? 'file-mode' : ''}`}>
                    {!wide
                      ? (
                        <button className="git-back" onClick={() => setSelection(null)}>
                          返回
                          <span className="spacer" />
                          {selection?.kind === 'file' ? selection.entry.change.path : null}
                        </button>
                      )
                      : null}
                    {selection?.kind === 'file'
                      ? (
                        <DiffPane
                          path={selection.entry.change.path}
                          diff={fileDiff?.diff}
                          binary={fileDiff?.binary}
                          loading={fileDiff?.loading}
                          error={fileDiff?.error}
                          badge={selection.entry.side === 'staged' ? '已暂存' : '工作区'}
                          onOpen={() => {
                            void api.openWorkspaceFile(selection.entry.change.path, sessionId)
                              .catch(() => undefined)
                          }}
                        />
                      )
                      : selection?.kind === 'commit'
                        ? (
                          <CommitDetails
                            sessionId={sessionId}
                            hash={selection.hash}
                            remotes={remotes}
                            onNotice={setNotice}
                            onError={setError}
                          />
                        )
                        : (
                          <div className="git-detail-empty">
                            <div className="git-detail-empty-title">{info.branch ?? 'Git'}</div>
                            <div>
                              {info.files} 个文件改动 · ↑{info.ahead} ↓{info.behind}
                            </div>
                            <div>选择左侧文件查看 diff，或选择提交查看提交详情。</div>
                          </div>
                        )}
                  </div>
                )
                : null}
            </div>
          )}
    </div>
  )
}

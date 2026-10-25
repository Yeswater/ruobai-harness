import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type GitCommitDetail, type GitCommitFile } from '../../api.ts'
import { ChevronRightIcon, CopyIcon, FolderIcon } from '../Icons.tsx'
import { FileTypeIcon } from '../FileTypeIcon.tsx'
import { DiffPane } from './DiffPane.tsx'
import { RefBadge } from './HistoryList.tsx'
import { buildPathTree, statusClass, type PathTree } from './model.ts'

interface CommitDetailsProps {
  sessionId: string
  hash: string
  remotes: string[]
  onNotice: (text: string | null) => void
  onError: (text: string | null) => void
}

/** Commit metadata, its changed-file tree, and the selected file's patch. */
export function CommitDetails({ sessionId, hash, remotes, onNotice, onError }: CommitDetailsProps) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [file, setFile] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [diff, setDiff] = useState<{ diff?: string; binary?: boolean; error?: string; loading: boolean } | null>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    setDetail(null)
    setLoading(true)
    setFile(null)
    setDiff(null)
    setCollapsed(new Set())
    onError(null)
    let cancelled = false
    api.getGitCommit(sessionId, hash)
      .then((result) => { if (!cancelled) setDetail(result) })
      .catch((caught) => {
        if (!cancelled) onError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [hash, sessionId])

  const tree = useMemo(
    () => buildPathTree<GitCommitFile>(detail?.files ?? [], item => item.path),
    [detail],
  )

  const openFile = async (path: string) => {
    const request = requestRef.current + 1
    requestRef.current = request
    setFile(path)
    setDiff({ loading: true })
    try {
      const result = await api.getGitDiff(sessionId, { path, scope: 'commit', hash })
      if (requestRef.current === request) {
        setDiff({ loading: false, diff: result.diff, binary: result.binary })
      }
    } catch (caught) {
      if (requestRef.current === request) {
        setDiff({ loading: false, error: caught instanceof Error ? caught.message : String(caught) })
      }
    }
  }

  const toggleDir = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderFile = (item: GitCommitFile, display: string) => {
    const slash = display.lastIndexOf('/')
    const dir = slash >= 0 ? display.slice(0, slash + 1) : ''
    const name = slash >= 0 ? display.slice(slash + 1) : display
    return (
      <button
        key={item.path}
        className={`git-row git-detail-file ${file === item.path ? 'selected' : ''}`}
        onClick={() => void openFile(item.path)}
        title={item.path}
      >
        <span className={`git-status git-status-${statusClass(item.status)}`}>{item.status}</span>
        <FileTypeIcon path={item.path} size={12} />
        <span className="git-row-open">
          {dir ? <span className="git-path-dir">{dir}</span> : null}
          <span className="git-path-name">{name}</span>
        </span>
        <span className="change-stats">
          <span className="add">+{item.added}</span>
          <span className="del">-{item.removed}</span>
        </span>
      </button>
    )
  }

  const renderNode = (node: PathTree<GitCommitFile>): ReactNode => {
    const open = !collapsed.has(node.path)
    const count = countNode(node)
    return (
      <div className="git-dir" key={node.path}>
        <div className="git-dir-row" onClick={() => toggleDir(node.path)}>
          <span className={`git-caret ${open ? 'open' : ''}`}><ChevronRightIcon size={11} /></span>
          <FolderIcon size={12} />
          <span className="git-dir-name" title={node.path}>{node.name}</span>
          <span className="git-count">{count}</span>
        </div>
        {open
          ? (
            <div className="git-dir-body">
              {node.items.map(item => renderFile(item, item.path.slice(node.path.length + 1)))}
              {node.children.map(renderNode)}
            </div>
          )
          : null}
      </div>
    )
  }

  if (loading) return <div className="git-detail"><div className="detail-note">正在读取提交…</div></div>
  if (!detail) return <div className="git-detail"><div className="detail-note">没有可显示的提交。</div></div>

  return (
    <div className="git-detail">
      <div className="git-detail-subject">{detail.subject}</div>
      {detail.body.trim() && detail.body.trim() !== detail.subject.trim()
        ? <pre className="git-detail-body">{detail.body.trim()}</pre>
        : null}
      <div className="git-detail-meta">
        <span>{detail.author} &lt;{detail.email}&gt;</span>
        <span>{new Date(detail.date).toLocaleString()}</span>
      </div>
      <div className="git-detail-refs">
        <button
          className="git-hash"
          title="复制完整哈希"
          onClick={() => {
            void navigator.clipboard.writeText(detail.hash).catch(() => undefined)
            onNotice(`已复制 ${detail.shortHash}`)
          }}
        >
          {detail.shortHash}
          <CopyIcon size={11} />
        </button>
        {detail.refs.map(refName => <RefBadge key={refName} refName={refName} remotes={remotes} />)}
        {detail.parents.map(parent => (
          <span className="git-parent" key={parent} title="父提交">{parent.slice(0, 7)}</span>
        ))}
      </div>

      <div className="git-nav-head">
        <span className="git-nav-title">改动的文件</span>
        <span className="git-count">{detail.files.length}</span>
      </div>
      <div className="git-commit-files">
        {tree.items.map(item => renderFile(item, item.path))}
        {tree.children.map(renderNode)}
        {!detail.files.length ? <div className="detail-note">没有文件改动。</div> : null}
      </div>

      {file
        ? (
          <DiffPane
            path={file}
            diff={diff?.diff}
            binary={diff?.binary}
            loading={diff?.loading}
            error={diff?.error}
            badge={detail.shortHash}
            onOpen={() => { void api.openWorkspaceFile(file, sessionId).catch(() => undefined) }}
          />
        )
        : <div className="detail-note">点击文件查看该提交中的改动。</div>}
    </div>
  )
}

function countNode(node: PathTree<GitCommitFile>): number {
  return node.items.length + node.children.reduce((total, child) => total + countNode(child), 0)
}

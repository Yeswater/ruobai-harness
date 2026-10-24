import { useEffect, useState } from 'react'
import { api, type WorkspaceEntry } from '../api.ts'
import { ChevronRightIcon, FolderIcon } from './Icons.tsx'

const MAX_LINES = 3_000

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript',
  json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML', py: 'Python',
  go: 'Go', rs: 'Rust', sh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
}

interface FileBrowserProps {
  sessionId?: string
}

export function FileBrowser({ sessionId }: FileBrowserProps) {
  const [root, setRoot] = useState<WorkspaceEntry | null>(null)
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<{ path: string; size: number; content: string } | null>(null)
  const [loadingDir, setLoadingDir] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRoot(null)
    setChildren({})
    setExpanded(new Set(['.']))
    setSelected(null)
    setFile(null)
    setError(null)
    void api.getWorkspaceTree('.', sessionId, 1)
      .then((node) => {
        if (cancelled) return
        setRoot(node)
        setChildren({ '.': node.children ?? [] })
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const loadDir = async (path: string) => {
    if (children[path]) return
    setLoadingDir(path)
    setError(null)
    try {
      const node = await api.getWorkspaceTree(path, sessionId, 1)
      setChildren(previous => ({ ...previous, [path]: node.children ?? [] }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoadingDir(null)
    }
  }

  const toggle = (path: string) => {
    const opening = !expanded.has(path)
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (opening) void loadDir(path)
  }

  const open = (path: string) => {
    setSelected(path)
    setError(null)
    setCopied(false)
    void api.readWorkspaceFile(path, sessionId)
      .then(setFile)
      .catch((caught) => {
        setFile(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  const copy = () => {
    if (!file) return
    void navigator.clipboard.writeText(file.content)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1_500)
      })
      .catch(() => undefined)
  }

  return (
    <div className="files">
      <div className="file-tree">
        {root
          ? (
            <TreeNode
              entry={root}
              depth={0}
              childrenByDir={children}
              expanded={expanded}
              selected={selected}
              loadingDir={loadingDir}
              onToggle={toggle}
              onOpen={open}
            />
          )
          : <div className="loading">loading workspace…</div>}
      </div>

      {error ? <div className="detail-note error">{error}</div> : null}

      {file
        ? (
          <div className="file-view">
            <div className="file-view-head">
              <div className="file-breadcrumbs">
                {file.path.split('/').filter(Boolean).map((segment, index, all) => (
                  <span key={`${segment}-${index}`} className="crumb">
                    {index ? <ChevronRightIcon size={10} /> : null}
                    <span className={index === all.length - 1 ? 'crumb-current' : ''}>{segment}</span>
                  </span>
                ))}
              </div>
              <div className="file-view-actions">
                <span className="muted">
                  {language(file.path)} · {formatBytes(file.size)}
                </span>
                <button className="link-btn" onClick={() => setWrap(value => !value)}>
                  {wrap ? '不换行' : '自动换行'}
                </button>
                <button className="link-btn" onClick={copy}>{copied ? '已复制' : '复制'}</button>
              </div>
            </div>
            <div className={`file-code ${wrap ? 'wrap' : ''}`}>
              {file.content.split('\n').slice(0, MAX_LINES).map((line, index) => (
                <div className="code-line" key={index}>
                  <span className="line-no">{index + 1}</span>
                  <span className="line-text">{line || ' '}</span>
                </div>
              ))}
              {file.content.split('\n').length > MAX_LINES
                ? <div className="code-more">… 还有 {file.content.split('\n').length - MAX_LINES} 行未显示</div>
                : null}
            </div>
          </div>
        )
        : <div className="file-hint">选择一个文件查看内容</div>}
    </div>
  )
}

interface TreeNodeProps {
  entry: WorkspaceEntry
  depth: number
  childrenByDir: Record<string, WorkspaceEntry[]>
  expanded: Set<string>
  selected: string | null
  loadingDir: string | null
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}

function TreeNode({
  entry,
  depth,
  childrenByDir,
  expanded,
  selected,
  loadingDir,
  onToggle,
  onOpen,
}: TreeNodeProps) {
  const directory = entry.type === 'directory'
  const open = expanded.has(entry.path)
  const items = childrenByDir[entry.path]

  return (
    <div>
      <button
        className={`tree-row ${selected === entry.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => directory ? onToggle(entry.path) : onOpen(entry.path)}
        title={entry.path}
      >
        <span className="tree-caret">{directory ? (open ? '▾' : '▸') : ''}</span>
        {directory
          ? <FolderIcon size={13} />
          : <span className="tree-file-dot" />}
        <span className="tree-name">{entry.name}</span>
      </button>
      {directory && open
        ? loadingDir === entry.path
          ? <div className="tree-empty" style={{ paddingLeft: 24 + depth * 12 }}>loading…</div>
          : items?.length
            ? items.map(child => (
              <TreeNode
                key={child.path}
                entry={child}
                depth={depth + 1}
                childrenByDir={childrenByDir}
                expanded={expanded}
                selected={selected}
                loadingDir={loadingDir}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))
            : <div className="tree-empty" style={{ paddingLeft: 24 + depth * 12 }}>empty</div>
        : null}
    </div>
  )
}

function language(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return LANGUAGES[extension] ?? (extension ? extension.toUpperCase() : 'Text')
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

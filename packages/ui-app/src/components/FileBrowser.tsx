import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api, type WorkspaceEntry, type WorkspaceMatch, type WorkspaceTextMatch,
} from '../api.ts'
import { highlightLines, languageOf } from '../file-highlight.ts'
import { FileTypeIcon } from './FileTypeIcon.tsx'
import {
  AtIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon, FolderIcon, SearchIcon, WrapTextIcon,
} from './Icons.tsx'

const MAX_LINES = 3_000

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  xml: 'HTML/XML',
  markdown: 'Markdown',
  yaml: 'YAML',
  bash: 'Shell',
  python: 'Python',
}

interface FileTab {
  path: string
  content: string
  size: number
  loading: boolean
  error?: string
}

interface FileBrowserProps {
  sessionId?: string
  /** Insert an `@path` reference into the composer. */
  onReference?: (path: string) => void
}

export function FileBrowser({ sessionId, onReference }: FileBrowserProps) {
  const [root, setRoot] = useState<WorkspaceEntry | null>(null)
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
  const [loadingDir, setLoadingDir] = useState<string | null>(null)
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [lineTarget, setLineTarget] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceMatch[]>([])
  const [hits, setHits] = useState<WorkspaceTextMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  const [opening, setOpening] = useState(false)
  const codeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setRoot(null)
    setChildren({})
    setExpanded(new Set(['.']))
    setTabs([])
    setActive(null)
    setQuery('')
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
    const openingDir = !expanded.has(path)
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (openingDir) void loadDir(path)
  }

  const openFile = async (path: string, line?: number) => {
    setActive(path)
    setLineTarget(line ?? null)
    setError(null)
    setTabs(current => current.some(tab => tab.path === path)
      ? current
      : [...current, { path, content: '', size: 0, loading: true }])
    try {
      const file = await api.readWorkspaceFile(path, sessionId)
      setTabs(current => current.map(tab => tab.path === path
        ? { path, content: file.content, size: file.size, loading: false }
        : tab))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setTabs(current => current.map(tab => tab.path === path
        ? { ...tab, loading: false, error: message }
        : tab))
    }
  }

  const closeTab = (path: string) => {
    const index = tabs.findIndex(tab => tab.path === path)
    const next = tabs.filter(tab => tab.path !== path)
    setTabs(next)
    if (active === path) setActive(next[Math.max(0, index - 1)]?.path ?? next[0]?.path ?? null)
  }

  useEffect(() => {
    const raw = query.trim()
    if (!raw) {
      setResults([])
      setHits([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        if (raw.startsWith('?')) {
          const term = raw.slice(1).trim()
          const matches = term ? await api.searchWorkspaceContent(term, sessionId, 50) : []
          if (!cancelled) {
            setHits(matches)
            setResults([])
          }
        } else {
          const files = await api.searchWorkspace(raw, sessionId, 50)
          if (!cancelled) {
            setResults(files)
            setHits([])
          }
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, sessionId])

  const tab = useMemo(() => tabs.find(item => item.path === active) ?? null, [tabs, active])
  const visible = useMemo (
    () => (tab ? tab.content.split('\n').slice(0, MAX_LINES) : []),
    [tab],
  )
  const totalLines = useMemo(() => (tab ? tab.content.split('\n').length : 0), [tab])
  const html = useMemo(
    () => (tab ? highlightLines(visible.join('\n'), tab.path) : null),
    [tab?.path, visible],
  )

  useEffect(() => {
    if (lineTarget === null || !tab || tab.loading) return
    const frame = requestAnimationFrame(() => {
      codeRef.current
        ?.querySelector<HTMLElement>(`[data-line="${lineTarget}"]`)
        ?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [lineTarget, tab])

  useEffect(() => {
    if (lineTarget === null) return
    const timer = setTimeout(() => setLineTarget(null), 2_500)
    return () => clearTimeout(timer)
  }, [lineTarget])

  const copyPath = () => {
    if (!tab) return
    void navigator.clipboard.writeText(tab.path)
      .then(() => {
        setCopiedPath(true)
        setTimeout(() => setCopiedPath(false), 1_500)
      })
      .catch(() => undefined)
  }

  const openInEditor = async () => {
    if (!tab) return
    setOpening(true)
    setError(null)
    try {
      await api.openWorkspaceFile(tab.path, sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setOpening(false)
    }
  }

  const openSearchResult = (item: WorkspaceMatch) => {
    if (item.type === 'file') {
      void openFile(item.path)
      return
    }
    setQuery('')
    setExpanded((previous) => new Set(previous).add(item.path))
    void loadDir(item.path)
  }

  return (
    <div className="files">
      <div className="file-side">
        <div className="file-filter">
          <SearchIcon size={12} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder="筛选，或输入 ? 在文件中搜索…"
            aria-label="筛选文件"
          />
          {query ? (
            <button className="file-filter-clear" onClick={() => setQuery('')} aria-label="清除筛选">×</button>
          ) : null}
        </div>

        {query.trim()
          ? (
            <div className="file-results">
              {searching ? <div className="tree-empty">搜索中…</div> : null}
              {query.trim().startsWith('?')
                ? hits.map(hit => (
                  <button
                    className="file-hit"
                    key={`${hit.path}:${hit.line}`}
                    title={`${hit.path}:${hit.line}`}
                    onClick={() => void openFile(hit.path, hit.line)}
                  >
                    <FileTypeIcon path={hit.path} />
                    <span className="file-hit-body">
                      <span className="file-hit-path">
                        {hit.path}<span className="file-hit-line">:{hit.line}</span>
                      </span>
                      <span className="file-hit-text">{hit.text}</span>
                    </span>
                  </button>
                ))
                : results.map(item => (
                  <button
                    key={item.path}
                    className={`tree-row ${active === item.path ? 'active' : ''}`}
                    title={item.path}
                    onClick={() => openSearchResult(item)}
                  >
                    {item.type === 'directory'
                      ? <FolderIcon size={13} />
                      : <FileTypeIcon path={item.path} />}
                    <span className="tree-name">{item.path}</span>
                  </button>
                ))}
              {!searching && !hits.length && !results.length
                ? <div className="tree-empty">{query.trim().startsWith('?') ? '没有匹配的内容' : '没有匹配的文件'}</div>
                : null}
            </div>
          )
          : (
            <div className="file-tree">
              {root
                ? (
                  <TreeNode
                    entry={root}
                    childrenByDir={children}
                    expanded={expanded}
                    active={active}
                    loadingDir={loadingDir}
                    onToggle={toggle}
                    onOpen={path => void openFile(path)}
                  />
                )
                : <div className="loading">loading workspace…</div>}
            </div>
          )}
      </div>

      {error ? <div className="detail-note error">{error}</div> : null}

      <div className="file-view">
        {tabs.length
          ? (
            <div className="file-tabs">
              {tabs.map(item => (
                <div
                  className={`file-tab ${item.path === active ? 'active' : ''}`}
                  key={item.path}
                  title={item.path}
                >
                  <button className="file-tab-open" onClick={() => setActive(item.path)}>
                    <FileTypeIcon path={item.path} size={11} />
                    <span className="file-tab-name">{basename(item.path)}</span>
                  </button>
                  <button
                    className="file-tab-close"
                    onClick={() => closeTab(item.path)}
                    aria-label={`关闭 ${basename(item.path)}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )
          : null}

        {tab
          ? tab.error
            ? <div className="detail-note error">{tab.error}</div>
            : (
              <>
                <div className="file-view-head">
                  <div className="file-breadcrumbs">
                    {tab.path.split('/').filter(Boolean).map((segment, index, all) => (
                      <span key={`${segment}-${index}`} className="crumb">
                        {index ? <ChevronRightIcon size={10} /> : null}
                        <span className={index === all.length - 1 ? 'crumb-current' : ''}>{segment}</span>
                      </span>
                    ))}
                  </div>
                  <div className="file-view-actions">
                    <button
                      className="icon-btn subtle"
                      title="引用到对话"
                      aria-label="引用到对话"
                      onClick={() => onReference?.(tab.path)}
                    >
                      <AtIcon size={13} />
                    </button>
                    <button
                      className="icon-btn subtle"
                      title={copiedPath ? '已复制路径' : '复制路径'}
                      aria-label="复制路径"
                      onClick={copyPath}
                    >
                      <CopyIcon size={13} />
                    </button>
                    <button
                      className="icon-btn subtle"
                      title={opening ? '正在打开…' : '在编辑器中打开'}
                      aria-label="在编辑器中打开"
                      disabled={opening}
                      onClick={() => void openInEditor()}
                    >
                      <ExternalLinkIcon size={13} />
                    </button>
                    <button
                      className={`icon-btn subtle ${wrap ? 'active' : ''}`}
                      title={wrap ? '取消自动换行' : '自动换行'}
                      aria-label="自动换行"
                      onClick={() => setWrap(value => !value)}
                    >
                      <WrapTextIcon size={13} />
                    </button>
                  </div>
                </div>
                <div className="file-view-meta">
                  {languageLabel(tab.path)} · {formatBytes(tab.size)}
                  {copiedPath ? ' · 已复制路径' : null}
                </div>
                <div className={`file-code ${wrap ? 'wrap' : ''}`} ref={codeRef}>
                  {tab.loading
                    ? <div className="file-hint">正在读取…</div>
                    : visible.map((line, index) => (
                      <div
                        className={`code-line ${lineTarget === index + 1 ? 'line-hit' : ''}`}
                        data-line={index + 1}
                        key={index}
                      >
                        <span className="line-no">{index + 1}</span>
                        {html
                          ? <span className="line-text" dangerouslySetInnerHTML={{ __html: html[index] ?? '' }} />
                          : <span className="line-text">{line || ' '}</span>}
                      </div>
                    ))}
                  {totalLines > MAX_LINES
                    ? <div className="code-more">… 还有 {totalLines - MAX_LINES} 行未显示</div>
                    : null}
                </div>
              </>
            )
          : <div className="file-hint">选择一个文件查看内容</div>}
      </div>
    </div>
  )
}

interface TreeNodeProps {
  entry: WorkspaceEntry
  childrenByDir: Record<string, WorkspaceEntry[]>
  expanded: Set<string>
  active: string | null
  loadingDir: string | null
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}

function TreeNode({
  entry, childrenByDir, expanded, active, loadingDir, onToggle, onOpen,
}: TreeNodeProps) {
  const directory = entry.type === 'directory'
  const open = expanded.has(entry.path)
  const items = childrenByDir[entry.path]

  return (
    <div className="tree-node">
      <button
        className={`tree-row ${active === entry.path ? 'active' : ''}`}
        onClick={() => directory ? onToggle(entry.path) : onOpen(entry.path)}
        title={entry.path}
      >
        <span className={`tree-caret ${directory ? (open ? 'open' : '') : 'leaf'}`}>
          {directory ? <ChevronRightIcon size={11} /> : null}
        </span>
        {directory ? <FolderIcon size={13} /> : <FileTypeIcon path={entry.path} />}
        <span className="tree-name">{entry.name}</span>
      </button>
      {directory && open
        ? (
          <div className="tree-children">
            {loadingDir === entry.path
              ? <div className="tree-empty">loading…</div>
              : items?.length
                ? items.map(child => (
                  <TreeNode
                    key={child.path}
                    entry={child}
                    childrenByDir={childrenByDir}
                    expanded={expanded}
                    active={active}
                    loadingDir={loadingDir}
                    onToggle={onToggle}
                    onOpen={onOpen}
                  />
                ))
                : <div className="tree-empty">empty</div>}
          </div>
        )
        : null}
    </div>
  )
}

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function languageLabel(path: string) {
  const language = languageOf(path)
  if (language) return LANGUAGE_LABELS[language] ?? language
  const extension = path.split('.').at(-1)
  return extension ? extension.toUpperCase() : 'Text'
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

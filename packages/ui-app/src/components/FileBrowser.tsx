import {
  useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  api, type WorkspaceEntry, type WorkspaceMatch, type WorkspaceTextMatch,
} from '../api.ts'
import { highlightLines, languageOf } from '../file-highlight.ts'
import { FileTypeIcon } from './FileTypeIcon.tsx'
import { useContextMenu } from './ContextMenu.tsx'
import {
  AtIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon, EyeIcon, FolderIcon, FolderTreeIcon,
  SearchIcon, WrapTextIcon,
} from './Icons.tsx'
import { MarkdownPreview } from './MarkdownPreview.tsx'

const MAX_LINES = 3_000
const TREE_WIDTH_KEY = 'rbh-file-tree-width'
const COMPACT_KEY = 'rbh-file-tree-compact'
const DEFAULT_TREE_WIDTH = 236

function loadTreeWidth() {
  const saved = Number(localStorage.getItem(TREE_WIDTH_KEY))
  return Number.isFinite(saved) && saved >= 180 && saved <= 720 ? saved : DEFAULT_TREE_WIDTH
}

/** IDEA-style compact middle directories, on unless the user turned it off. */
function loadCompact() {
  return localStorage.getItem(COMPACT_KEY) !== '0'
}

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
  java: 'Java',
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
  const contextMenu = useContextMenu()
  const [root, setRoot] = useState<WorkspaceEntry | null>(null)
  const [children, setChildren] = useState<Record<string, WorkspaceEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDir, setLoadingDir] = useState<string | null>(null)
  const [tabs, setTabs] = useState<FileTab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [lineTarget, setLineTarget] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceMatch[]>([])
  const [hits, setHits] = useState<WorkspaceTextMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(true)
  const [markdownPreview, setMarkdownPreview] = useState(true)
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth)
  const [compact, setCompact] = useState(loadCompact)
  const [copiedPath, setCopiedPath] = useState(false)
  const [opening, setOpening] = useState(false)
  const codeRef = useRef<HTMLDivElement>(null)
  const filesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setRoot(null)
    setChildren({})
    setExpanded(new Set())
    setTabs([])
    setActive(null)
    setQuery('')
    setError(null)
    void api.getWorkspaceTree('.', sessionId, 1, compact)
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
    // `compact` is read on session change; toggling refreshes the tree itself.
  }, [sessionId])

  const loadDir = async (path: string) => {
    if (children[path]) return
    setLoadingDir(path)
    setError(null)
    try {
      const node = await api.getWorkspaceTree(path, sessionId, 1, compact)
      setChildren(previous => ({ ...previous, [path]: node.children ?? [] }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoadingDir(null)
    }
  }

  const toggleCompact = async () => {
    const next = !compact
    setCompact(next)
    localStorage.setItem(COMPACT_KEY, next ? '1' : '0')
    setRoot(null)
    setChildren({})
    setExpanded(new Set())
    setLoadingDir(null)
    setError(null)
    try {
      const node = await api.getWorkspaceTree('.', sessionId, 1, next)
      setRoot(node)
      setChildren({ '.': node.children ?? [] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
    // Markdown opens rendered; a content-search jump needs the source line view.
    if (/\.(md|markdown|mdx)$/i.test(path)) setMarkdownPreview(line === undefined)
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
  const markdown = tab ? /\.(md|markdown|mdx)$/i.test(tab.path) : false
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
    await openPathInEditor(tab.path)
    setOpening(false)
  }

  const openPathInEditor = async (path: string) => {
    setError(null)
    try {
      await api.openWorkspaceFile(path, sessionId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  const startTreeResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = treeWidth
    const max = Math.max(220, (filesRef.current?.getBoundingClientRect().width ?? 720) - 280)
    document.body.classList.add('resizing')
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(max, Math.max(180, Math.round(startWidth + (moveEvent.clientX - startX))))
      setTreeWidth(next)
      localStorage.setItem(TREE_WIDTH_KEY, String(next))
    }
    const finish = () => {
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
  }

  const resetTreeWidth = () => {
    setTreeWidth(DEFAULT_TREE_WIDTH)
    localStorage.setItem(TREE_WIDTH_KEY, String(DEFAULT_TREE_WIDTH))
  }

  const entryMenu = (event: ReactMouseEvent, path: string, directory: boolean) => {
    contextMenu.open(event, directory
      ? [
          { label: expanded.has(path) ? '折叠目录' : '展开目录', onSelect: () => toggle(path) },
          { separator: true },
          { label: '复制路径', onSelect: () => copyText(path) },
        ]
      : [
          { label: '打开', onSelect: () => void openFile(path) },
          {
            label: '引用到对话',
            disabled: !onReference,
            onSelect: () => onReference?.(path),
          },
          { separator: true },
          { label: '复制路径', onSelect: () => copyText(path) },
          { label: '在编辑器中打开', onSelect: () => void openPathInEditor(path) },
        ])
  }

  const tabMenu = (event: ReactMouseEvent, path: string) => {
    contextMenu.open(event, [
      { label: '关闭', onSelect: () => closeTab(path) },
      {
        label: '关闭其他标签',
        disabled: tabs.length < 2,
        onSelect: () => {
          setTabs(current => current.filter(item => item.path === path))
          setActive(path)
        },
      },
      { separator: true },
      { label: '复制路径', onSelect: () => copyText(path) },
    ])
  }

  const codeMenu = (event: ReactMouseEvent) => {
    if (!tab) return
    const selection = window.getSelection()?.toString().trim() ?? ''
    contextMenu.open(event, [
      {
        label: '复制选中内容',
        disabled: !selection,
        onSelect: () => copyText(selection),
      },
      { label: '复制全部内容', onSelect: () => copyText(tab.content) },
      { separator: true },
      {
        label: '引用到对话',
        disabled: !onReference,
        onSelect: () => onReference?.(tab.path),
      },
      { label: '复制路径', onSelect: () => copyText(tab.path) },
    ])
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
    <div
      className="files"
      ref={filesRef}
      style={{ '--file-tree-width': `${treeWidth}px` } as CSSProperties}
    >
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
          <button
            type="button"
            className={`file-filter-toggle ${compact ? 'active' : ''}`}
            onClick={() => void toggleCompact()}
            title={compact ? '取消折叠中间目录' : '折叠中间目录（类似 IDEA 紧凑中间包）'}
            aria-label="折叠中间目录"
            aria-pressed={compact}
          >
            <FolderTreeIcon size={13} />
          </button>
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
                    onContextMenu={(event) => {
                      contextMenu.open(event, [
                        { label: '打开', onSelect: () => void openFile(hit.path, hit.line) },
                        { separator: true },
                        { label: '复制路径', onSelect: () => copyText(hit.path) },
                      ])
                    }}
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
                    onContextMenu={event => entryMenu(event, item.path, item.type === 'directory')}
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
                ? (children['.']?.length
                  ? children['.'].map(child => (
                    <TreeNode
                      key={child.path}
                      entry={child}
                      childrenByDir={children}
                      expanded={expanded}
                      active={active}
                      loadingDir={loadingDir}
                      onToggle={toggle}
                      onOpen={path => void openFile(path)}
                      onMenu={entryMenu}
                    />
                  ))
                  : <div className="tree-empty">empty</div>)
                : <div className="loading">loading workspace…</div>}
            </div>
          )}
      </div>

      <div
        className="file-side-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件树宽度"
        onPointerDown={startTreeResize}
        onDoubleClick={resetTreeWidth}
      />

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
                  onContextMenu={event => tabMenu(event, item.path)}
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
                    {markdown
                      ? (
                        <button
                          className={`icon-btn subtle ${markdownPreview ? 'active' : ''}`}
                          title={markdownPreview ? '查看源码' : '预览 Markdown'}
                          aria-label="Markdown 预览"
                          onClick={() => setMarkdownPreview(value => !value)}
                        >
                          <EyeIcon size={13} />
                        </button>
                      )
                      : null}
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
                  {markdown && markdownPreview ? ' · 预览' : ''}
                  {copiedPath ? ' · 已复制路径' : null}
                </div>
                {markdown && markdownPreview
                  ? (
                    <div className="file-markdown" ref={codeRef} onContextMenu={codeMenu}>
                      {tab.loading
                        ? <div className="file-hint">正在读取…</div>
                        : <MarkdownPreview content={tab.content} />}
                    </div>
                  )
                  : (
                    <div className={`file-code ${wrap ? 'wrap' : ''}`} ref={codeRef} onContextMenu={codeMenu}>
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
                  )}
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
  onMenu: (event: ReactMouseEvent, path: string, directory: boolean) => void
}

function TreeNode({
  entry, childrenByDir, expanded, active, loadingDir, onToggle, onOpen, onMenu,
}: TreeNodeProps) {
  const directory = entry.type === 'directory'
  const open = expanded.has(entry.path)
  const items = childrenByDir[entry.path]

  return (
    <div className="tree-node">
      <button
        className={`tree-row ${active === entry.path ? 'active' : ''}`}
        onClick={() => directory ? onToggle(entry.path) : onOpen(entry.path)}
        onContextMenu={event => onMenu(event, entry.path, directory)}
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
                    onMenu={onMenu}
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

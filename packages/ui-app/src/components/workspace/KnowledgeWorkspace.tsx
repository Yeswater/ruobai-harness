import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveIcon, CheckIcon, ClockIcon, FileTextIcon, FolderTreeIcon, PlusIcon, RefreshIcon, SearchIcon,
} from '../Icons.tsx'
import { MarkdownPreview, markdownHeadingId } from '../MarkdownPreview.tsx'

interface WikiPageSummary {
  id: string
  title: string
  tags?: string[]
  status: string
  sourced?: boolean
  updated?: string
  summary?: string
}

interface WikiProposal {
  id: string
  title: string
}

interface WikiStats {
  pages: number
  chunks: number
  ready: number
  unready: number
  catalogChars: number
}

interface WikiIndex {
  pages: WikiPageSummary[]
  proposals: WikiProposal[]
  stats: WikiStats
}

interface WikiPageDetail {
  id: string
  meta: { title: string; tags?: string[]; revision: number; status: string }
  body: string
  stale: Array<{ path: string; reason: string }>
}

interface WikiHit {
  page: string
  title: string
  heading: string
  summary?: string
  snippet?: string
}

interface WikiFinding {
  page?: string
  kind: string
  detail: string
}

interface Heading {
  id: string
  text: string
  depth: number
}

function headingsOf(body: string): Heading[] {
  const out: Heading[] = []
  for (const line of body.split('\n')) {
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const text = match[2]!.replace(/[*_`~]/g, '')
    out.push({ id: markdownHeadingId(text), text, depth: match[1]!.length })
  }
  return out
}

async function wikiRequest<T>(sessionId: string | undefined, path: string, options: RequestInit = {}): Promise<T> {
  const url = sessionId
    ? `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`
    : path
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

export function KnowledgeWorkspace({ sessionId }: { sessionId?: string }) {
  const [data, setData] = useState<WikiIndex | null>(null)
  const [selected, setSelected] = useState<WikiPageDetail | null>(null)
  const [draft, setDraft] = useState({ title: '', body: '', tags: '' })
  const [mode, setMode] = useState<'read' | 'edit'>('read')
  const [results, setResults] = useState<WikiHit[] | null>(null)
  const [search, setSearch] = useState('')
  const [backlinks, setBacklinks] = useState<Array<{ id: string; title?: string }>>([])
  const [versions, setVersions] = useState<number[]>([])
  const [historical, setHistorical] = useState<{ revision: number; text: string } | null>(null)
  const [findings, setFindings] = useState<WikiFinding[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    setError(null)
    try {
      setData(await wikiRequest<WikiIndex>(sessionId, '/api/wiki'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const open = async (id: string) => {
    setError(null)
    setHistorical(null)
    setResults(null)
    try {
      const page = await wikiRequest<WikiPageDetail>(sessionId, `/api/wiki/page/${encodeURIComponent(id)}`)
      setSelected({ ...page, id })
      setDraft({ title: page.meta.title, body: page.body, tags: (page.meta.tags ?? []).join(', ') })
      setMode('read')
      setActiveHeading(headingsOf(page.body)[0]?.id ?? '')
      const [links, history] = await Promise.all([
        wikiRequest<{ backlinks: Array<{ id: string; title?: string }> }>(sessionId, `/api/wiki/page/${encodeURIComponent(id)}/backlinks`),
        wikiRequest<{ versions: number[] }>(sessionId, `/api/wiki/page/${encodeURIComponent(id)}/versions`),
      ])
      setBacklinks(links.backlinks ?? [])
      setVersions(history.versions ?? [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    let cancelled = false
    setSelected(null)
    setMode('read')
    setResults(null)
    setSearch('')
    void (async () => {
      try {
        const next = await wikiRequest<WikiIndex>(sessionId, '/api/wiki')
        if (cancelled) return
        setData(next)
        if (next.pages[0]) void open(next.pages[0].id)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const headings = useMemo(() => selected ? headingsOf(selected.body) : [], [selected])

  // Scroll-spy for the outline: the topmost heading in the relaxed viewport wins.
  useEffect(() => {
    const root = scrollRef.current
    const content = contentRef.current
    if (mode !== 'read' || !root || !content) return
    const nodes = [...content.querySelectorAll('h2, h3')] as HTMLElement[]
    if (!nodes.length) return
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      if (visible[0]?.target.id) setActiveHeading(visible[0].target.id)
    }, { root, rootMargin: '0px 0px -72% 0px' })
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [mode, selected?.id, selected?.body])

  const startNew = () => {
    setSelected({
      id: '',
      meta: { title: '', tags: [], revision: 0, status: 'draft' },
      body: '',
      stale: [],
    })
    setDraft({ title: '', body: '', tags: '' })
    setBacklinks([])
    setVersions([])
    setHistorical(null)
    setResults(null)
    setMode('edit')
    setNotice(null)
  }

  const save = async () => {
    if (!selected || !draft.title.trim()) return
    setBusy(true)
    setError(null)
    try {
      const tags = draft.tags.split(',').map(value => value.trim()).filter(Boolean)
      const result = selected.id
        ? await wikiRequest<{ id: string; revision: number }>(sessionId, `/api/wiki/page/${encodeURIComponent(selected.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ title: draft.title, body: draft.body, tags }),
        })
        : await wikiRequest<{ id: string; revision: number }>(sessionId, '/api/wiki/page', {
          method: 'POST',
          body: JSON.stringify({ title: draft.title, body: draft.body, tags }),
        })
      setNotice(`已保存 ${result.id} · r${result.revision}`)
      setMode('read')
      await load()
      await open(result.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const archive = async () => {
    if (!selected?.id || !window.confirm(`归档页面「${selected.meta.title}」？`)) return
    setBusy(true)
    try {
      await wikiRequest(sessionId, `/api/wiki/page/${encodeURIComponent(selected.id)}`, { method: 'DELETE' })
      setSelected(null)
      setMode('read')
      setNotice('已归档')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const runSearch = async () => {
    if (!search.trim()) {
      setResults(null)
      return
    }
    setError(null)
    try {
      const body = await wikiRequest<{ hits: WikiHit[] }>(
        sessionId,
        `/api/wiki/search?q=${encodeURIComponent(search.trim())}`,
      )
      setResults(body.hits ?? [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const runLint = async () => {
    setError(null)
    try {
      const body = await wikiRequest<{ findings: WikiFinding[] }>(sessionId, '/api/wiki/lint')
      setFindings(body.findings ?? [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const acceptProposal = async (id: string) => {
    try {
      await wikiRequest(sessionId, `/api/wiki/proposals/${encodeURIComponent(id)}/accept`, { method: 'POST' })
      setNotice(`已接受提案 ${id}`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const rejectProposal = async (id: string) => {
    if (!window.confirm(`拒绝提案 ${id}？`)) return
    try {
      await wikiRequest(sessionId, `/api/wiki/proposals/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const openVersion = async (revision: number) => {
    if (!selected?.id) return
    try {
      const body = await wikiRequest<{ text: string }>(
        sessionId,
        `/api/wiki/page/${encodeURIComponent(selected.id)}/versions/${revision}`,
      )
      setHistorical({ revision, text: body.text })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const jumpTo = (id: string) => {
    const nodes = contentRef.current?.querySelectorAll('h2, h3')
    if (!nodes) return
    const target = [...nodes].find(node => node.id === id)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setActiveHeading(id)
  }

  const pages = data?.pages ?? []
  const proposals = data?.proposals ?? []
  const stats = data?.stats
  const entries = results
    ? results.map(hit => ({
      id: hit.page,
      title: hit.title,
      meta: `${hit.page} › ${hit.heading}`,
    }))
    : pages.map(page => ({
      id: page.id,
      title: page.title,
      meta: `${page.id} · ${page.status}${page.sourced === false ? ' · 未溯源' : ''}`,
    }))

  return (
    <div className="kb-view">
      <aside className="kb-side">
        <div className="kb-side-head">
          <span className="kb-side-title">
            <FolderTreeIcon size={15} />
            资料库
          </span>
          <button className="icon-btn subtle" onClick={() => void load()} aria-label="刷新资料库" title="刷新">
            <RefreshIcon size={14} />
          </button>
        </div>

        <div className="kb-side-actions">
          <button className="btn kb-new-btn" onClick={startNew}>
            <PlusIcon size={14} />
            新建页面
          </button>
          <button className="btn ghost compact" onClick={runLint} title="检查断链与缺失来源">
            <CheckIcon size={13} />
            检查
          </button>
        </div>

        <div className="kb-search">
          <SearchIcon size={13} />
          <input
            value={search}
            placeholder="检索页面"
            aria-label="检索知识库"
            onChange={event => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch()
              if (event.key === 'Escape') {
                setSearch('')
                setResults(null)
              }
            }}
          />
          {results
            ? <button onClick={() => setResults(null)} aria-label="清除检索">×</button>
            : null}
        </div>

        <div className="kb-side-scroll">
          <section className="kb-section">
            <div className="kb-section-head">
              <span>{results ? `检索结果 ${results.length}` : '我的资料'}</span>
              <span className="kb-count">{results ? '' : pages.length}</span>
            </div>
            {entries.length
              ? entries.map(entry => (
                <button
                  key={`${entry.id}-${entry.title}`}
                  className={`kb-page ${selected?.id === entry.id ? 'active' : ''}`}
                  onClick={() => void open(entry.id)}
                >
                  <FileTextIcon size={14} />
                  <span className="kb-page-copy">
                    <strong>{entry.title}</strong>
                    <small>{entry.meta}</small>
                  </span>
                </button>
              ))
              : <div className="kb-empty-note">还没有页面。新建一页，或用 /wiki save 让模型生成提案。</div>}
          </section>

          {proposals.length
            ? (
              <section className="kb-section">
                <div className="kb-section-head">
                  <span>待审提案</span>
                  <span className="kb-count">{proposals.length}</span>
                </div>
                {proposals.map(proposal => (
                  <div className="kb-proposal" key={proposal.id}>
                    <span title={proposal.id}>{proposal.title}</span>
                    <button onClick={() => void acceptProposal(proposal.id)}>接受</button>
                    <button onClick={() => void rejectProposal(proposal.id)}>拒绝</button>
                  </div>
                ))}
              </section>
            )
            : null}

          {findings
            ? (
              <section className="kb-section">
                <div className="kb-section-head">
                  <span>检查结果</span>
                  <button className="kb-link" onClick={() => setFindings(null)}>收起</button>
                </div>
                {findings.length
                  ? findings.slice(0, 12).map((finding, index) => (
                    <div className="kb-finding" key={index}>
                      <span>{finding.kind}</span>
                      {finding.page ? <strong>{finding.page}</strong> : null}
                      {finding.detail}
                    </div>
                  ))
                  : <div className="kb-empty-note">没有发现问题。</div>}
              </section>
            )
            : null}
        </div>

        <div className="kb-side-foot">
          {stats
            ? <>{stats.pages} 页 · {stats.chunks} 块 · 可检索 {stats.ready}</>
            : '加载中…'}
          {stats?.unready ? <span> · 未就绪 {stats.unready}</span> : null}
        </div>
      </aside>

      <section className="kb-main">
        <header className="kb-doc-bar">
          <div className="kb-crumbs">
            我的资料
            <span>/</span>
            <strong>{selected?.meta.title || (mode === 'edit' ? '新页面' : '未选择')}</strong>
          </div>
          <div className="kb-doc-actions">
            {error ? <span className="kb-error" title={error}>{error}</span> : null}
            {notice && !error ? <span className="kb-notice">{notice}</span> : null}
            {selected
              ? mode === 'edit'
                ? (
                  <>
                    <button
                      className="btn ghost compact"
                      onClick={() => {
                        setMode('read')
                        if (!selected.id) setSelected(null)
                      }}
                      disabled={busy}
                    >
                      取消
                    </button>
                    <button
                      className="btn compact"
                      onClick={() => void save()}
                      disabled={busy || !draft.title.trim()}
                    >
                      {busy ? '保存中…' : '保存'}
                    </button>
                  </>
                )
                : (
                  <>
                    {selected.id
                      ? (
                        <button className="btn ghost compact" onClick={archive} disabled={busy}>
                          <ArchiveIcon size={13} />
                          归档
                        </button>
                      )
                      : null}
                    <button className="btn ghost compact" onClick={() => setMode('edit')}>
                      编辑
                    </button>
                  </>
                )
              : null}
          </div>
        </header>

        {selected
          ? mode === 'edit'
            ? (
              <div className="kb-editor">
                <input
                  className="kb-title-input"
                  value={draft.title}
                  placeholder="页面标题"
                  onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                />
                <input
                  className="kb-tags-input"
                  value={draft.tags}
                  placeholder="标签，用逗号分隔"
                  onChange={event => setDraft(current => ({ ...current, tags: event.target.value }))}
                />
                <textarea
                  className="kb-editor-body"
                  value={draft.body}
                  placeholder={'用 Markdown 写正文。\n\n## 小节标题\n\n- 要点'}
                  onChange={event => setDraft(current => ({ ...current, body: event.target.value }))}
                />
                <p className="kb-editor-hint">
                  保存后页面 ID 由标题生成；来源不存在的段落会在阅读页标记为“来源已变化”。
                </p>
              </div>
            )
            : (
              <div className="kb-doc-scroll" ref={scrollRef}>
                <article className="kb-doc" ref={contentRef}>
                  <h1>{selected.meta.title}</h1>
                  <div className="kb-doc-meta">
                    <span>r{selected.meta.revision}</span>
                    <span>{selected.meta.status}</span>
                    {selected.meta.tags?.length
                      ? selected.meta.tags.map(tag => <span className="kb-tag" key={tag}>{tag}</span>)
                      : null}
                  </div>

                  {selected.stale.length
                    ? (
                      <div className="kb-stale">
                        来源已变化：{selected.stale.map(item => `${item.path}（${item.reason === 'missing' ? '缺失' : '已更新'}）`).join('、')}
                      </div>
                    )
                    : null}

                  {selected.body.trim()
                    ? <MarkdownPreview content={selected.body} />
                    : <div className="kb-empty-note">这一页还没有正文。点“编辑”开始写。</div>}

                  {historical
                    ? (
                      <div className="kb-history">
                        <div className="kb-history-head">
                          <span>历史版本 r{historical.revision}（只读）</span>
                          <button className="kb-link" onClick={() => setHistorical(null)}>关闭</button>
                        </div>
                        <pre>{historical.text}</pre>
                      </div>
                    )
                    : null}

                  {backlinks.length || versions.length
                    ? (
                      <footer className="kb-doc-foot">
                        {backlinks.length
                          ? (
                            <div className="kb-foot-row">
                              <span className="kb-foot-label">反链</span>
                              {backlinks.map(link => (
                                <button className="kb-chip" key={link.id} onClick={() => void open(link.id)}>
                                  {link.title ?? link.id}
                                </button>
                              ))}
                            </div>
                          )
                          : null}
                        {versions.length
                          ? (
                            <div className="kb-foot-row">
                              <span className="kb-foot-label">
                                <ClockIcon size={12} />
                                历史
                              </span>
                              {versions.map(revision => (
                                <button className="kb-chip" key={revision} onClick={() => void openVersion(revision)}>
                                  r{revision}
                                </button>
                              ))}
                            </div>
                          )
                          : null}
                      </footer>
                    )
                    : null}
                </article>

                {headings.length
                  ? (
                    <aside className="kb-toc" aria-label="目录">
                      <div className="kb-toc-title">目录</div>
                      {headings.map(heading => (
                        <button
                          key={`${heading.id}-${heading.text}`}
                          className={`kb-toc-item depth-${heading.depth} ${activeHeading === heading.id ? 'active' : ''}`}
                          onClick={() => jumpTo(heading.id)}
                        >
                          {heading.text}
                        </button>
                      ))}
                    </aside>
                  )
                  : null}
              </div>
            )
          : (
            <div className="kb-empty">
              <FolderTreeIcon size={32} />
              <h2>从一个页面开始</h2>
              <p>知识库保存项目里值得反复使用的事实、决策与做法。页面是 Markdown，始终由你掌控。</p>
              <button className="btn" onClick={startNew}>
                <PlusIcon size={14} />
                新建页面
              </button>
            </div>
          )}
      </section>
    </div>
  )
}

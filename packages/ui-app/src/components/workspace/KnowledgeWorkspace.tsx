import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type WikiCatalogGroup,
  type WikiLintFinding,
  type WikiPageMeta,
  type WikiPageSummary,
  type WikiProposalDetail,
  type WikiSearchHit,
  type WikiSource,
} from '../../api.ts'
import { useConfirm } from '../ConfirmDialog.tsx'
import { usePrompt } from '../PromptDialog.tsx'
import {
  AlertIcon, ArchiveIcon, CheckIcon, ClockIcon, FolderTreeIcon, PlusIcon, RefreshIcon, SearchIcon,
} from '../Icons.tsx'
import { MarkdownPreview, markdownHeadingId } from '../MarkdownPreview.tsx'

interface WikiIndex {
  pages: WikiPageSummary[]
  proposals: Array<{ id: string; title: string; path: string }>
  catalog: WikiCatalogGroup[]
  stats: { pages: number; chunks: number; ready: number; unready: number; catalogChars: number }
}

interface WikiPageDetail {
  id: string
  meta: WikiPageMeta
  body: string
  stale: Array<{ path: string; reason: string }>
}

interface Heading {
  id: string
  text: string
  depth: number
}

type LeftView = 'pages' | 'proposals' | 'catalog' | 'lint'
type CenterMode = 'empty' | 'read' | 'edit' | 'proposal' | 'proposal-edit'
type StatusFilter = 'all' | 'ready' | 'review' | 'draft'

const STATUS_LABEL: Record<string, string> = {
  ready: '就绪',
  draft: '草稿',
  processing: '处理中',
  stale: '已过期',
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
}

const LINT_LABEL: Record<string, string> = {
  'broken-link': '断链',
  orphan: '孤儿页',
  'missing-summary': '缺摘要',
  'stale-source': '来源过期',
  'duplicate-title': '重名',
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
  const confirm = useConfirm()
  const ask = usePrompt()
  const [data, setData] = useState<WikiIndex | null>(null)
  const [view, setView] = useState<LeftView>('pages')
  const [mode, setMode] = useState<CenterMode>('empty')
  const [selected, setSelected] = useState<WikiPageDetail | null>(null)
  const [draft, setDraft] = useState({ title: '', body: '', tags: '' })
  const [proposal, setProposal] = useState<WikiProposalDetail | null>(null)
  const [proposalDraft, setProposalDraft] = useState({ title: '', body: '', tags: '' })
  const [proposalPane, setProposalPane] = useState<'diff' | 'full'>('diff')
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<WikiSearchHit[] | null>(null)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [tagFilter, setTagFilter] = useState('')
  const [backlinks, setBacklinks] = useState<Array<{ id: string; title?: string }>>([])
  const [versions, setVersions] = useState<number[]>([])
  const [historical, setHistorical] = useState<{ revision: number; text: string } | null>(null)
  const [diff, setDiff] = useState<{ label: string; text: string } | null>(null)
  const [findings, setFindings] = useState<WikiLintFinding[] | null>(null)
  const [linting, setLinting] = useState(false)
  const [catalogPage, setCatalogPage] = useState('')
  const [catalogGroup, setCatalogGroup] = useState('')
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeHeading, setActiveHeading] = useState('')
  const [pendingHeading, setPendingHeading] = useState<string | null>(null)
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

  const open = async (id: string, heading?: string) => {
    setError(null)
    setHistorical(null)
    setDiff(null)
    setProposal(null)
    setHits(null)
    try {
      const page = await wikiRequest<{ meta: WikiPageMeta; body: string; stale: Array<{ path: string; reason: string }> }>(
        sessionId,
        `/api/wiki/page/${encodeURIComponent(id)}`,
      )
      setSelected({ id, ...page })
      setDraft({ title: page.meta.title, body: page.body, tags: (page.meta.tags ?? []).join(', ') })
      setMode('read')
      setActiveHeading(headingsOf(page.body)[0]?.id ?? '')
      const targetHeading = heading?.split(' > ').pop()
      setPendingHeading(targetHeading ? markdownHeadingId(targetHeading) : null)
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

  const openProposal = async (id: string) => {
    setError(null)
    setNotice(null)
    setDiff(null)
    setHistorical(null)
    try {
      const detail = await api.getWikiProposal(id, sessionId)
      setProposal(detail)
      setProposalDraft({ title: detail.meta.title, body: detail.body, tags: (detail.meta.tags ?? []).join(', ') })
      setProposalPane('diff')
      setMode('proposal')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const addToCatalog = async (id: string, group?: string) => {
    setCatalogBusy(true)
    setError(null)
    try {
      const result = await api.addWikiCatalogEntry(id, group, sessionId)
      setData(current => current ? { ...current, catalog: result.catalog } : current)
      setCatalogPage('')
      setNotice(`已把 ${id} 加入${group ? `「${group}」` : '目录'}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCatalogBusy(false)
    }
  }

  const removeFromCatalog = async (id: string) => {
    setCatalogBusy(true)
    setError(null)
    try {
      const result = await api.removeWikiCatalogEntry(id, sessionId)
      setData(current => current ? { ...current, catalog: result.catalog } : current)
      setNotice(`已把 ${id} 移出目录`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCatalogBusy(false)
    }
  }

  const createCatalogGroup = async () => {
    const name = await ask({
      title: '新建目录',
      placeholder: '目录名称',
      body: '例如：架构、SOP、调研。',
      confirmLabel: '创建',
    })
    if (!name) return
    setCatalogBusy(true)
    setError(null)
    try {
      const result = await api.createWikiCatalogGroup(name, sessionId)
      setData(current => current ? { ...current, catalog: result.catalog } : current)
      setCatalogGroup(name)
      setNotice(`已创建目录「${name}」`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCatalogBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setSelected(null)
    setProposal(null)
    setMode('empty')
    setView('pages')
    setHits(null)
    setSearch('')
    setFindings(null)
    setStatusFilter('all')
    setTagFilter('')
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

  const headings = useMemo(() => selected && mode === 'read' ? headingsOf(selected.body) : [], [selected, mode])

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

  // A search hit names a heading; scroll to it once the page has rendered.
  useEffect(() => {
    if (!pendingHeading || mode !== 'read') return
    const nodes = contentRef.current?.querySelectorAll('h2, h3')
    if (!nodes?.length) return
    const target = [...nodes].find(node => node.id === pendingHeading)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setActiveHeading(pendingHeading)
    setPendingHeading(null)
  }, [pendingHeading, mode, selected?.id])

  const startNew = () => {
    setProposal(null)
    setSelected({
      id: '',
      meta: { id: '', title: '', tags: [], sources: [], confidence: 'low', status: 'draft', revision: 0 },
      body: '',
      stale: [],
    })
    setDraft({ title: '', body: '', tags: '' })
    setBacklinks([])
    setVersions([])
    setHistorical(null)
    setDiff(null)
    setHits(null)
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
      setFindings(null)
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
    if (!selected?.id) return
    const ok = await confirm({
      title: '归档页面',
      body: `「${selected.meta.title}」会从工作区移出，可以从归档视图恢复。`,
      confirmLabel: '归档',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await wikiRequest(sessionId, `/api/wiki/page/${encodeURIComponent(selected.id)}`, { method: 'DELETE' })
      setSelected(null)
      setMode('empty')
      setFindings(null)
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
      setHits(null)
      return
    }
    setError(null)
    try {
      const body = await wikiRequest<{ hits: WikiSearchHit[]; truncated?: boolean }>(
        sessionId,
        `/api/wiki/search?q=${encodeURIComponent(search.trim())}`,
      )
      setHits(body.hits ?? [])
      setSearchTruncated(Boolean(body.truncated))
      setView('pages')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const runLint = async () => {
    setLinting(true)
    setError(null)
    try {
      const body = await wikiRequest<{ findings: WikiLintFinding[] }>(sessionId, '/api/wiki/lint')
      setFindings(body.findings ?? [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLinting(false)
    }
  }

  const acceptProposal = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await wikiRequest(sessionId, `/api/wiki/proposals/${encodeURIComponent(id)}/accept`, { method: 'POST' })
      setNotice(`已接受提案 ${id}`)
      setProposal(null)
      setFindings(null)
      await load()
      await open(id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const rejectProposal = async (id: string) => {
    const ok = await confirm({
      title: '拒绝提案',
      body: `提案 ${id} 会被删除，页面保持原样。`,
      confirmLabel: '拒绝',
      danger: true,
    })
    if (!ok) return
    try {
      await wikiRequest(sessionId, `/api/wiki/proposals/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setProposal(null)
      setMode('empty')
      setNotice('已拒绝提案')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const saveProposal = async (accept = false) => {
    if (!proposal) return
    setBusy(true)
    setError(null)
    try {
      const tags = proposalDraft.tags.split(',').map(value => value.trim()).filter(Boolean)
      await api.updateWikiProposal(proposal.id, {
        title: proposalDraft.title,
        body: proposalDraft.body,
        tags,
      }, sessionId)
      if (accept) {
        await acceptProposal(proposal.id)
      } else {
        const detail = await api.getWikiProposal(proposal.id, sessionId)
        setProposal(detail)
        setProposalDraft({ title: detail.meta.title, body: detail.body, tags: (detail.meta.tags ?? []).join(', ') })
        setMode('proposal')
        setNotice('提案已更新，页面仍未修改')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
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
      setDiff(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const compare = async (from: number, to: number, label: string) => {
    if (!selected?.id) return
    try {
      const text = await api.getWikiDiff(selected.id, from, to, sessionId)
      setDiff({ label, text })
      setHistorical(null)
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
  const catalogGroups = data?.catalog ?? []
  const catalogIds = new Set(catalogGroups.flatMap(group => group.entries.map(entry => entry.id)))
  const catalogCount = catalogGroups.reduce((sum, group) => sum + group.entries.length, 0)
  const availablePages = pages.filter(page => !catalogIds.has(page.id))
  const selectedGroup = selected
    ? catalogGroups.find(group => group.entries.some(entry => entry.id === selected.id))?.name ?? ''
    : ''
  const selectedInCatalog = Boolean(selected?.id && catalogIds.has(selected.id))
  const proposals = data?.proposals ?? []
  const stats = data?.stats
  const tags = useMemo(() => [...new Set(pages.flatMap(page => page.tags ?? []))].sort(), [pages])
  const filteredPages = pages.filter((page) => {
    if (tagFilter && !(page.tags ?? []).includes(tagFilter)) return false
    if (statusFilter === 'ready') return page.status === 'ready'
    if (statusFilter === 'draft') return page.status === 'draft' || page.status === 'processing'
    if (statusFilter === 'review') {
      return page.status === 'stale' || page.sourced === false || page.confidence === 'low' || !page.summary
    }
    return true
  })
  const lintGroups = useMemo(() => {
    const groups = new Map<string, WikiLintFinding[]>()
    for (const finding of findings ?? []) {
      groups.set(finding.kind, [...(groups.get(finding.kind) ?? []), finding])
    }
    return [...groups.entries()]
  }, [findings])

  const selectView = (next: LeftView) => {
    setView(next)
    setHits(null)
    setSearch('')
    if (next === 'lint' && findings === null) void runLint()
  }

  const proposalMode = mode === 'proposal' || mode === 'proposal-edit'
  const crumb = proposalMode ? '待审提案' : '我的资料'
  const crumbTitle = proposalMode
    ? proposal?.meta.title ?? '提案'
    : selected?.meta.title || (mode === 'edit' ? '新页面' : '未选择')

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
          <button className="btn ghost compact" onClick={() => { setView('lint'); void runLint() }} title="检查断链、孤儿页与过期来源">
            <CheckIcon size={13} />
            检查
          </button>
        </div>

        <div className="kb-search">
          <SearchIcon size={13} />
          <input
            value={search}
            placeholder="检索页面（BM25）"
            aria-label="检索知识库"
            onChange={event => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch()
              if (event.key === 'Escape') {
                setSearch('')
                setHits(null)
              }
            }}
          />
          {hits ? <button onClick={() => { setSearch(''); setHits(null) }} aria-label="清除检索">×</button> : null}
        </div>

        <div className="kb-views" role="tablist" aria-label="知识库视图">
          <button role="tab" aria-selected={view === 'pages' && !hits} className={view === 'pages' && !hits ? 'active' : ''} onClick={() => selectView('pages')}>
            页面<span>{pages.length}</span>
          </button>
          <button role="tab" aria-selected={view === 'proposals'} className={view === 'proposals' ? 'active' : ''} onClick={() => selectView('proposals')}>
            提案<span>{proposals.length}</span>
          </button>
          <button role="tab" aria-selected={view === 'catalog'} className={view === 'catalog' ? 'active' : ''} onClick={() => selectView('catalog')}>
            目录<span>{catalogCount}</span>
          </button>
          <button role="tab" aria-selected={view === 'lint'} className={view === 'lint' ? 'active' : ''} onClick={() => selectView('lint')}>
            检查<span>{findings?.length ?? ''}</span>
          </button>
        </div>

        <div className="kb-side-scroll">
          {hits
            ? (
              <section className="kb-section">
                <div className="kb-section-head">
                  <span>检索结果 {hits.length}{searchTruncated ? '+' : ''}</span>
                  <button className="kb-link" onClick={() => { setSearch(''); setHits(null) }}>清除</button>
                </div>
                {hits.length
                  ? hits.map(hit => (
                    <button
                      key={`${hit.page}-${hit.heading}`}
                      className="kb-hit"
                      onClick={() => void open(hit.page, hit.heading)}
                    >
                      <strong>{hit.title} › {hit.heading}</strong>
                      <small>{hit.summary || hit.snippet}</small>
                    </button>
                  ))
                  : <div className="kb-empty-note">没有匹配的页面。</div>}
              </section>
            )
            : view === 'pages'
              ? (
                <>
                  <div className="kb-filter-row">
                    {([
                      ['all', '全部'],
                      ['ready', '就绪'],
                      ['review', '需复核'],
                      ['draft', '草稿'],
                    ] as Array<[StatusFilter, string]>).map(([id, label]) => (
                      <button
                        key={id}
                        className={`kb-filter ${statusFilter === id ? 'active' : ''}`}
                        onClick={() => setStatusFilter(id)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {tags.length
                    ? (
                      <select
                        className="kb-tag-select"
                        value={tagFilter}
                        onChange={event => setTagFilter(event.target.value)}
                        aria-label="按标签筛选"
                      >
                        <option value="">全部标签</option>
                        {tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
                      </select>
                    )
                    : null}
                  <section className="kb-section">
                    <div className="kb-section-head">
                      <span>我的资料</span>
                      <span className="kb-count">{filteredPages.length}</span>
                    </div>
                    {filteredPages.length
                      ? filteredPages.map(page => (
                        <button
                          key={page.id}
                          className={`kb-page ${selected?.id === page.id && !proposalMode ? 'active' : ''}`}
                          onClick={() => void open(page.id)}
                        >
                          <span className={`kb-page-dot ${page.status === 'ready' ? 'ok' : page.status === 'stale' ? 'warn' : 'off'}`} />
                          <span className="kb-page-copy">
                            <strong>{page.title}</strong>
                            {page.summary ? <small className="kb-page-summary">{page.summary}</small> : null}
                            <small>
                              {page.id}
                              {page.confidence ? ` · ${CONFIDENCE_LABEL[page.confidence] ?? page.confidence}` : ''}
                              {page.sourced === false ? ' · 未溯源' : ''}
                              {page.tags?.length ? ` · ${page.tags.join(' / ')}` : ''}
                            </small>
                          </span>
                        </button>
                      ))
                      : <div className="kb-empty-note">{pages.length ? '没有符合筛选条件的页面。' : '还没有页面。新建一页，或用 /wiki save 让模型生成提案。'}</div>}
                  </section>
                </>
              )
              : view === 'proposals'
                ? (
                  <section className="kb-section">
                    <div className="kb-section-head">
                      <span>待审提案</span>
                      <span className="kb-count">{proposals.length}</span>
                    </div>
                    {proposals.length
                      ? proposals.map(item => (
                        <button
                          key={item.id}
                          className={`kb-page ${proposalMode && proposal?.id === item.id ? 'active' : ''}`}
                          onClick={() => void openProposal(item.id)}
                        >
                          <span className="kb-page-dot warn" />
                          <span className="kb-page-copy">
                            <strong>{item.title}</strong>
                            <small>{item.id} · 接受前不会修改页面</small>
                          </span>
                        </button>
                      ))
                      : <div className="kb-empty-note">没有待审提案。让模型用 /wiki save 生成，或直接新建页面。</div>}
                  </section>
                )
                : view === 'catalog'
                  ? (
                    <>
                      <div className="kb-catalog-tools">
                        <select
                          className="kb-tag-select"
                          value={catalogGroup}
                          onChange={event => setCatalogGroup(event.target.value)}
                          aria-label="选择目录分组"
                        >
                          <option value="">未分组</option>
                          {catalogGroups.filter(group => group.name).map(group => (
                            <option key={group.name} value={group.name}>{group.name}</option>
                          ))}
                        </select>
                        <select
                          className="kb-tag-select"
                          value={catalogPage}
                          onChange={event => setCatalogPage(event.target.value)}
                          aria-label="选择要加入目录的页面"
                        >
                          <option value="">选择页面</option>
                          {availablePages.map(page => (
                            <option key={page.id} value={page.id}>{page.title}</option>
                          ))}
                        </select>
                        <button
                          className="btn ghost compact"
                          disabled={!catalogPage || catalogBusy}
                          onClick={() => void addToCatalog(catalogPage, catalogGroup || undefined)}
                        >
                          加入
                        </button>
                      </div>
                      <button className="kb-link kb-catalog-new" onClick={() => void createCatalogGroup()} disabled={catalogBusy}>
                        + 新建目录
                      </button>
                      {catalogGroups.length
                        ? catalogGroups.map(group => (
                          <section className="kb-catalog-group" key={group.name || '__ungrouped'}>
                            <div className="kb-catalog-head">
                              <span>{group.name || '未分组'}</span>
                              <span className="kb-count">{group.entries.length}</span>
                            </div>
                            {group.entries.length
                              ? group.entries.map(entry => (
                                <div className="kb-catalog-row" key={entry.id}>
                                  <button className="kb-catalog-entry" onClick={() => void open(entry.id)}>
                                    <strong>{entry.title}</strong>
                                    <small>{entry.id}</small>
                                  </button>
                                  <button
                                    className="kb-link"
                                    disabled={catalogBusy}
                                    onClick={() => void removeFromCatalog(entry.id)}
                                  >
                                    移出
                                  </button>
                                </div>
                              ))
                              : <div className="kb-empty-note">这个目录还没有页面。</div>}
                          </section>
                        ))
                        : <div className="kb-empty-note">还没有目录。新建一个目录，再把页面加进去，孤儿页就会消失。</div>}
                    </>
                  )
                : (
                  <section className="kb-section">
                    <div className="kb-section-head">
                      <span>治理检查</span>
                      <button className="kb-link" onClick={() => void runLint()} disabled={linting}>
                        {linting ? '检查中…' : '重新检查'}
                      </button>
                    </div>
                    {findings === null
                      ? <div className="kb-empty-note">点击「重新检查」扫描断链、孤儿页、缺摘要、来源过期与重名。</div>
                      : findings.length
                        ? (
                          <>
                            {lintGroups.map(([kind, list]) => (
                              <div className="kb-lint-group" key={kind}>
                                <div className="kb-lint-head">
                                  <span className={`kb-lint-kind ${kind === 'broken-link' ? 'danger' : 'warn'}`}>
                                    {LINT_LABEL[kind] ?? kind}
                                  </span>
                                  <span className="kb-count">{list.length}</span>
                                </div>
                                {list.map((finding, index) => (
                                  <button
                                    key={`${kind}-${index}`}
                                    className="kb-lint-row"
                                    disabled={!finding.page}
                                    onClick={() => finding.page && void open(finding.page)}
                                  >
                                    {finding.page ? <code>{finding.page}</code> : null}
                                    <span>{finding.detail}</span>
                                  </button>
                                ))}
                              </div>
                            ))}
                          </>
                        )
                        : <div className="kb-empty-note">没有发现问题。</div>}
                  </section>
                )}
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
            {crumb}
            <span>/</span>
            <strong>{crumbTitle}</strong>
          </div>
          <div className="kb-doc-actions">
            {error ? <span className="kb-error" title={error}>{error}</span> : null}
            {notice && !error ? <span className="kb-notice">{notice}</span> : null}
            {proposal && proposalMode
              ? (mode === 'proposal-edit'
                ? (
                  <>
                    <button
                      className="btn ghost compact"
                      onClick={() => {
                        setProposalDraft({
                          title: proposal.meta.title,
                          body: proposal.body,
                          tags: (proposal.meta.tags ?? []).join(', '),
                        })
                        setMode('proposal')
                      }}
                      disabled={busy}
                    >
                      取消
                    </button>
                    <button className="btn ghost compact" onClick={() => void saveProposal(false)} disabled={busy || !proposalDraft.title.trim()}>
                      {busy ? '保存中…' : '保存提案'}
                    </button>
                    <button className="btn compact" onClick={() => void saveProposal(true)} disabled={busy || !proposalDraft.title.trim()}>
                      保存并接受
                    </button>
                  </>
                )
                : (
                  <>
                    <button className="btn ghost compact" onClick={() => void rejectProposal(proposal.id)} disabled={busy}>
                      拒绝
                    </button>
                    <button className="btn ghost compact" onClick={() => setMode('proposal-edit')} disabled={busy}>
                      编辑后接受
                    </button>
                    <button className="btn compact" onClick={() => void acceptProposal(proposal.id)} disabled={busy}>
                      {busy ? '处理中…' : '接受提案'}
                    </button>
                  </>
                ))
              : selected
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
                      <button className="btn compact" onClick={() => void save()} disabled={busy || !draft.title.trim()}>
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
                      <button className="btn ghost compact" onClick={() => setMode('edit')}>编辑</button>
                    </>
                  )
                : null}
          </div>
        </header>

        {proposalMode && proposal
          ? (
            <ProposalReview
              proposal={proposal}
              pane={proposalPane}
              onPaneChange={setProposalPane}
              editing={mode === 'proposal-edit'}
              draft={proposalDraft}
              onDraftChange={setProposalDraft}
            />
          )
          : selected
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
                    placeholder={'用 Markdown 写正文。\n\n## 摘要\n\n一段不超过 300 字的摘要。\n\n## 正文'}
                    onChange={event => setDraft(current => ({ ...current, body: event.target.value }))}
                  />
                  <p className="kb-editor-hint">
                    保存后页面 ID 由标题生成；摘要会成为检索结果的 L0，来源不存在的段落会在阅读页标记。
                  </p>
                </div>
              )
              : (
                <div className={`kb-doc-scroll ${headings.length ? '' : 'solo'}`} ref={scrollRef}>
                  <article className="kb-doc" ref={contentRef}>
                    <h1>{selected.meta.title}</h1>
                    <div className="kb-doc-meta">
                      <span className={`kb-status ${selected.meta.status}`}>
                        {STATUS_LABEL[selected.meta.status] ?? selected.meta.status}
                      </span>
                      <span className={`kb-confidence ${selected.meta.confidence ?? 'low'}`}>
                        {CONFIDENCE_LABEL[selected.meta.confidence ?? 'low'] ?? '未标注'}
                      </span>
                      <span>r{selected.meta.revision}</span>
                      {selected.meta.updated ? <span>{selected.meta.updated.slice(0, 10)}</span> : null}
                      <span>{selected.id}</span>
                      <span
                        className={`kb-catalog ${selectedInCatalog ? 'ok' : 'off'}`}
                        title="手动加入 index.md 的目录分组；ready、已溯源且有摘要的页面也会自动进入模型目录"
                      >
                        {selectedInCatalog ? `${selectedGroup ? `${selectedGroup} · ` : ''}目录内` : '未入目录'}
                      </span>
                      {selected.id
                        ? (
                          <button
                            className="kb-link"
                            disabled={catalogBusy}
                            onClick={() => {
                              if (selectedInCatalog) void removeFromCatalog(selected.id)
                              else void addToCatalog(selected.id)
                            }}
                          >
                            {selectedInCatalog ? '移出目录' : '加入目录'}
                          </button>
                        )
                        : null}
                      {/^##\s*冲突/m.test(selected.body)
                        ? <span className="kb-status stale">冲突未消解</span>
                        : null}
                      {selected.meta.tags?.length
                        ? selected.meta.tags.map(tag => (
                          <button
                            key={tag}
                            className="kb-tag"
                            onClick={() => {
                              setTagFilter(tag)
                              setStatusFilter('all')
                              setView('pages')
                              setHits(null)
                            }}
                          >
                            {tag}
                          </button>
                        ))
                        : null}
                    </div>

                    <SourceList sources={selected.meta.sources ?? []} stale={selected.stale} />

                    {selected.stale.length
                      ? (
                        <div className="kb-stale">
                          <AlertIcon size={13} />
                          <span>
                            来源已变化：{selected.stale.map(item => `${item.path}（${item.reason === 'missing' ? '缺失' : '已更新'}）`).join('、')}。页面不会自动改写。
                          </span>
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
                            <span className="kb-history-actions">
                              <button
                                className="kb-link"
                                onClick={() => void compare(historical.revision, selected.meta.revision, `r${historical.revision} → r${selected.meta.revision}`)}
                              >
                                与当前对比
                              </button>
                              <button className="kb-link" onClick={() => setHistorical(null)}>关闭</button>
                            </span>
                          </div>
                          <pre>{historical.text}</pre>
                        </div>
                      )
                      : null}

                    {diff
                      ? (
                        <div className="kb-diff-panel">
                          <div className="kb-history-head">
                            <span>{diff.label}</span>
                            <button className="kb-link" onClick={() => setDiff(null)}>关闭</button>
                          </div>
                          <DiffView text={diff.text} />
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
                                {versions.length && versions[versions.length - 1] !== selected.meta.revision
                                  ? (
                                    <button
                                      className="kb-chip"
                                      onClick={() => void compare(
                                        versions[versions.length - 1]!,
                                        selected.meta.revision,
                                        `r${versions[versions.length - 1]} → 当前 r${selected.meta.revision}`,
                                      )}
                                    >
                                      与当前对比
                                    </button>
                                  )
                                  : null}
                                {versions.length >= 2
                                  ? (
                                    <button
                                      className="kb-chip"
                                      onClick={() => void compare(
                                        versions[versions.length - 2]!,
                                        versions[versions.length - 1]!,
                                        `r${versions[versions.length - 2]} → r${versions[versions.length - 1]}`,
                                      )}
                                    >
                                      对比最近两版
                                    </button>
                                  )
                                  : null}
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
                <h2>{proposals.length ? '有提案等待审阅' : '从一个页面开始'}</h2>
                <p>
                  {proposals.length
                    ? '模型生成的页面变更先进入提案，接受后才会改动页面。'
                    : '知识库保存项目里值得反复使用的事实、决策与做法。页面是 Markdown，始终由你掌控。'}
                </p>
                <div className="kb-empty-actions">
                  {proposals.length ? <button className="btn" onClick={() => selectView('proposals')}>查看 {proposals.length} 个提案</button> : null}
                  <button className="btn ghost" onClick={startNew}>
                    <PlusIcon size={14} />
                    新建页面
                  </button>
                </div>
              </div>
            )}
      </section>
    </div>
  )
}

function SourceList({ sources, stale }: {
  sources: WikiSource[]
  stale: Array<{ path: string; reason: string }>
}) {
  if (!sources.length) {
    return (
      <div className="kb-sources kb-sources-empty">
        <AlertIcon size={13} />
        未溯源：这页不会进入目录摘要，检索结果也会标为低置信。
      </div>
    )
  }
  return (
    <div className="kb-sources">
      <span className="kb-sources-label">来源 {sources.length}</span>
      {sources.map((source, index) => {
        const changed = source.path ? stale.find(item => item.path === source.path) : undefined
        return (
          <span className={`kb-source ${changed ? 'stale' : ''}`} key={`${source.kind}-${index}`}>
            <span className="kb-source-kind">
              {source.kind === 'file' ? '文件' : source.kind === 'session' ? '会话' : 'URL'}
            </span>
            <code>
              {source.path
                ?? (source.session ? `session ${source.session.slice(0, 8)}` : '外部来源')}
            </code>
            {source.hash ? <small>{source.hash.slice(0, 8)}</small> : null}
            {changed ? <em>{changed.reason === 'missing' ? '缺失' : '已变化'}</em> : null}
          </span>
        )
      })}
    </div>
  )
}

function ProposalReview({ proposal, pane, onPaneChange, editing, draft, onDraftChange }: {
  proposal: WikiProposalDetail
  pane: 'diff' | 'full'
  onPaneChange: (pane: 'diff' | 'full') => void
  editing: boolean
  draft: { title: string; body: string; tags: string }
  onDraftChange: (next: { title: string; body: string; tags: string }) => void
}) {
  if (editing) {
    return (
      <div className="kb-editor">
        <input
          className="kb-title-input"
          value={draft.title}
          placeholder="页面标题"
          onChange={event => onDraftChange({ ...draft, title: event.target.value })}
        />
        <input
          className="kb-tags-input"
          value={draft.tags}
          placeholder="标签，用逗号分隔"
          onChange={event => onDraftChange({ ...draft, tags: event.target.value })}
        />
        <textarea
          className="kb-editor-body"
          value={draft.body}
          onChange={event => onDraftChange({ ...draft, body: event.target.value })}
        />
        <p className="kb-editor-hint">
          这里修改的是提案文件本身；接受之前不会触碰页面。
        </p>
      </div>
    )
  }

  const existing = proposal.existing
  const metaChanges: string[] = []
  if (existing && existing.meta.title !== proposal.meta.title) {
    metaChanges.push(`标题：${existing.meta.title} → ${proposal.meta.title}`)
  }
  if (existing && (existing.meta.tags ?? []).join(',') !== (proposal.meta.tags ?? []).join(',')) {
    metaChanges.push(`标签：${(existing.meta.tags ?? []).join(' / ') || '无'} → ${(proposal.meta.tags ?? []).join(' / ') || '无'}`)
  }

  return (
    <div className="kb-proposal-scroll">
      <article className="kb-doc">
        <div className="kb-doc-meta">
          <span className="kb-status draft">提案</span>
          <span className={`kb-confidence ${proposal.meta.confidence ?? 'low'}`}>
            {CONFIDENCE_LABEL[proposal.meta.confidence ?? 'low'] ?? '未标注'}
          </span>
          <span>{proposal.existing ? `更新 ${proposal.existing.meta.id}` : '新建页面'}</span>
          <span>{proposal.path}</span>
        </div>
        <h1>{proposal.meta.title}</h1>
        <SourceList sources={proposal.meta.sources ?? []} stale={[]} />

        {metaChanges.length
          ? <div className="kb-proposal-meta-changes">{metaChanges.map(change => <div key={change}>{change}</div>)}</div>
          : null}

        <div className="kb-proposal-tabs">
          <button className={pane === 'diff' ? 'active' : ''} onClick={() => onPaneChange('diff')}>差异</button>
          <button className={pane === 'full' ? 'active' : ''} onClick={() => onPaneChange('full')}>完整提案</button>
        </div>

        {pane === 'diff'
          ? <DiffView text={proposal.diff} />
          : <MarkdownPreview content={proposal.body} />}

        {proposal.existing
          ? (
            <p className="kb-proposal-note">
              接受后会覆盖现有页面 <code>{proposal.existing.meta.id}</code>（r{proposal.existing.meta.revision}），旧版本仍保留在历史中。
            </p>
          )
          : null}
      </article>
    </div>
  )
}

function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="kb-empty-note">与当前页面没有文本差异。</div>
  return (
    <pre className="kb-diff">
      {text.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-') ? 'del' : ''
        return <div className={`kb-diff-line ${kind}`} key={index}>{line || ' '}</div>
      })}
    </pre>
  )
}

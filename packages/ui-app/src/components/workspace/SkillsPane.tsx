import { useEffect, useRef, useState } from 'react'
import {
  api, type SkillHubCategory, type SkillHubSkill, type SkillSummary,
} from '../../api.ts'
import { useConfirm } from '../ConfirmDialog.tsx'
import {
  BotIcon, CheckIcon, CommandIcon, EyeIcon, PlusIcon, RefreshIcon,
} from '../Icons.tsx'

interface SkillProposal {
  name: string
  description: string
}

const SORTS: Array<{ id: string; label: string }> = [
  { id: 'score', label: '综合' },
  { id: 'downloads', label: '下载最多' },
  { id: 'updated_at', label: '最近更新' },
]

function compact(value?: number) {
  if (!value) return '0'
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

async function proposalRequest<T>(sessionId: string | undefined, path: string, options: RequestInit = {}): Promise<T> {
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

export function SkillsPane({ sessionId, query }: {
  sessionId?: string
  query: string
}) {
  const confirm = useConfirm()
  const [installed, setInstalled] = useState<SkillSummary[]>([])
  const [proposals, setProposals] = useState<SkillProposal[]>([])
  const [categories, setCategories] = useState<SkillHubCategory[]>([])
  const [showcase, setShowcase] = useState<SkillHubSkill[]>([])
  const [hub, setHub] = useState<SkillHubSkill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('score')
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installedSlugs, setInstalledSlugs] = useState<Map<string, string>>(new Map())
  const requestId = useRef(0)

  const refreshInstalled = async () => {
    setInstalled(await api.getSkills(sessionId))
    if (!sessionId) {
      setProposals([])
      return
    }
    const pending = await proposalRequest<{ proposals: SkillProposal[] }>(sessionId, '/api/skill-proposals')
      .catch(() => ({ proposals: [] }))
    setProposals(pending.proposals ?? [])
  }

  useEffect(() => {
    let cancelled = false
    setInstalled([])
    setProposals([])
    setInstalledSlugs(new Map())
    void refreshInstalled().catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
    })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([api.getSkillHubCategories(), api.getSkillHubShowcase('recommended')])
      .then(([categoryResult, showcaseResult]) => {
        if (cancelled) return
        if (categoryResult.status === 'fulfilled') setCategories(categoryResult.value.filter(item => item.active !== false))
        if (showcaseResult.status === 'fulfilled') setShowcase(showcaseResult.value.slice(0, 5))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const fetchHub = async (nextPage: number, append: boolean) => {
    const id = ++requestId.current
    if (append) setMore(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await api.getSkillHubSkills({
        page: nextPage,
        pageSize: 30,
        keyword: query,
        category: category || undefined,
        sortBy: sort,
        order: 'desc',
      })
      if (id !== requestId.current) return
      setHub(current => append ? [...current, ...result.skills] : result.skills)
      setTotal(result.total)
      setPage(nextPage)
    } catch (caught) {
      if (id !== requestId.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
      if (!append) setHub([])
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setMore(false)
      }
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => { void fetchHub(1, false) }, query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [query, category, sort])

  const install = async (skill: SkillHubSkill) => {
    if (!sessionId || installing) return
    setInstalling(skill.slug)
    setError(null)
    setNotice(null)
    try {
      const result = await api.installSkillHubSkill(skill.slug, sessionId)
      setInstalledSlugs(current => new Map(current).set(skill.slug, result.name))
      setNotice(`已安装 ${result.name} → ${result.path}`)
      await refreshInstalled()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setInstalling(null)
    }
  }

  const removeSkill = async (skill: SkillSummary) => {
    if (!sessionId) return
    const ok = await confirm({
      title: '移除技能',
      body: `/${skill.name} 会从当前工作区卸载，可以重新安装。`,
      confirmLabel: '移除',
      danger: true,
    })
    if (!ok) return
    setError(null)
    try {
      await api.uninstallSkillHubSkill(skill.name, sessionId)
      setInstalledSlugs(current => {
        const next = new Map(current)
        for (const [slug, name] of next) {
          if (name === skill.name) next.delete(slug)
        }
        return next
      })
      setNotice(`已移除 /${skill.name}`)
      await refreshInstalled()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const refresh = () => {
    void fetchHub(1, false)
    void refreshInstalled().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
    void api.getSkillHubShowcase('recommended').then(list => setShowcase(list.slice(0, 5))).catch(() => undefined)
  }

  const installedNames = new Set(installed.map(skill => skill.name.toLowerCase()))
  const isInstalled = (skill: SkillHubSkill) => {
    if (installedSlugs.has(skill.slug)) return true
    const candidates = [
      skill.slug,
      skill.namespace?.publicSlug,
      skill.namespace?.canonicalName?.split('/').pop(),
    ].filter(Boolean) as string[]
    return candidates.some(name => installedNames.has(name.toLowerCase()))
  }

  return (
    <div className="skills-pane">
      <div className="skills-toolbar">
        <div className="skills-category-scroll">
          <button
            className={`skills-chip ${category === '' ? 'active' : ''}`}
            onClick={() => setCategory('')}
          >
            全部
          </button>
          {categories.map(item => (
            <button
              key={item.key}
              className={`skills-chip ${category === item.key ? 'active' : ''}`}
              onClick={() => setCategory(item.key)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="skills-sort">
          {SORTS.map(item => (
            <button
              key={item.id}
              className={sort === item.id ? 'active' : ''}
              onClick={() => setSort(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error
        ? (
          <div className="detail-note error skills-error">
            <span>{error}</span>
            <button className="skills-link" onClick={refresh}>重试</button>
          </div>
        )
        : null}
      {notice ? <div className="detail-note">{notice}</div> : null}

      {!query && showcase.length
        ? (
          <section className="skills-section">
            <div className="skills-section-head">
              <h3>精选技能</h3>
              <button className="skills-link" onClick={refresh}>
                <RefreshIcon size={12} />
                刷新
              </button>
            </div>
            <div className="skill-card-grid">
              {showcase.map((skill, index) => (
                <SkillCard
                  key={`${skill.slug}-${skill.namespace?.canonicalName ?? index}`}
                  skill={skill}
                  installed={isInstalled(skill)}
                  installing={installing === skill.slug}
                  disabled={!sessionId}
                  onInstall={() => void install(skill)}
                />
              ))}
            </div>
          </section>
        )
        : null}

      <section className="skills-section">
        <div className="skills-section-head">
          <h3>{query ? `检索「${query}」` : '推荐 SkillHub'}</h3>
          <span>{total ? `${total} 个技能` : ''}</span>
        </div>
        {loading
          ? <div className="skill-card-grid">{Array.from({ length: 6 }).map((_, index) => <div className="skill-card skeleton" key={index} />)}</div>
          : hub.length
            ? (
              <>
                <div className="skill-card-grid">
                  {hub.map((skill, index) => (
                    <SkillCard
                      key={`${skill.slug}-${skill.namespace?.canonicalName ?? index}`}
                      skill={skill}
                      installed={isInstalled(skill)}
                      installing={installing === skill.slug}
                      disabled={!sessionId}
                      onInstall={() => void install(skill)}
                    />
                  ))}
                </div>
                {hub.length < total
                  ? (
                    <button className="skills-more" onClick={() => void fetchHub(page + 1, true)} disabled={more}>
                      {more ? '加载中…' : '加载更多'}
                    </button>
                  )
                  : null}
              </>
            )
            : <div className="fn-empty"><CommandIcon size={26} /><h3>没有匹配的技能</h3><p>换一个关键词或分类试试。</p></div>}
      </section>

      <section className="skills-section">
        <div className="skills-section-head">
          <h3>已安装</h3>
          <span>{installed.length} 个技能</span>
        </div>
        <div className="skills-installed">
          {installed.length
            ? installed.map(skill => (
              <div className="skill-installed-row" key={`${skill.name}-${skill.path}`}>
                <span className="skill-installed-icon"><CommandIcon size={14} /></span>
                <div className="skill-installed-copy">
                  <div className="skill-installed-title">
                    /{skill.name}
                    <span className={`fn-badge ${skill.source === 'project' ? 'project' : ''}`}>
                      {skill.source === 'project' ? '项目' : '全局'}
                    </span>
                    <span className={`fn-badge ${skill.modelInvocable ? 'ok' : ''}`}>
                      <BotIcon size={10} />
                      {skill.modelInvocable ? '模型可用' : '仅用户'}
                    </span>
                    <span className={`fn-badge ${skill.userInvocable ? 'ok' : ''}`}>
                      <EyeIcon size={10} />
                      {skill.userInvocable ? '用户可见' : '不对用户'}
                    </span>
                  </div>
                  <p>{skill.description || '没有描述。'}</p>
                  <code>{skill.path}</code>
                </div>
                {skill.source === 'project'
                  ? (
                    <button className="skills-remove" onClick={() => void removeSkill(skill)}>
                      移除
                    </button>
                  )
                  : null}
              </div>
            ))
            : <div className="fn-empty"><CommandIcon size={24} /><h3>还没有安装技能</h3><p>从上面的 SkillHub 选一个装上，或让模型用 /skill 起草。</p></div>}
        </div>
      </section>

      {proposals.length
        ? (
          <section className="skills-section">
            <div className="skills-section-head">
              <h3>待审技能提案</h3>
              <span>{proposals.length} 个</span>
            </div>
            {proposals.map(proposal => (
              <div className="skill-proposal-row" key={proposal.name}>
                <div>
                  <strong>{proposal.name}</strong>
                  <p>{proposal.description || '没有描述。'}</p>
                </div>
                <button
                  className="btn compact"
                  disabled={!sessionId}
                  onClick={() => {
                    void proposalRequest(sessionId, `/api/skill-proposals/${encodeURIComponent(proposal.name)}/accept`, { method: 'POST' })
                      .then(() => refreshInstalled())
                      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
                  }}
                >
                  <CheckIcon size={12} />
                  接受
                </button>
                <button
                  className="btn ghost compact"
                  disabled={!sessionId}
                  onClick={async () => {
                    const ok = await confirm({
                      title: '拒绝技能提案',
                      body: `${proposal.name} 的提案会被删除，工作区保持不变。`,
                      confirmLabel: '拒绝',
                      danger: true,
                    })
                    if (!ok) return
                    void proposalRequest(sessionId, `/api/skill-proposals/${encodeURIComponent(proposal.name)}`, { method: 'DELETE' })
                      .then(() => refreshInstalled())
                      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
                  }}
                >
                  拒绝
                </button>
              </div>
            ))}
          </section>
        )
        : null}
    </div>
  )
}

function SkillCard({ skill, installed, installing, disabled, onInstall }: {
  skill: SkillHubSkill
  installed: boolean
  installing: boolean
  disabled: boolean
  onInstall: () => void
}) {
  const description = skill.description_zh || skill.description || ''
  return (
    <article className={`skill-card ${installed ? 'installed' : ''}`}>
      <div className="skill-card-head">
        <span className="skill-card-icon">
          {skill.iconUrl
            ? <img src={skill.iconUrl} alt="" loading="lazy" />
            : skill.name.slice(0, 1)}
        </span>
        <div className="skill-card-title">
          <strong title={skill.name}>{skill.name}</strong>
          <span>{skill.publisher?.name ?? skill.namespace?.displayName ?? skill.source ?? 'SkillHub'}</span>
        </div>
        <button
          type="button"
          className={`skill-install ${installed ? 'done' : ''}`}
          disabled={installed || disabled || installing}
          onClick={onInstall}
          aria-label={`安装 ${skill.name}`}
          title={!disabled ? '安装到当前工作区' : '打开一个会话后才能安装'}
        >
          {installing ? '…' : installed ? <CheckIcon size={13} /> : <PlusIcon size={14} />}
        </button>
      </div>
      <p className="skill-card-desc" title={description}>{description || '没有描述。'}</p>
      <div className="skill-card-meta">
        <span>↓ {compact(skill.downloads)}</span>
        {skill.version ? <span>v{skill.version}</span> : null}
        {skill.publisher?.verified ? <span>已认证</span> : null}
      </div>
    </article>
  )
}

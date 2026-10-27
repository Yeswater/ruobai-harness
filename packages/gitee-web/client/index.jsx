/**
 * Gitee settings tab and read-only repository drawer.
 *
 * The token is write-only: this bundle only ever sees `hasToken`, and the
 * server redacts it from every response. No token is put in a URL.
 */

const STYLES = `
.gitee-page { display: flex; flex-direction: column; gap: 14px; max-width: 640px; }
.gitee-head { display: flex; align-items: center; gap: 10px; }
.gitee-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
.gitee-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.gitee-badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
.gitee-badge.off { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.gitee-field { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--muted); }
.gitee-field input, .gitee-field select {
  height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 12px;
}
.gitee-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.gitee-btn {
  height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;
}
.gitee-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.gitee-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.gitee-btn:disabled { opacity: .5; cursor: not-allowed; }
.gitee-note { font-size: 11px; color: var(--faint); line-height: 1.6; }
.gitee-error { font-size: 11.5px; color: var(--danger); }
.gitee-ok { font-size: 11.5px; color: var(--ok); }
.gitee-account { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.gitee-account img { width: 22px; height: 22px; border-radius: 50%; }

.gitee-open {
  height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--panel); color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;
}
.gitee-open:hover { color: var(--text); border-color: var(--border-strong); }
.gitee-overlay { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.18); }
.gitee-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 81; width: min(460px, 94vw);
  display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--border);
  box-shadow: -12px 0 32px rgba(0,0,0,.12);
}
.gitee-drawer-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.gitee-drawer-head h3 { margin: 0; flex: 1; font-size: 14px; font-weight: 600; }
.gitee-close { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--faint); font-size: 16px; cursor: pointer; }
.gitee-close:hover { background: var(--tool-bg); color: var(--text); }
.gitee-drawer-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.gitee-search { display: flex; gap: 6px; }
.gitee-search input {
  flex: 1; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 12px;
}
.gitee-list { display: flex; flex-direction: column; gap: 4px; }
.gitee-repo {
  display: flex; flex-direction: column; gap: 2px; padding: 7px 8px; text-align: left;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: inherit; cursor: pointer;
}
.gitee-repo:hover { background: var(--tool-bg); }
.gitee-repo.selected { border-color: var(--accent); background: var(--accent-soft); }
.gitee-repo-name { font-size: 12.5px; font-weight: 600; }
.gitee-repo-desc { font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gitee-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.gitee-tab { height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer; }
.gitee-tab.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.gitee-repo-head { display: flex; align-items: flex-start; gap: 8px; }
.gitee-repo-head h4 { margin: 0; flex: 1; font-size: 13px; }
.gitee-link { color: var(--accent); font-size: 11.5px; text-decoration: none; }
.gitee-link:hover { text-decoration: underline; }
.gitee-meta { font-size: 11px; color: var(--faint); }
.gitee-section { display: flex; flex-direction: column; gap: 6px; }
.gitee-section-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.gitee-item { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text); }
.gitee-item:last-child { border-bottom: 0; }
.gitee-item small { display: block; color: var(--faint); font-size: 10.5px; margin-top: 2px; }
.gitee-entry {
  display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 6px; border: 0; border-radius: 5px;
  background: transparent; color: var(--text); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.gitee-entry:hover { background: var(--tool-bg); }
.gitee-entry .kind { width: 28px; color: var(--faint); font-size: 10px; }
.gitee-file {
  margin: 0; padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--tool-bg);
  color: var(--text); font-family: var(--mono); font-size: 11px; line-height: 1.5;
  overflow: auto; max-height: 46vh; white-space: pre-wrap; word-break: break-word;
}
.gitee-empty { font-size: 11.5px; color: var(--faint); padding: 8px 0; }
.gitee-busy { font-size: 11.5px; color: var(--faint); }
.gitee-modes { display: flex; gap: 4px; }
.gitee-mode {
  height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 999px;
  background: transparent; color: var(--muted); font: inherit; font-size: 11.5px; cursor: pointer;
}
.gitee-mode.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.gitee-publish { display: flex; flex-direction: column; gap: 10px; }
.gitee-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.gitee-field textarea {
  min-height: 64px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 12px; resize: vertical;
}
.gitee-plan {
  display: flex; flex-direction: column; gap: 6px; padding-top: 8px;
  border-top: 1px solid var(--border);
}
.gitee-plan-steps { margin: 0; padding-left: 18px; color: var(--muted); font-size: 11.5px; line-height: 1.7; }
.gitee-step { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.gitee-step:last-child { border-bottom: 0; }
.gitee-step small { color: var(--faint); font-size: 10.5px; word-break: break-word; }
.gitee-step-status { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.gitee-step-status.done { color: var(--ok); }
.gitee-step-status.skipped { color: var(--faint); }
.gitee-step-status.failed { color: var(--danger); }
.gitee-write, .gitee-detail {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--tool-bg);
}
.gitee-write input, .gitee-write textarea, .gitee-detail textarea {
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--panel); color: var(--text); font: inherit; font-size: 12px;
}
.gitee-write input { height: 28px; }
.gitee-write textarea, .gitee-detail textarea { min-height: 54px; resize: vertical; }
`

function ensureStyles() {
  if (document.getElementById('gitee-panel-styles')) return
  const style = document.createElement('style')
  style.id = 'gitee-panel-styles'
  style.textContent = STYLES
  document.head.appendChild(style)
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error ?? `HTTP ${response.status}`)
    if (Array.isArray(payload?.steps)) error.steps = payload.steps
    throw error
  }
  return payload
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function GiteeSettings() {
  const { useEffect, useState } = React
  const [settings, setSettings] = useState(null)
  const [token, setToken] = useState('')
  const [owner, setOwner] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [visibility, setVisibility] = useState('public')
  const [account, setAccount] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    ensureStyles()
    let cancelled = false
    request('/api/gitee/settings')
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setOwner(next.owner ?? '')
        setApiBase(next.apiBase ?? '')
        setVisibility(next.visibility ?? 'public')
      })
      .catch(error => { if (!cancelled) setError(messageOf(error)) })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    setBusy('save')
    setError('')
    setNotice('')
    try {
      const next = await request('/api/gitee/settings', {
        method: 'PUT',
        body: JSON.stringify({
          owner,
          apiBase,
          visibility,
          ...(token.trim() ? { token: token.trim() } : {}),
        }),
      })
      setSettings(next)
      setToken('')
      setNotice('已保存')
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy('')
    }
  }

  const test = async () => {
    setBusy('test')
    setError('')
    setNotice('')
    setAccount(null)
    try {
      const payload = await request('/api/gitee/test', {
        method: 'POST',
        body: JSON.stringify(token.trim() ? { token: token.trim() } : {}),
      })
      setAccount(payload.account)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy('')
    }
  }

  const hasToken = Boolean(settings?.hasToken)

  return (
    <div className="gitee-page">
      <div className="gitee-head">
        <h3>Gitee</h3>
        <span className={`gitee-badge ${hasToken ? 'ok' : 'off'}`}>{hasToken ? '已配置令牌' : '未配置令牌'}</span>
      </div>

      <label className="gitee-field">
        私人令牌
        <input
          type="password"
          value={token}
          autoComplete="off"
          placeholder={hasToken ? '已保存，留空保持不变' : '在 Gitee 设置 → 私人令牌中生成'}
          onChange={event => setToken(event.target.value)}
        />
      </label>

      <div className="gitee-row">
        <label className="gitee-field" style={{ flex: 1, minWidth: 160 }}>
          默认 owner
          <input
            value={owner}
            placeholder={account?.login ?? '留空则使用当前账号'}
            onChange={event => setOwner(event.target.value)}
          />
        </label>
        <label className="gitee-field" style={{ width: 110 }}>
          新仓库可见性
          <select value={visibility} onChange={event => setVisibility(event.target.value)}>
            <option value="public">公开</option>
            <option value="private">私有</option>
          </select>
        </label>
      </div>

      <label className="gitee-field">
        API 地址
        <input
          value={apiBase}
          placeholder="https://gitee.com/api/v5"
          onChange={event => setApiBase(event.target.value)}
        />
      </label>

      <div className="gitee-row">
        <button className="gitee-btn primary" disabled={Boolean(busy)} onClick={save}>
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button className="gitee-btn" disabled={Boolean(busy) || (!hasToken && !token.trim())} onClick={test}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        {notice ? <span className="gitee-ok">{notice}</span> : null}
      </div>

      {account
        ? (
          <div className="gitee-account">
            {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : null}
            <span>{account.name ? `${account.name} (@${account.login})` : `@${account.login}`}</span>
          </div>
        )
        : null}

      {error ? <div className="gitee-error">{error}</div> : null}

      <p className="gitee-note">
        令牌只写：保存后不会回传到浏览器，也不会出现在工具输出里。
        设置保存在本机 .ruobai/settings.json（已忽略提交）；CI 可用 GITEE_TOKEN 覆盖。
        修改 API 地址后可用“测试连接”验证自建 Gitee。
      </p>
    </div>
  )
}

function GiteePanel({ sessionId } = {}) {
  const { useEffect, useRef, useState } = React
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(null)
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState([])
  const [repo, setRepo] = useState(null)
  const [tab, setTab] = useState('overview')
  const [detail, setDetail] = useState(null)
  const [branches, setBranches] = useState([])
  const [commits, setCommits] = useState([])
  const [releases, setReleases] = useState([])
  const [path, setPath] = useState('')
  const [contents, setContents] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState('repos')
  const [status, setStatus] = useState(null)
  const [form, setForm] = useState({
    owner: '', repo: '', branch: '', private: false,
    tag: '', releaseTitle: '', releaseBody: '', description: '',
  })
  const [plan, setPlan] = useState(null)
  const [steps, setSteps] = useState(null)
  const [publishing, setPublishing] = useState('')
  const [issues, setIssues] = useState([])
  const [pulls, setPulls] = useState([])
  const [issueDetail, setIssueDetail] = useState(null)
  const [pullDetail, setPullDetail] = useState(null)
  const [issueDraft, setIssueDraft] = useState({ title: '', body: '', labels: '' })
  const [pullDraft, setPullDraft] = useState({ title: '', head: '', base: '', body: '' })
  const [commentDraft, setCommentDraft] = useState('')
  const [writeBusy, setWriteBusy] = useState('')
  const closeRef = useRef(null)

  useEffect(() => {
    ensureStyles()
    if (!open) return
    let cancelled = false
    setBusy('repos')
    setError('')
    const load = async () => {
      try {
        const next = await request('/api/gitee/settings')
        if (cancelled) return
        setSettings(next)
        if (sessionId) {
          const nextStatus = await request(
            `/api/gitee/status?sessionId=${encodeURIComponent(sessionId)}`,
          ).catch(() => null)
          if (!cancelled && nextStatus) {
            setStatus(nextStatus)
            setForm(current => ({
              ...current,
              owner: current.owner || next.owner || nextStatus.accountLogin || '',
              repo: current.repo || nextStatus.suggestedRepo || '',
              branch: current.branch || nextStatus.branch || '',
              private: current.private || next.visibility === 'private',
            }))
          }
        }
        if (!next.hasToken) return
        const page = await request('/api/gitee/repos')
        if (!cancelled) setRepos(page.items ?? [])
      } catch (error) {
        if (!cancelled) setError(messageOf(error))
      } finally {
        if (!cancelled) setBusy('')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  const loadStatus = async () => {
    if (!sessionId) return
    try {
      const next = await request(`/api/gitee/status?sessionId=${encodeURIComponent(sessionId)}`)
      setStatus(next)
      setForm(current => ({
        ...current,
        owner: current.owner || settings?.owner || next.accountLogin || '',
        repo: current.repo || next.suggestedRepo || '',
        branch: current.branch || next.branch || '',
      }))
    } catch (error) {
      setError(messageOf(error))
    }
  }

  const runPublish = async (previewOnly) => {
    if (!sessionId) {
      setError('发布需要一个已打开的会话。')
      return
    }
    if (!form.repo.trim()) {
      setError('仓库名不能为空。')
      return
    }
    setPublishing(previewOnly ? 'preview' : 'publish')
    setError('')
    setSteps(null)
    if (previewOnly) setPlan(null)
    try {
      const payload = await request(
        previewOnly ? '/api/gitee/publish/preview' : '/api/gitee/publish',
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            owner: form.owner.trim() || undefined,
            repo: form.repo.trim(),
            branch: form.branch.trim() || undefined,
            private: form.private,
            description: form.description.trim() || undefined,
            tag: form.tag.trim() || undefined,
            ...(form.releaseTitle.trim() ? { releaseTitle: form.releaseTitle } : {}),
            ...(form.releaseBody.trim() ? { releaseBody: form.releaseBody } : {}),
          }),
        },
      )
      if (previewOnly) {
        setPlan(payload)
      } else {
        setSteps(payload.steps ?? [])
        setPlan(payload.plan ?? null)
        await loadStatus()
        const page = await request('/api/gitee/repos')
        setRepos(page.items ?? [])
      }
    } catch (error) {
      setSteps(Array.isArray(error.steps) ? error.steps : null)
      setError(messageOf(error))
    } finally {
      setPublishing('')
    }
  }

  const pick = async (next) => {
    setRepo(next)
    setTab('overview')
    setPath('')
    setContents(null)
    setDetail(null)
    setBranches([])
    setCommits([])
    setReleases([])
    setIssues([])
    setPulls([])
    setIssueDetail(null)
    setPullDetail(null)
    setCommentDraft('')
    setBusy('repo')
    setError('')
    try {
      const base = `/api/gitee/repos/${encodeURIComponent(next.owner)}/${encodeURIComponent(next.name)}`
      const [info, branchPage, commitPage, releasePage, issuePage, pullPage] = await Promise.all([
        request(base),
        request(`${base}/branches`),
        request(`${base}/commits`),
        request(`${base}/releases`),
        request(`${base}/issues`),
        request(`${base}/pulls`),
      ])
      setDetail(info)
      setBranches(branchPage.items ?? [])
      setCommits(commitPage.items ?? [])
      setReleases(releasePage.items ?? [])
      setIssues(issuePage.items ?? [])
      setPulls(pullPage.items ?? [])
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy('')
    }
  }

  const repoApi = () => `/api/gitee/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`

  const refreshIssues = async () => {
    const page = await request(`${repoApi()}/issues`)
    setIssues(page.items ?? [])
  }

  const refreshPulls = async () => {
    const page = await request(`${repoApi()}/pulls`)
    setPulls(page.items ?? [])
  }

  const writeIssue = async (body) => {
    if (!repo) return
    setWriteBusy(body.action)
    setError('')
    try {
      await request(`${repoApi()}/issues`, { method: 'POST', body: JSON.stringify(body) })
      await refreshIssues()
      return true
    } catch (error) {
      setError(messageOf(error))
      return false
    } finally {
      setWriteBusy('')
    }
  }

  const writePull = async (body) => {
    if (!repo) return
    setWriteBusy(body.action)
    setError('')
    try {
      await request(`${repoApi()}/pulls`, { method: 'POST', body: JSON.stringify(body) })
      await refreshPulls()
      return true
    } catch (error) {
      setError(messageOf(error))
      return false
    } finally {
      setWriteBusy('')
    }
  }

  const openIssue = async (number) => {
    if (!repo) return
    setError('')
    try {
      setIssueDetail(await request(`${repoApi()}/issues/${number}`))
      setCommentDraft('')
    } catch (error) {
      setError(messageOf(error))
    }
  }

  const openPull = async (number) => {
    if (!repo) return
    setError('')
    try {
      setPullDetail(await request(`${repoApi()}/pulls/${number}`))
      setCommentDraft('')
    } catch (error) {
      setError(messageOf(error))
    }
  }

  const openPath = async (nextPath) => {
    if (!repo) return
    setPath(nextPath)
    setBusy('file')
    setError('')
    try {
      const url = `/api/gitee/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents?path=${encodeURIComponent(nextPath)}`
      setContents(await request(url))
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy('')
    }
  }

  const filtered = query.trim()
    ? repos.filter(item =>
      item.fullName.toLowerCase().includes(query.trim().toLowerCase())
      || (item.description ?? '').toLowerCase().includes(query.trim().toLowerCase()))
    : repos

  return (
    <>
      <button className="gitee-open" onClick={() => setOpen(value => !value)} title="Gitee 仓库">
        Gitee
      </button>
      {open
        ? (
          <div className="gitee-overlay" onClick={() => setOpen(false)}>
            <aside
              className="gitee-drawer"
              role="dialog"
              aria-modal="true"
              aria-label="Gitee 仓库"
              onClick={event => event.stopPropagation()}
            >
              <header className="gitee-drawer-head">
                <h3>{mode === 'publish' ? '发布工作区' : repo ? repo.fullName : 'Gitee'}</h3>
                {settings?.hasToken
                  ? (
                    <div className="gitee-modes">
                      <button
                        className={`gitee-mode ${mode === 'repos' ? 'active' : ''}`}
                        onClick={() => { setMode('repos'); setPlan(null); setSteps(null); setError('') }}
                      >
                        仓库
                      </button>
                      <button
                        className={`gitee-mode ${mode === 'publish' ? 'active' : ''}`}
                        onClick={() => { setMode('publish'); setPlan(null); setSteps(null); setError('') }}
                      >
                        发布
                      </button>
                    </div>
                  )
                  : null}
                {mode === 'repos' && repo?.htmlUrl
                  ? <a className="gitee-link" href={repo.htmlUrl} target="_blank" rel="noreferrer">打开</a>
                  : null}
                <button ref={closeRef} className="gitee-close" onClick={() => setOpen(false)} aria-label="关闭">×</button>
              </header>
              <div className="gitee-drawer-body">
                {!settings
                  ? <div className="gitee-busy">读取设置…</div>
                  : !settings.hasToken
                    ? (
                      <div className="gitee-empty">
                        还没有配置 Gitee 令牌。打开 设置 → Gitee 填写私人令牌后即可浏览仓库。
                      </div>
                    )
                    : mode === 'publish'
                      ? (
                        <div className="gitee-publish">
                          {!sessionId ? <div className="gitee-empty">发布需要一个已打开的会话。</div> : null}

                          <div className="gitee-form-grid">
                            <label className="gitee-field">
                              owner
                              <input
                                value={form.owner}
                                placeholder={settings.owner || '当前账号'}
                                onChange={event => setForm(current => ({ ...current, owner: event.target.value }))}
                              />
                            </label>
                            <label className="gitee-field">
                              仓库
                              <input
                                value={form.repo}
                                onChange={event => setForm(current => ({ ...current, repo: event.target.value }))}
                              />
                            </label>
                          </div>

                          <div className="gitee-row">
                            <label className="gitee-field" style={{ flex: 1 }}>
                              分支
                              <input
                                value={form.branch}
                                placeholder={status?.branch || 'main'}
                                onChange={event => setForm(current => ({ ...current, branch: event.target.value }))}
                              />
                            </label>
                            <label className="gitee-field" style={{ width: 110 }}>
                              可见性
                              <select
                                value={form.private ? 'private' : 'public'}
                                onChange={event => setForm(current => ({ ...current, private: event.target.value === 'private' }))}
                              >
                                <option value="public">公开</option>
                                <option value="private">私有</option>
                              </select>
                            </label>
                          </div>

                          <label className="gitee-field">
                            描述（建库时使用）
                            <input
                              value={form.description}
                              onChange={event => setForm(current => ({ ...current, description: event.target.value }))}
                            />
                          </label>

                          <label className="gitee-field">
                            tag（可选）
                            <input
                              value={form.tag}
                              placeholder="例如 v0.1.0"
                              onChange={event => setForm(current => ({ ...current, tag: event.target.value }))}
                            />
                          </label>

                          {form.tag.trim()
                            ? (
                              <>
                                <label className="gitee-field">
                                  Release 标题
                                  <input
                                    value={form.releaseTitle}
                                    placeholder={form.tag}
                                    onChange={event => setForm(current => ({ ...current, releaseTitle: event.target.value }))}
                                  />
                                </label>
                                <label className="gitee-field">
                                  Release 说明
                                  <textarea
                                    value={form.releaseBody}
                                    onChange={event => setForm(current => ({ ...current, releaseBody: event.target.value }))}
                                  />
                                </label>
                              </>
                            )
                            : null}

                          <div className="gitee-row">
                            <button className="gitee-btn" disabled={Boolean(publishing)} onClick={() => runPublish(true)}>
                              {publishing === 'preview' ? '预检中…' : '预览'}
                            </button>
                            <button
                              className="gitee-btn primary"
                              disabled={Boolean(publishing) || !plan || plan.remote?.conflict}
                              onClick={() => runPublish(false)}
                            >
                              {publishing === 'publish' ? '发布中…' : '确认发布'}
                            </button>
                            <button className="gitee-btn" disabled={Boolean(publishing)} onClick={loadStatus}>
                              刷新状态
                            </button>
                          </div>

                          {status
                            ? (
                              <div className="gitee-meta">
                                工作区 {status.workspace} · {status.branch ? `分支 ${status.branch}` : '尚无提交'} · {status.dirty ? '有未提交改动' : '工作区干净'}
                              </div>
                            )
                            : null}

                          {plan
                            ? (
                              <div className="gitee-plan">
                                <div className="gitee-section-title">发布计划</div>
                                <div className="gitee-item">
                                  {plan.fullName} · {plan.private ? '私有' : '公开'} · {plan.branch} @ {(plan.head ?? '').slice(0, 8)}
                                </div>
                                <ul className="gitee-plan-steps">
                                  {(plan.steps ?? []).map(step => <li key={step}>{step}</li>)}
                                </ul>
                                {plan.remote?.conflict
                                  ? (
                                    <div className="gitee-error">
                                      remote {plan.remote.name} 已指向 {plan.remote.currentUrl}，与 {plan.remote.url} 不同。
                                    </div>
                                  )
                                  : null}
                                {plan.dirty ? <div className="gitee-meta">工作区有未提交改动，只会推送已提交内容。</div> : null}
                              </div>
                            )
                            : null}

                          {steps
                            ? (
                              <div className="gitee-section">
                                <div className="gitee-section-title">执行结果</div>
                                {steps.map(step => (
                                  <div className="gitee-step" key={step.name}>
                                    <span className={`gitee-step-status ${step.status}`}>{step.status}</span>
                                    <span>{step.name}</span>
                                    {step.output ? <small>{step.output}</small> : null}
                                  </div>
                                ))}
                              </div>
                            )
                            : null}

                          {error ? <div className="gitee-error">{error}</div> : null}
                        </div>
                      )
                      : (
                        <>
                        <div className="gitee-search">
                          <input
                            value={query}
                            placeholder="筛选仓库"
                            onChange={event => setQuery(event.target.value)}
                          />
                          <button className="gitee-btn" onClick={() => { setRepo(null); setQuery(''); setError('') }}>
                            仓库
                          </button>
                        </div>

                        {error ? <div className="gitee-error">{error}</div> : null}

                        {!repo
                          ? (
                            <div className="gitee-list">
                              {busy === 'repos' ? <div className="gitee-busy">加载仓库…</div> : null}
                              {filtered.map(item => (
                                <button
                                  key={item.fullName}
                                  className="gitee-repo"
                                  onClick={() => pick(item)}
                                >
                                  <span className="gitee-repo-name">{item.fullName}</span>
                                  <span className="gitee-repo-desc">{item.description || (item.private ? '私有仓库' : '公开仓库')}</span>
                                </button>
                              ))}
                              {!filtered.length && busy !== 'repos' ? <div className="gitee-empty">没有匹配的仓库。</div> : null}
                            </div>
                          )
                          : (
                            <>
                              <div className="gitee-repo-head">
                                <h4>{repo.fullName}</h4>
                                <span className="gitee-meta">{repo.private ? '私有' : '公开'}</span>
                              </div>
                              <div className="gitee-tabs">
                                {[
                                  ['overview', '概览'],
                                  ['branches', '分支'],
                                  ['commits', '提交'],
                                  ['files', '文件'],
                                  ['issues', 'Issue'],
                                  ['pulls', 'PR'],
                                  ['releases', 'Release'],
                                ].map(([id, label]) => (
                                  <button
                                    key={id}
                                    className={`gitee-tab ${tab === id ? 'active' : ''}`}
                                    onClick={() => {
                                      setTab(id)
                                      if (id === 'files' && contents === null) openPath('')
                                    }}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>

                              {tab === 'overview'
                                ? (
                                  <div className="gitee-section">
                                    <div className="gitee-item">
                                      {detail?.description || repo.description || '无描述'}
                                      <small>
                                        {detail?.defaultBranch ? `默认分支 ${detail.defaultBranch}` : ''}
                                        {detail?.updatedAt ? ` · 更新于 ${detail.updatedAt}` : ''}
                                      </small>
                                    </div>
                                    <div className="gitee-meta">
                                      {branches.length} 个分支 · {commits.length} 条提交 · {releases.length} 个 Release
                                    </div>
                                  </div>
                                )
                                : null}

                              {tab === 'branches'
                                ? (
                                  <div className="gitee-section">
                                    {branches.map(branch => (
                                      <div className="gitee-item" key={branch.name}>
                                        {branch.name}
                                        <small>{branch.sha ? branch.sha.slice(0, 10) : ''}</small>
                                      </div>
                                    ))}
                                    {!branches.length ? <div className="gitee-empty">没有分支。</div> : null}
                                  </div>
                                )
                                : null}

                              {tab === 'commits'
                                ? (
                                  <div className="gitee-section">
                                    {commits.map(commit => (
                                      <div className="gitee-item" key={commit.sha}>
                                        {commit.message || '(无提交信息)'}
                                        <small>
                                          {commit.sha.slice(0, 10)}
                                          {commit.author ? ` · ${commit.author}` : ''}
                                          {commit.date ? ` · ${commit.date}` : ''}
                                        </small>
                                      </div>
                                    ))}
                                    {!commits.length ? <div className="gitee-empty">没有提交。</div> : null}
                                  </div>
                                )
                                : null}

                              {tab === 'files'
                                ? (
                                  <div className="gitee-section">
                                    <div className="gitee-row">
                                      <button className="gitee-btn" disabled={!path} onClick={() => openPath(path.split('/').slice(0, -1).join('/'))}>
                                        上一级
                                      </button>
                                      <span className="gitee-meta">/{path}</span>
                                    </div>
                                    {busy === 'file' ? <div className="gitee-busy">加载…</div> : null}
                                    {contents?.entries
                                      ? contents.entries.map(entry => (
                                        <button
                                          key={entry.path}
                                          className="gitee-entry"
                                          onClick={() => openPath(entry.path)}
                                        >
                                          <span className="kind">{entry.type === 'dir' ? 'DIR' : 'FILE'}</span>
                                          <span>{entry.name}</span>
                                        </button>
                                      ))
                                      : null}
                                    {contents && typeof contents.content === 'string'
                                      ? <pre className="gitee-file">{contents.content || '(空文件)'}</pre>
                                      : null}
                                    {contents && !contents.entries && typeof contents.content !== 'string'
                                      ? <div className="gitee-empty">没有内容。</div>
                                      : null}
                                  </div>
                                )
                                : null}

                              {tab === 'issues'
                                ? (
                                  <div className="gitee-section">
                                    <div className="gitee-write">
                                      <input
                                        placeholder="Issue 标题"
                                        value={issueDraft.title}
                                        onChange={event => setIssueDraft(draft => ({ ...draft, title: event.target.value }))}
                                      />
                                      <textarea
                                        placeholder="描述（可选）"
                                        value={issueDraft.body}
                                        onChange={event => setIssueDraft(draft => ({ ...draft, body: event.target.value }))}
                                      />
                                      <div className="gitee-row">
                                        <input
                                          placeholder="标签，逗号分隔"
                                          value={issueDraft.labels}
                                          onChange={event => setIssueDraft(draft => ({ ...draft, labels: event.target.value }))}
                                        />
                                        <button
                                          className="gitee-btn primary"
                                          disabled={!issueDraft.title.trim() || Boolean(writeBusy)}
                                          onClick={async () => {
                                            const labels = issueDraft.labels.split(',').map(label => label.trim()).filter(Boolean)
                                            if (await writeIssue({
                                              action: 'create',
                                              title: issueDraft.title,
                                              body: issueDraft.body,
                                              labels,
                                            })) {
                                              setIssueDraft({ title: '', body: '', labels: '' })
                                            }
                                          }}
                                        >
                                          创建 Issue
                                        </button>
                                      </div>
                                    </div>

                                    {issues.map(issue => (
                                      <button className="gitee-entry" key={issue.number} onClick={() => openIssue(issue.number)}>
                                        <span className="kind">#{issue.number}</span>
                                        <span>{issue.title}</span>
                                        <span className="gitee-meta">{issue.state}</span>
                                      </button>
                                    ))}
                                    {!issues.length ? <div className="gitee-empty">还没有 Issue。</div> : null}

                                    {issueDetail
                                      ? (
                                        <div className="gitee-detail">
                                          <div className="gitee-item">
                                            #{issueDetail.number} {issueDetail.title}
                                            <small>{issueDetail.author} · {issueDetail.state}</small>
                                          </div>
                                          {issueDetail.body ? <pre className="gitee-file">{issueDetail.body}</pre> : null}
                                          <textarea
                                            placeholder="写评论…"
                                            value={commentDraft}
                                            onChange={event => setCommentDraft(event.target.value)}
                                          />
                                          <div className="gitee-row">
                                            <button
                                              className="gitee-btn"
                                              disabled={!commentDraft.trim() || Boolean(writeBusy)}
                                              onClick={async () => {
                                                if (await writeIssue({
                                                  action: 'comment',
                                                  number: issueDetail.number,
                                                  body: commentDraft,
                                                })) setCommentDraft('')
                                              }}
                                            >
                                              评论
                                            </button>
                                            <button
                                              className="gitee-btn"
                                              disabled={issueDetail.state === 'closed' || Boolean(writeBusy)}
                                              onClick={async () => {
                                                if (await writeIssue({ action: 'close', number: issueDetail.number })) {
                                                  setIssueDetail({ ...issueDetail, state: 'closed' })
                                                }
                                              }}
                                            >
                                              关闭
                                            </button>
                                            <button className="gitee-btn" onClick={() => setIssueDetail(null)}>收起</button>
                                          </div>
                                        </div>
                                      )
                                      : null}
                                  </div>
                                )
                                : null}

                              {tab === 'pulls'
                                ? (
                                  <div className="gitee-section">
                                    <div className="gitee-write">
                                      <input
                                        placeholder="PR 标题"
                                        value={pullDraft.title}
                                        onChange={event => setPullDraft(draft => ({ ...draft, title: event.target.value }))}
                                      />
                                      <div className="gitee-row">
                                        <input
                                          placeholder="head 分支"
                                          value={pullDraft.head}
                                          onChange={event => setPullDraft(draft => ({ ...draft, head: event.target.value }))}
                                        />
                                        <input
                                          placeholder={detail?.defaultBranch || 'base 分支'}
                                          value={pullDraft.base}
                                          onChange={event => setPullDraft(draft => ({ ...draft, base: event.target.value }))}
                                        />
                                      </div>
                                      <textarea
                                        placeholder="描述（可选）"
                                        value={pullDraft.body}
                                        onChange={event => setPullDraft(draft => ({ ...draft, body: event.target.value }))}
                                      />
                                      <button
                                        className="gitee-btn primary"
                                        disabled={!pullDraft.title.trim() || !pullDraft.head.trim() || Boolean(writeBusy)}
                                        onClick={async () => {
                                          if (await writePull({
                                            action: 'create',
                                            title: pullDraft.title,
                                            head: pullDraft.head,
                                            base: pullDraft.base.trim() || detail?.defaultBranch || 'main',
                                            body: pullDraft.body,
                                          })) {
                                            setPullDraft({ title: '', head: '', base: '', body: '' })
                                          }
                                        }}
                                      >
                                        创建 PR
                                      </button>
                                    </div>

                                    {pulls.map(pull => (
                                      <button className="gitee-entry" key={pull.number} onClick={() => openPull(pull.number)}>
                                        <span className="kind">#{pull.number}</span>
                                        <span>{pull.title}</span>
                                        <span className="gitee-meta">{pull.head} → {pull.base}</span>
                                      </button>
                                    ))}
                                    {!pulls.length ? <div className="gitee-empty">还没有 PR。</div> : null}

                                    {pullDetail
                                      ? (
                                        <div className="gitee-detail">
                                          <div className="gitee-item">
                                            #{pullDetail.number} {pullDetail.title}
                                            <small>{pullDetail.author} · {pullDetail.state} · {pullDetail.head} → {pullDetail.base}</small>
                                          </div>
                                          {pullDetail.body ? <pre className="gitee-file">{pullDetail.body}</pre> : null}
                                          <textarea
                                            placeholder="写评论…"
                                            value={commentDraft}
                                            onChange={event => setCommentDraft(event.target.value)}
                                          />
                                          <div className="gitee-row">
                                            <button
                                              className="gitee-btn"
                                              disabled={!commentDraft.trim() || Boolean(writeBusy)}
                                              onClick={async () => {
                                                if (await writePull({
                                                  action: 'comment',
                                                  number: pullDetail.number,
                                                  body: commentDraft,
                                                })) setCommentDraft('')
                                              }}
                                            >
                                              评论
                                            </button>
                                            <button className="gitee-btn" onClick={() => setPullDetail(null)}>收起</button>
                                          </div>
                                        </div>
                                      )
                                      : null}
                                  </div>
                                )
                                : null}

                              {tab === 'releases'
                                ? (
                                  <div className="gitee-section">
                                    {releases.map(release => (
                                      <div className="gitee-item" key={release.tagName}>
                                        {release.name || release.tagName}
                                        <small>
                                          {release.tagName}
                                          {release.createdAt ? ` · ${release.createdAt}` : ''}
                                          {release.htmlUrl ? ' · ' : ''}
                                          {release.htmlUrl
                                            ? <a className="gitee-link" href={release.htmlUrl} target="_blank" rel="noreferrer">打开</a>
                                            : null}
                                        </small>
                                      </div>
                                    ))}
                                    {!releases.length ? <div className="gitee-empty">还没有 Release。</div> : null}
                                  </div>
                                )
                                : null}
                            </>
                          )}
                      </>
                    )}
              </div>
            </aside>
          </div>
        )
        : null}
    </>
  )
}

export default function register(api) {
  api.slots.register('settings.gitee', {
    id: 'gitee.settings',
    component: GiteeSettings,
  })
  api.slots.register('header.actions', {
    id: 'gitee.panel',
    component: GiteePanel,
  })
}

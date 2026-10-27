import { isIP } from 'node:net'
import type {
  GiteeAccount, GiteeBranch, GiteeCommitSummary, GiteeContent, GiteeContentEntry,
  GiteeIssueDetail, GiteeIssueSummary, GiteePage, GiteePullSummary, GiteeRelease, GiteeRepoSummary,
} from './types.ts'

export const DEFAULT_API_BASE = 'https://gitee.com/api/v5'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BYTES = 2_000_000
const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100
const MAX_REDIRECTS = 3

export interface GiteeClientConfig {
  apiBase?: string
  token?: string
  timeoutMs?: number
  maxBytes?: number
  pageSize?: number
  /** Tests point at a local fixture; production never allows private hosts. */
  allowPrivateHost?: boolean
  fetchImpl?: typeof fetch
}

export class GiteeError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'GiteeError'
  }
}

interface Reply {
  status: number
  text: string
  headers: Headers
}

export class GiteeClient {
  private readonly base: URL
  private readonly token?: string
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly pageSize: number
  private readonly allowPrivateHost: boolean
  private readonly fetchImpl: typeof fetch

  constructor(config: GiteeClientConfig = {}) {
    this.base = normalizeBase(config.apiBase)
    this.token = config.token?.trim() || undefined
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
    this.pageSize = clampPage(config.pageSize ?? DEFAULT_PAGE_SIZE)
    this.allowPrivateHost = config.allowPrivateHost === true
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  get authenticated() {
    return Boolean(this.token)
  }

  async account(): Promise<GiteeAccount> {
    const user = await this.request<Record<string, unknown>>('/user')
    const login = text(user.login) || text(user.name) || 'unknown'
    return {
      login,
      ...(text(user.name) ? { name: text(user.name) } : {}),
      ...(text(user.avatar_url) ? { avatarUrl: text(user.avatar_url) } : {}),
    }
  }

  async listRepos(options: { query?: string; page?: number } = {}): Promise<GiteePage<GiteeRepoSummary>> {
    const page = clampPage(options.page)
    const rows = await this.request<unknown[]>('/user/repos', {
      query: { page, per_page: this.pageSize, sort: 'updated' },
    })
    const items = asArray(rows).map(mapRepo)
    const query = options.query?.trim().toLowerCase()
    return {
      items: query
        ? items.filter(repo =>
          repo.fullName.toLowerCase().includes(query)
          || repo.name.toLowerCase().includes(query)
          || (repo.description ?? '').toLowerCase().includes(query))
        : items,
      page,
      hasMore: asArray(rows).length >= this.pageSize,
    }
  }

  async getRepo(owner: string, repo: string): Promise<GiteeRepoSummary> {
    return mapRepo(await this.request<Record<string, unknown>>(repoPath(owner, repo)))
  }

  async branches(owner: string, repo: string, page = 1): Promise<GiteePage<GiteeBranch>> {
    const current = clampPage(page)
    const rows = asArray(await this.request<unknown[]>(repoPath(owner, repo, 'branches'), {
      query: { page: current, per_page: this.pageSize },
    }))
    return {
      items: rows.map(entry => {
        const row = record(entry)
        return {
          name: text(row.name),
          ...(text(record(row.commit).sha) ? { sha: text(record(row.commit).sha) } : {}),
        }
      }),
      page: current,
      hasMore: rows.length >= this.pageSize,
    }
  }

  async commits(
    owner: string,
    repo: string,
    options: { ref?: string; path?: string; page?: number } = {},
  ): Promise<GiteePage<GiteeCommitSummary>> {
    const page = clampPage(options.page)
    const rows = asArray(await this.request<unknown[]>(repoPath(owner, repo, 'commits'), {
      query: {
        page,
        per_page: this.pageSize,
        ...(options.ref ? { sha: options.ref } : {}),
        ...(options.path ? { path: options.path } : {}),
      },
    }))
    return {
      items: rows.map(entry => {
        const row = record(entry)
        const commit = record(row.commit)
        const author = record(commit.author)
        const authorName = text(author.name) || text(record(row.author).login)
        return {
          sha: text(row.sha),
          message: text(commit.message).split('\n')[0] ?? '',
          ...(authorName ? { author: authorName } : {}),
          ...(text(author.date) ? { date: text(author.date) } : {}),
        }
      }),
      page,
      hasMore: rows.length >= this.pageSize,
    }
  }

  async contents(
    owner: string,
    repo: string,
    options: { path?: string; ref?: string } = {},
  ): Promise<GiteeContent> {
    const path = normalizeRepoPath(options.path)
    const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const raw = await this.request<unknown>(
      repoPath(owner, repo, `contents${encoded ? `/${encoded}` : ''}`),
      { query: options.ref ? { ref: options.ref } : undefined },
    )
    if (Array.isArray(raw)) {
      return {
        path,
        ...(options.ref ? { ref: options.ref } : {}),
        entries: raw.map(mapContentEntry),
        truncated: false,
      }
    }
    const row = record(raw)
    const content = text(row.content)
    const decoded = content ? Buffer.from(content, 'base64').toString('utf8') : ''
    const clipped = clip(decoded, this.maxBytes)
    return {
      path: text(row.path) || path,
      ...(options.ref ? { ref: options.ref } : {}),
      content: clipped.text,
      truncated: clipped.truncated,
      ...(Number.isFinite(Number(row.size)) ? { size: Number(row.size) } : {}),
    }
  }

  async releases(owner: string, repo: string, page = 1): Promise<GiteePage<GiteeRelease>> {
    const current = clampPage(page)
    const rows = asArray(await this.request<unknown[]>(repoPath(owner, repo, 'releases'), {
      query: { page: current, per_page: this.pageSize },
    }))
    return {
      items: rows.map(mapRelease),
      page: current,
      hasMore: rows.length >= this.pageSize,
    }
  }

  async issues(
    owner: string,
    repo: string,
    options: { state?: string; page?: number } = {},
  ): Promise<GiteePage<GiteeIssueSummary>> {
    const page = clampPage(options.page)
    const rows = asArray(await this.request<unknown[]>(repoPath(owner, repo, 'issues'), {
      query: {
        page,
        per_page: this.pageSize,
        state: issueState(options.state),
      },
    }))
    return {
      items: rows.map(mapIssue),
      page,
      hasMore: rows.length >= this.pageSize,
    }
  }

  async issue(owner: string, repo: string, number: number): Promise<GiteeIssueDetail> {
    const row = await this.request<Record<string, unknown>>(
      repoPath(owner, repo, `issues/${issueNumber(number)}`),
    )
    return {
      ...mapIssue(row),
      ...(text(row.body) ? { body: text(row.body) } : {}),
      ...(Number.isFinite(Number(row.comments)) ? { comments: Number(row.comments) } : {}),
    }
  }

  async pulls(
    owner: string,
    repo: string,
    options: { state?: string; page?: number } = {},
  ): Promise<GiteePage<GiteePullSummary>> {
    const page = clampPage(options.page)
    const rows = asArray(await this.request<unknown[]>(repoPath(owner, repo, 'pulls'), {
      query: {
        page,
        per_page: this.pageSize,
        state: issueState(options.state),
      },
    }))
    return {
      items: rows.map(mapPull),
      page,
      hasMore: rows.length >= this.pageSize,
    }
  }

  async pull(owner: string, repo: string, number: number): Promise<GiteePullSummary & { body?: string }> {
    const row = await this.request<Record<string, unknown>>(
      repoPath(owner, repo, `pulls/${issueNumber(number)}`),
    )
    return {
      ...mapPull(row),
      ...(text(row.body) ? { body: text(row.body) } : {}),
    }
  }

  /** Organizations the token can create repositories in. */
  async orgs(): Promise<Array<{ login: string; name?: string }>> {
    const rows = asArray(await this.request<unknown[]>('/user/orgs', {
      query: { page: 1, per_page: 100 },
    }))
    return rows.flatMap((entry) => {
      const row = record(entry)
      const login = text(row.login) || text(row.path)
      if (!login) return []
      return [{
        login,
        ...(text(row.name) ? { name: text(row.name) } : {}),
      }]
    })
  }

  async createRepo(input: {
    owner: string
    name: string
    description?: string
    private?: boolean
    org?: boolean
  }): Promise<GiteeRepoSummary> {
    const name = assertRepoName(input.name)
    const path = input.org
      ? `/orgs/${encodeSegment(input.owner, 'owner')}/repos`
      : '/user/repos'
    const row = await this.request<Record<string, unknown>>(path, {
      method: 'POST',
      body: {
        name,
        private: input.private === true,
        auto_init: false,
        ...(input.description?.trim() ? { description: input.description.trim().slice(0, 500) } : {}),
      },
    })
    return mapRepo(row)
  }

  async createRelease(
    owner: string,
    repo: string,
    input: { tagName: string; name?: string; body?: string; target?: string },
  ): Promise<GiteeRelease> {
    const tagName = input.tagName.trim()
    if (!tagName) throw new GiteeError(400, 'tag 名称不能为空')
    const row = await this.request<Record<string, unknown>>(repoPath(owner, repo, 'releases'), {
      method: 'POST',
      body: {
        tag_name: tagName,
        name: input.name?.trim() || tagName,
        ...(input.body?.trim() ? { body: input.body } : {}),
        ...(input.target?.trim() ? { target_commitish: input.target.trim() } : {}),
      },
    })
    return mapRelease(row)
  }

  /** Used when creating a release races an existing tag: Gitee returns 4xx. */
  async releaseByTag(owner: string, repo: string, tagName: string): Promise<GiteeRelease | undefined> {
    try {
      const row = await this.request<Record<string, unknown>>(
        repoPath(owner, repo, `releases/tags/${encodeURIComponent(tagName)}`),
      )
      return mapRelease(row)
    } catch (error) {
      if (error instanceof GiteeError && error.status === 404) return undefined
      throw error
    }
  }

  async createIssue(
    owner: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[] },
  ): Promise<GiteeIssueDetail> {
    const title = input.title.trim()
    if (!title) throw new GiteeError(400, 'Issue 标题不能为空。')
    const row = await this.request<Record<string, unknown>>(repoPath(owner, repo, 'issues'), {
      method: 'POST',
      body: {
        title,
        ...(input.body?.trim() ? { body: input.body } : {}),
        ...(input.labels?.length ? { labels: input.labels.join(',') } : {}),
      },
    })
    return {
      ...mapIssue(row),
      ...(text(row.body) ? { body: text(row.body) } : {}),
    }
  }

  async commentIssue(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.request(repoPath(owner, repo, `issues/${issueNumber(number)}/comments`), {
      method: 'POST',
      body: { body: requireBody(body) },
    })
  }

  async closeIssue(owner: string, repo: string, number: number): Promise<GiteeIssueDetail> {
    const row = await this.request<Record<string, unknown>>(repoPath(owner, repo, `issues/${issueNumber(number)}`), {
      method: 'PATCH',
      body: { state: 'closed' },
    })
    return {
      ...mapIssue(row),
      ...(text(row.body) ? { body: text(row.body) } : {}),
    }
  }

  async createPull(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string },
  ): Promise<GiteePullSummary> {
    const title = input.title.trim()
    if (!title) throw new GiteeError(400, 'PR 标题不能为空。')
    const head = input.head.trim()
    const base = input.base.trim()
    if (!head || !base) throw new GiteeError(400, 'PR 需要 head 和 base 分支。')
    const row = await this.request<Record<string, unknown>>(repoPath(owner, repo, 'pulls'), {
      method: 'POST',
      body: {
        title,
        head,
        base,
        ...(input.body?.trim() ? { body: input.body } : {}),
      },
    })
    return mapPull(row)
  }

  async commentPull(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.request(repoPath(owner, repo, `pulls/${issueNumber(number)}/comments`), {
      method: 'POST',
      body: { body: requireBody(body) },
    })
  }

  private async request<T>(
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
      body?: unknown
    } = {},
  ): Promise<T> {
    if (!this.token) {
      throw new GiteeError(401, 'Gitee 令牌未配置，请先在 设置 → Gitee 中填写私人令牌。')
    }
    const method = options.method ?? 'GET'
    const url = new URL(`${this.base.toString().replace(/\/+$/, '')}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }

    let reply = await this.send(url, method, options.body)
    if (reply.status === 429 && method === 'GET') {
      const retryMs = Math.min(Math.max(Number(reply.headers.get('retry-after') ?? '1') * 1_000 || 1_000, 200), 2_000)
      await new Promise(resolve => setTimeout(resolve, retryMs))
      reply = await this.send(url, method, options.body)
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new GiteeError(reply.status, this.describeError(reply))
    }
    if (!reply.text.trim()) return undefined as T
    try {
      return JSON.parse(reply.text) as T
    } catch {
      throw new GiteeError(502, 'Gitee 返回了无法解析的响应。')
    }
  }

  private async send(url: URL, method: string, body: unknown): Promise<Reply> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assertSafeUrl(current, this.allowPrivateHost)
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `token ${this.token}`,
      }
      if (body !== undefined) headers['content-type'] = 'application/json'
      const response = await this.fetchImpl(current, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new GiteeError(response.status, `Gitee 重定向缺少 Location。`)
        const next = new URL(location, current)
        if (next.origin !== current.origin) {
          throw new GiteeError(502, 'Gitee 重定向离开了 API 源站，已拒绝。')
        }
        current = next
        continue
      }
      return {
        status: response.status,
        text: await readCapped(response, this.maxBytes),
        headers: response.headers,
      }
    }
    throw new GiteeError(502, 'Gitee 重定向次数过多。')
  }

  private describeError(reply: Reply) {
    let message = ''
    try {
      const body = JSON.parse(reply.text) as Record<string, unknown>
      message = text(body.message) || text(body.error_description) || text(body.error)
    } catch {
      message = reply.text.slice(0, 300)
    }
    if (!message) message = `HTTP ${reply.status}`
    if (this.token) message = message.split(this.token).join('***')
    return `Gitee ${reply.status}: ${message.slice(0, 300)}`
  }
}

function normalizeBase(value?: string) {
  const raw = value?.trim() || DEFAULT_API_BASE
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new GiteeError(400, `无效的 Gitee API 地址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GiteeError(400, 'Gitee API 地址必须是 http(s)。')
  }
  if (url.username || url.password) throw new GiteeError(400, 'Gitee API 地址不能包含账号密码。')
  return new URL(url.toString().replace(/\/+$/, ''))
}

function clampPage(value?: number) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return 1
  return Math.min(Math.floor(number), MAX_PAGE_SIZE)
}

function repoPath(owner: string, repo: string, rest?: string) {
  const base = `/repos/${encodeSegment(owner, 'owner')}/${encodeSegment(repo, 'repo')}`
  return rest ? `${base}/${rest}` : base
}

function encodeSegment(value: string, field: string) {
  const text = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,191}$/.test(text) || text === '.' || text === '..') {
    throw new GiteeError(400, `无效的 Gitee ${field}：${text}`)
  }
  return encodeURIComponent(text)
}

function assertRepoName(value: string) {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,191}$/.test(name) || name === '.' || name === '..') {
    throw new GiteeError(400, `无效的仓库名：${name}`)
  }
  return name
}

function requireBody(value: string) {
  const body = String(value ?? '').trim()
  if (!body) throw new GiteeError(400, '评论内容不能为空。')
  return body
}

function normalizeRepoPath(value?: string) {
  const raw = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = raw.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) {
    throw new GiteeError(400, `无效的仓库路径：${raw}`)
  }
  return parts.join('/')
}

function issueNumber(value: number) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new GiteeError(400, '无效的编号。')
  return number
}

function issueState(value?: string) {
  return value === 'closed' || value === 'all' ? value : 'open'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function clip(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false }
  return { text: value.slice(0, maxBytes), truncated: true }
}

function mapRepo(value: unknown): GiteeRepoSummary {
  const row = record(value)
  const owner = text(record(row.owner).login) || text(record(row.namespace).path)
  const name = text(row.name)
  return {
    fullName: text(row.full_name) || [owner, name].filter(Boolean).join('/'),
    name,
    owner,
    ...(text(row.description) ? { description: text(row.description) } : {}),
    private: row.private === true,
    ...(text(row.html_url) ? { htmlUrl: webUrl(text(row.html_url)) } : {}),
    ...(text(row.default_branch) ? { defaultBranch: text(row.default_branch) } : {}),
    ...(text(row.updated_at) ? { updatedAt: text(row.updated_at) } : {}),
  }
}

/** Gitee returns `.git` in `html_url`; links shown to humans must not carry it. */
function webUrl(value: string) {
  return value.trim().replace(/\.git$/, '')
}

function mapContentEntry(value: unknown): GiteeContentEntry {
  const row = record(value)
  return {
    name: text(row.name),
    path: text(row.path),
    type: text(row.type) || 'file',
    ...(Number.isFinite(Number(row.size)) ? { size: Number(row.size) } : {}),
  }
}

function mapRelease(value: unknown): GiteeRelease {
  const row = record(value)
  return {
    ...(Number.isFinite(Number(row.id)) ? { id: Number(row.id) } : {}),
    tagName: text(row.tag_name) || text(row.tag),
    ...(text(row.name) ? { name: text(row.name) } : {}),
    ...(text(row.body) ? { body: text(row.body) } : {}),
    ...(text(row.created_at) ? { createdAt: text(row.created_at) } : {}),
    ...(text(row.html_url) ? { htmlUrl: webUrl(text(row.html_url)) } : {}),
  }
}

function mapIssue(value: unknown): GiteeIssueSummary {
  const row = record(value)
  const labels = Array.isArray(row.labels)
    ? row.labels.map(label => text(record(label).name) || text(label)).filter(Boolean)
    : []
  return {
    number: Number(row.number) || 0,
    title: text(row.title),
    state: text(row.state) || 'open',
    ...(text(record(row.user).login) ? { author: text(record(row.user).login) } : {}),
    ...(text(row.created_at) ? { createdAt: text(row.created_at) } : {}),
    ...(text(row.updated_at) ? { updatedAt: text(row.updated_at) } : {}),
    ...(labels.length ? { labels } : {}),
  }
}

function mapPull(value: unknown): GiteePullSummary {
  const row = record(value)
  const head = text(record(row.head).ref) || text(row.head)
  const base = text(record(row.base).ref) || text(row.base)
  return {
    number: Number(row.number) || 0,
    title: text(row.title),
    state: text(row.state) || 'open',
    ...(text(record(row.user).login) ? { author: text(record(row.user).login) } : {}),
    ...(text(row.created_at) ? { createdAt: text(row.created_at) } : {}),
    ...(text(row.updated_at) ? { updatedAt: text(row.updated_at) } : {}),
    ...(head ? { head } : {}),
    ...(base ? { base } : {}),
  }
}

async function readCapped(response: Response, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new GiteeError(502, 'Gitee 响应超过大小上限。')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
}

/** Mirrors packages/a2a/src/card.ts: no non-HTTP schemes, no private hosts. */
function assertSafeUrl(url: URL, allowPrivateHost: boolean) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GiteeError(400, `不支持的协议：${url.protocol}`)
  }
  if (allowPrivateHost) return
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') {
    throw new GiteeError(400, '不允许访问私网 Gitee 地址。')
  }
  const family = isIP(host)
  if (family === 4 && isPrivateIpv4(host)) throw new GiteeError(400, '不允许访问私网 Gitee 地址。')
  if (family === 6 && isPrivateIpv6(host)) throw new GiteeError(400, '不允许访问私网 Gitee 地址。')
}

function isPrivateIpv4(host: string) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

function isPrivateIpv6(host: string) {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase()
  return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')
}

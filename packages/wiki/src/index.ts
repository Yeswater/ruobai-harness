import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { PromptSection } from '@ruobai/context'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'
import type {} from '@ruobai/workspace'
import { Bm25Index, buildTerms, type WeightedDocument } from './bm25.ts'
import { chunkPage, type WikiChunk } from './chunk.ts'
import { createDiff } from './diff.ts'
import {
  PAGE_ID,
  hashContent,
  overviewOf,
  parsePage,
  serializePage,
  summaryOf,
  type PageMeta,
  type PageSource,
  type PageStatus,
} from './frontmatter.ts'

export type { PageMeta, PageSource, PageStatus } from './frontmatter.ts'
export { parsePage, serializePage, summaryOf, overviewOf } from './frontmatter.ts'
export { chunkPage } from './chunk.ts'
export { tokenize, Bm25Index } from './bm25.ts'

export interface Config {
  /** Wiki root; defaults to `<workspace>/.ruobai/wiki`. */
  root?: string
  maxPages?: number
  maxPageBytes?: number
  searchLimit?: number
  searchMaxChars?: number
  searchTimeoutMs?: number
  summaryMaxChars?: number
  overviewMaxChars?: number
  catalogMaxChars?: number
}

export interface IndexedPage {
  /** POSIX path relative to the wiki root, e.g. `pages/sandbox-seatbelt.md`. */
  path: string
  id: string
  title: string
  tags: string[]
  status: PageStatus
  confidence: string
  sourced: boolean
  summary: string
  overview: string
  updated?: string
  mtime: number
  size: number
  hash: string
  chunks: WikiChunk[]
}

export interface WikiIndex {
  version: 1
  pages: IndexedPage[]
}

export type ReadLevel = 'summary' | 'overview' | 'full'

export interface SearchOptions {
  limit?: number
  maxChars?: number
  timeoutMs?: number
  tag?: string
}

export interface WikiHit {
  page: string
  title: string
  heading: string
  score: number
  snippet: string
  summary: string
  status: PageStatus
  level: 0
}

export interface SearchResult {
  hits: WikiHit[]
  truncated: boolean
}

export interface WriteInput {
  id?: string
  title: string
  body: string
  tags?: string[]
  sources?: PageSource[]
  confidence?: 'high' | 'medium' | 'low'
  status?: PageStatus
}

declare module '@ruobai/cordis' {
  interface Context {
    wiki: WikiService
  }

  interface Events {
    'wiki/indexed'(info: { pages: number; chunks: number; rebuilt: number; durationMs: number }): void
  }
}

interface CacheEntry {
  signature: string
  index: WikiIndex
  searcher?: Searcher
}

interface Searcher {
  bm25: Bm25Index
  refs: Array<{ page: IndexedPage; chunk: WikiChunk }>
}

/**
 * Markdown wiki: pages on disk are the source of truth, `.index/` is a
 * rebuildable derived cache, and retrieval is lexical (BM25 with CJK bigrams)
 * so the whole feature works offline.
 */
export class WikiService extends Service {
  static inject = ['sessions', 'workspace', 'tools']

  static Config: z<Config> = z.object({
    root: z.string(),
    maxPages: z.number().min(1).default(5_000),
    maxPageBytes: z.number().min(1).default(65_536),
    searchLimit: z.number().min(1).default(8),
    searchMaxChars: z.number().min(1).default(6_000),
    searchTimeoutMs: z.number().min(1).default(150),
    summaryMaxChars: z.number().min(1).default(300),
    overviewMaxChars: z.number().min(1).default(4_000),
    catalogMaxChars: z.number().min(1).default(1_200),
  })

  private readonly cache = new Map<string, CacheEntry>()
  private readonly refreshNeeded = new Set<string>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'wiki')

    ctx.effect(() => {
      const disposers = wikiTools(this).map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'wiki.tools')

    // Same optional-registry pattern as `memory`: register now when the
    // context service is already mounted, otherwise wait for it.
    const section: PromptSection = {
      id: 'wiki',
      order: 50,
      stability: 'session',
      maxChars: this.config.catalogMaxChars ?? 1_200,
      render: input => this.injection(input.sessionId),
    }
    const context = ctx.get('context', false) as {
      registerSection(value: PromptSection): () => void
    } | undefined
    if (context) {
      ctx.effect(() => context.registerSection(section), 'wiki.section')
    } else {
      ctx.inject(['context'], sectionCtx => {
        sectionCtx.effect(() => sectionCtx.context.registerSection(section), 'wiki.section')
      })
    }

    ctx.on('context/compacted', info => this.refreshNeeded.add(info.sessionId))
  }

  root(sessionId?: string) {
    if (this.config.root) return resolve(this.config.root)
    return join(this.ctx.workspace.rootFor(sessionId), '.ruobai', 'wiki')
  }

  /** Pages minus the wrong kind of file: no symlinks, no non-markdown. */
  private async pageFiles(root: string) {
    const dir = join(root, 'pages')
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const files: Array<{ path: string; mtime: number; size: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const info = await stat(join(dir, entry.name)).catch(() => undefined)
      if (!info) continue
      files.push({ path: `pages/${entry.name}`, mtime: info.mtimeMs, size: info.size })
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }

  private async readIndexFile(root: string): Promise<WikiIndex | undefined> {
    try {
      const raw = await readFile(join(root, '.index', 'index.json'), 'utf8')
      const data = JSON.parse(raw) as WikiIndex
      return data?.version === 1 && Array.isArray(data.pages) ? data : undefined
    } catch {
      return undefined
    }
  }

  private async writeIndexFile(root: string, index: WikiIndex) {
    await writeAtomic(join(root, '.index', 'index.json'), `${JSON.stringify(index)}\n`)
  }

  /** Load, incrementally refresh and memoize the index for one root. */
  private async indexFor(root: string): Promise<WikiIndex> {
    const files = await this.pageFiles(root)
    const signature = files.map(file => `${file.path}:${file.mtime}:${file.size}`).join('|')
    const cached = this.cache.get(root)
    if (cached?.signature === signature) return cached.index

    const started = Date.now()
    const persisted = await this.readIndexFile(root)
    const reuse = new Map((persisted?.pages ?? []).map(page => [
      `${page.path}:${page.mtime}:${page.size}`,
      page,
    ]))
    const pages: IndexedPage[] = []
    let rebuilt = 0
    for (const file of files.slice(0, this.config.maxPages ?? 5_000)) {
      const kept = reuse.get(`${file.path}:${file.mtime}:${file.size}`)
      if (kept && kept.hash) {
        pages.push(kept)
        continue
      }
      const raw = await readFile(join(root, file.path), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      const doc = parsePage(raw)
      if (!doc) continue
      pages.push(indexPage(file.path, file.mtime, file.size, raw, doc))
      rebuilt += 1
    }

    const index: WikiIndex = { version: 1, pages }
    this.cache.set(root, { signature, index })
    // Rewrite when a page was re-parsed or disappeared; an unchanged set is
    // left alone so reads do not churn the file.
    if (rebuilt > 0 || !persisted || pages.length !== persisted.pages.length) {
      await this.writeIndexFile(root, index).catch(() => undefined)
      this.ctx.emit('wiki/indexed', {
        pages: pages.length,
        chunks: pages.reduce((total, page) => total + page.chunks.length, 0),
        rebuilt,
        durationMs: Date.now() - started,
      })
    }
    return index
  }

  private searcherFor(root: string, index: WikiIndex): Searcher {
    const cached = this.cache.get(root)
    if (cached?.searcher) return cached.searcher
    const documents: WeightedDocument[] = []
    const refs: Searcher['refs'] = []
    for (const page of index.pages) {
      for (const chunk of page.chunks) {
        documents.push(buildTerms([
          { text: page.title, weight: 3 },
          { text: page.tags.join(' '), weight: 2 },
          { text: chunk.heading, weight: 2 },
          { text: chunk.text, weight: 1 },
        ]))
        refs.push({ page, chunk })
      }
    }
    const searcher = { bm25: new Bm25Index(documents), refs }
    if (cached) cached.searcher = searcher
    return searcher
  }

  async search(query: string, options: SearchOptions = {}, sessionId?: string): Promise<SearchResult> {
    const root = this.root(sessionId)
    const index = await this.indexFor(root)
    const searcher = this.searcherFor(root, index)
    const limit = Math.max(1, Math.min(options.limit ?? this.config.searchLimit ?? 8, 50))
    const maxChars = Math.max(1, options.maxChars ?? this.config.searchMaxChars ?? 6_000)
    const deadline = Date.now() + Math.max(1, options.timeoutMs ?? this.config.searchTimeoutMs ?? 150)
    // A tag filter runs after ranking, so over-fetch to keep the page full.
    const ranked = searcher.bm25.search(query, {
      limit: options.tag ? limit * 4 : limit,
      deadline,
    })

    const hits: WikiHit[] = []
    let chars = 0
    let truncated = Date.now() > deadline
    for (const { index: position, score } of ranked) {
      const entry = searcher.refs[position]
      if (!entry) continue
      const { page, chunk } = entry
      if (options.tag && !page.tags.includes(options.tag)) continue
      const snippet = chunk.text.length > 400 ? `${chunk.text.slice(0, 399)}…` : chunk.text
      const cost = snippet.length + page.summary.length + 80
      if (hits.length >= limit || chars + cost > maxChars) {
        truncated = true
        break
      }
      hits.push({
        page: page.id,
        title: page.title,
        heading: chunk.heading,
        score: Number(score.toFixed(3)),
        snippet,
        summary: page.summary,
        status: page.status,
        level: 0,
      })
      chars += cost
    }
    return { hits, truncated }
  }

  /** Three-level read: summary (L0), overview (L1), full body (L2). */
  async read(page: string, level: ReadLevel = 'full', sessionId?: string): Promise<string | undefined> {
    const root = this.root(sessionId)
    const index = await this.indexFor(root)
    const found = index.pages.find(item =>
      item.id === page || item.path === page || item.path === `pages/${page}.md`)
    if (!found) return undefined
    if (level === 'summary') return found.summary
    if (level === 'overview') {
      return [`${found.title} (${found.id})`, found.summary, found.overview].filter(Boolean).join('\n\n')
    }
    const raw = await readFile(join(root, found.path), 'utf8').catch(() => undefined)
    if (raw === undefined) return undefined
    return parsePage(raw)?.body ?? raw
  }

  async write(input: WriteInput, sessionId?: string): Promise<{ id: string; path: string; revision: number; created: boolean; text: string }> {
    const root = this.root(sessionId)
    const id = input.id?.trim() || slugify(input.title)
    if (!PAGE_ID.test(id)) throw new Error(`invalid page id: ${id}`)
    const target = join(root, 'pages', `${id}.md`)
    if (!inside(root, target)) throw new Error('path escapes the wiki root')

    const body = input.body.trim()
    const existingRaw = await readFile(target, 'utf8').catch(() => undefined)
    const existing = existingRaw ? parsePage(existingRaw) : undefined
    const sources = input.sources ?? existing?.meta.sources ?? (
      sessionId ? [{ kind: 'session' as const, session: sessionId }] : []
    )
    const text = serializePage({
      meta: {
        id,
        title: input.title?.trim() || existing?.meta.title || id,
        tags: [...new Set(input.tags ?? existing?.meta.tags ?? [])],
        sources,
        updated: new Date().toISOString(),
        confidence: sources.length ? input.confidence ?? existing?.meta.confidence ?? 'medium' : 'low',
        status: sources.length ? input.status ?? existing?.meta.status ?? 'ready' : 'draft',
        revision: (existing?.meta.revision ?? 0) + 1,
      },
      body,
    })
    const bytes = Buffer.byteLength(text)
    if (bytes > (this.config.maxPageBytes ?? 65_536)) {
      throw new Error(`page is larger than ${this.config.maxPageBytes ?? 65_536} bytes`)
    }

    await captureCheckpoint(this.ctx, {
      sessionId,
      root: this.ctx.workspace.rootFor(sessionId),
      target,
      before: existingRaw,
      after: text,
      diff: createDiff(existingRaw ?? '', text, `pages/${id}.md`),
    })
    await writeAtomic(target, text)
    this.cache.delete(root)
    // Keep the derived index in step with the write; a failure here must not
    // fail the write, since the next search rebuilds from Markdown anyway.
    await this.indexFor(root).catch(() => undefined)
    const revision = (existing?.meta.revision ?? 0) + 1
    if (sessionId) {
      this.ctx.sessions.append(sessionId, 'wiki/updated', {
        page: id,
        path: `pages/${id}.md`,
        revision,
        created: !existing,
      })
    }
    return { id, path: `pages/${id}.md`, revision, created: !existing, text }
  }

  /** Existing page bytes, for approval previews. */
  async raw(id: string, sessionId?: string) {
    const root = this.root(sessionId)
    if (!PAGE_ID.test(id)) return undefined
    return readFile(join(root, 'pages', `${id}.md`), 'utf8').catch(() => undefined)
  }

  /** `<wiki_catalog>` block; empty when there is nothing curated to show. */
  private async catalog(sessionId?: string): Promise<{ text: string; pages: number }> {
    const root = this.root(sessionId)
    const index = await this.indexFor(root)
    const budget = this.config.catalogMaxChars ?? 1_200
    const lines: string[] = []
    let used = 0

    const manual = await readFile(join(root, 'index.md'), 'utf8').catch(() => '')
    for (const line of manual.split('\n').map(value => value.trim()).filter(Boolean)) {
      if (line.startsWith('#')) continue
      const clipped = line.length > 160 ? `${line.slice(0, 159)}…` : line
      if (used + clipped.length > budget) break
      lines.push(clipped)
      used += clipped.length + 1
    }

    const curated = index.pages
      .filter(page => page.status === 'ready' && page.sourced && page.summary)
      .sort((left, right) => left.id.localeCompare(right.id))
    let shown = 0
    for (const page of curated) {
      const line = `- ${page.id}: ${page.summary}`
      if (used + line.length > budget) break
      lines.push(line)
      used += line.length + 1
      shown += 1
    }

    if (!lines.length) return { text: '', pages: 0 }
    return {
      text: [
        '<wiki_catalog>',
        ...lines,
        'Use wiki_search to find pages, then wiki_read with level summary, overview or full.',
        '</wiki_catalog>',
      ].join('\n'),
      pages: shown,
    }
  }

  /** Session snapshot of the catalog, replayed from `wiki/injected`. */
  async injection(sessionId: string): Promise<string> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return ''
    const previous = latestInjected(record)
    if (previous && !this.refreshNeeded.has(sessionId)) return previous.text

    const catalog = await this.catalog(sessionId)
    this.refreshNeeded.delete(sessionId)
    if (!catalog.text && !previous) return ''

    const revision = hashContent(catalog.text)
    this.ctx.sessions.append(sessionId, 'wiki/injected', {
      at: Date.now(),
      revision,
      pages: catalog.pages,
      text: catalog.text,
      bytes: catalog.text.length,
    })
    return catalog.text
  }
}

function indexPage(path: string, mtime: number, size: number, raw: string, doc: { meta: PageMeta; body: string }): IndexedPage {
  return {
    path,
    id: doc.meta.id,
    title: doc.meta.title,
    tags: doc.meta.tags,
    status: doc.meta.status,
    confidence: doc.meta.confidence ?? 'medium',
    sourced: doc.meta.sources.length > 0,
    summary: summaryOf(doc.body, 300),
    overview: overviewOf(doc.body, 4_000),
    ...(doc.meta.updated ? { updated: doc.meta.updated } : {}),
    mtime,
    size,
    hash: hashContent(raw),
    chunks: chunkPage(doc.body),
  }
}

function latestInjected(record: { events: Array<{ type: string; data: any }> }) {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index]!
    if (event.type === 'wiki/injected') return { text: String(event.data?.text ?? '') }
  }
}

/**
 * Wiki pages are harness state, but a model-triggered edit still has to be
 * revertible: record the bytes before the write when a session is known.
 */
async function captureCheckpoint(ctx: Context, input: {
  sessionId?: string
  root: string
  target: string
  before?: string
  after: string
  diff?: string
}) {
  if (!input.sessionId) return
  // Outside the workspace (an isolated wiki root, say) there is nothing to
  // roll back to; skip instead of asking checkpoints to reject it.
  const relativePath = relative(input.root, input.target)
  if (relativePath.startsWith('..') || relativePath.startsWith(sep)) return
  const checkpoints = ctx.get('checkpoints', false) as
    | { capture?(value: {
      sessionId: string
      path: string
      tool: string
      before?: Buffer
      beforeExisted: boolean
      after: Buffer
      diff?: string
    }): Promise<void> }
    | undefined
  if (!checkpoints?.capture) return
  try {
    await checkpoints.capture({
      sessionId: input.sessionId,
      path: relativePath.split(sep).join('/'),
      tool: 'wiki_write',
      before: input.before === undefined ? undefined : Buffer.from(input.before),
      beforeExisted: input.before !== undefined,
      after: Buffer.from(input.after),
      ...(input.diff ? { diff: input.diff } : {}),
    })
  } catch (error) {
    ctx.logger('wiki').warn('checkpoint capture failed: %s',
      error instanceof Error ? error.message : String(error))
  }
}

function slugify(title: string) {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (PAGE_ID.test(ascii) && ascii.replace(/-/g, '').length >= 3) return ascii
  return `page-${hashContent(title).slice(0, 8)}`
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))
}

async function writeAtomic(target: string, content: string) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, target)
}

function wikiTools(service: WikiService): ToolDefinition[] {
  return [
    {
      name: 'wiki_search',
      description: 'Search the project wiki (lexical, offline). Returns page ids, headings and snippets; use wiki_read for more.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'number', description: 'Default 8.' },
        },
        required: ['query'],
      },
      readOnly: true,
      async execute(args, run) {
        const result = await service.search(String(args?.query ?? ''), {
          ...(args?.limit ? { limit: args.limit } : {}),
          ...(args?.tag ? { tag: args.tag } : {}),
        }, run?.sessionId)
        if (!result.hits.length) return 'No matching wiki page.'
        const lines = result.hits.map(hit =>
          `${hit.page} > ${hit.heading} (${hit.score})\n  ${hit.summary}\n  … ${hit.snippet}`)
        if (result.truncated) lines.push('… more results omitted')
        return lines.join('\n\n')
      },
    },
    {
      name: 'wiki_read',
      description: 'Read one wiki page: level "summary" (L0), "overview" (L1, headings + first sentences) or "full" (L2).',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id, e.g. sandbox-seatbelt.' },
          level: { type: 'string', enum: ['summary', 'overview', 'full'] },
        },
        required: ['page'],
      },
      readOnly: true,
      async execute(args, run) {
        const level = args?.level === 'summary' || args?.level === 'overview' ? args.level : 'full'
        const text = await service.read(String(args?.page ?? ''), level, run?.sessionId)
        if (text === undefined) return `Wiki page not found: ${args?.page}`
        return text
      },
    },
    {
      name: 'wiki_write',
      description: 'Create or update a curated wiki page. Requires approval; the page must have a source.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Lowercase slug; derived from the title when omitted.' },
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown body; start with "## 摘要" for a one-paragraph summary.' },
          tags: { type: 'array', items: { type: 'string' } },
          sources: {
            type: 'array',
            description: 'Where the facts come from: {kind:file,path} or {kind:session,session}.',
            items: { type: 'object' },
          },
        },
        required: ['title', 'body'],
      },
      requiresApproval: true,
      approvalSubject(args, run) {
        const id = args?.id?.trim() || slugify(String(args?.title ?? ''))
        return { kind: 'path', value: join(service.root(run?.sessionId), 'pages', `${id}.md`) }
      },
      async preview(args, run) {
        const id = args?.id?.trim() || slugify(String(args?.title ?? ''))
        const before = await service.raw(id, run?.sessionId)
        return {
          summary: `wiki ${id} · ${before === undefined ? 'new page' : 'update'} · ${Buffer.byteLength(String(args?.body ?? ''))} bytes`,
          diff: createDiff(before ?? '', String(args?.body ?? ''), `wiki/pages/${id}.md`),
        }
      },
      async execute(args, run) {
        const result = await service.write({
          title: String(args?.title ?? ''),
          body: String(args?.body ?? ''),
          ...(args?.id ? { id: String(args.id) } : {}),
          ...(Array.isArray(args?.tags) ? { tags: args.tags } : {}),
          ...(Array.isArray(args?.sources) ? { sources: args.sources } : {}),
        }, run?.sessionId)
        return `${result.created ? 'Created' : 'Updated'} ${result.path} (revision ${result.revision})`
      },
    },
  ]
}

export default WikiService

export const meta = {
  title: '知识库',
  description: 'Markdown 页面 + 本地 BM25 检索，供模型按需读取。',
}

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { PromptSection } from '@ruobai/context'
import type {} from '@ruobai/session'
import type { ToolDefinition } from '@ruobai/tools'
import type {} from '@ruobai/workspace'
import { compileInjection, DEFAULT_MAX_INJECT_TOKENS, revisionOf } from './compile.ts'
import {
  foldJournal,
  isActive,
  memoryId,
  normalizeText,
  screenText,
  type MemoryItem,
  type MemoryKind,
  type MemoryScope,
  type MemorySource,
} from './journal.ts'
import { MemoryStore } from './store.ts'

export type { MemoryItem, MemoryKind, MemoryOp, MemoryScope, MemorySource } from './journal.ts'
export { foldJournal, memoryId, normalizeText, screenText } from './journal.ts'
export { compileInjection, compileSnapshot, revisionOf } from './compile.ts'

export interface Config {
  /** User-global protocol directory; defaults to ~/.ruobai. */
  globalRoot?: string
  /** Hard ceiling for the injected block, in estimated tokens. */
  maxInjectTokens?: number
  searchLimit?: number
  searchMaxChars?: number
}

export interface SaveInput {
  text: string
  kind?: MemoryKind
  tags?: string[]
  scope?: MemoryScope
  pinned?: boolean
  confidence?: number
  source?: MemorySource
}

export interface SearchOptions {
  limit?: number
  maxChars?: number
  scope?: MemoryScope
  tag?: string
}

export interface SearchResult {
  items: MemoryItem[]
  truncated: boolean
}

declare module '@ruobai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/**
 * Cross-session long-term memory.
 *
 * Two append-only journals (user-global and per-project) are compiled into a
 * deterministic, budgeted block that `context` renders once per session. The
 * journal is the source of truth; `MEMORY.md` is a readable snapshot and the
 * session log only records what the model actually saw (`memory/injected`).
 */
export class MemoryService extends Service {
  static inject = ['sessions', 'workspace', 'tools']

  static Config: z<Config> = z.object({
    globalRoot: z.string(),
    maxInjectTokens: z.number().min(0).default(DEFAULT_MAX_INJECT_TOKENS),
    searchLimit: z.number().min(1).default(20),
    searchMaxChars: z.number().min(1).default(4_000),
  })

  private readonly stores = new Map<string, MemoryStore>()
  /** Sessions whose snapshot must be re-rendered after a compaction. */
  private readonly refreshNeeded = new Set<string>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'memory')

    ctx.effect(() => {
      const disposers = memoryTools(this).map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'memory.tools')

    // The section registry lives in `context`, which is optional for tests and
    // for hosts that swap the prompt builder: wait for it when it is mounted
    // later, register immediately when it is already there.
    const section: PromptSection = {
      id: 'memory',
      order: 40,
      stability: 'session',
      maxChars: (this.config.maxInjectTokens ?? DEFAULT_MAX_INJECT_TOKENS) * 3 + 200,
      render: input => this.injection(input.sessionId),
    }
    const context = ctx.get('context', false) as {
      registerSection(value: PromptSection): () => void
    } | undefined
    if (context) {
      ctx.effect(() => context.registerSection(section), 'memory.section')
    } else {
      ctx.inject(['context'], sectionCtx => {
        sectionCtx.effect(() => sectionCtx.context.registerSection(section), 'memory.section')
      })
    }

    // A compaction is a new prompt epoch: the session snapshot is refreshed
    // once, and the break is attributed to this section.
    ctx.on('context/compacted', info => this.refreshNeeded.add(info.sessionId))
  }

  /** Memory directories for a session's project and the current user. */
  dirs(sessionId?: string) {
    const globalRoot = this.config.globalRoot ?? join(homedir(), '.ruobai')
    const projectRoot = join(this.ctx.workspace.rootFor(sessionId), '.ruobai')
    return {
      global: join(globalRoot, 'memory'),
      project: join(projectRoot, 'memory'),
    }
  }

  private store(dir: string) {
    let store = this.stores.get(dir)
    if (!store) {
      store = new MemoryStore(dir)
      this.stores.set(dir, store)
    }
    return store
  }

  private storeFor(scope: MemoryScope, sessionId?: string) {
    return this.store(this.dirs(sessionId)[scope])
  }

  /** Active and dormant items from both scopes, keyed by id. */
  async items(sessionId?: string): Promise<Map<string, MemoryItem>> {
    const dirs = this.dirs(sessionId)
    const [globalOps, projectOps] = await Promise.all([
      this.store(dirs.global).load(),
      this.store(dirs.project).load(),
    ])
    return new Map([...foldJournal(globalOps), ...foldJournal(projectOps)])
  }

  /**
   * The block this session's model sees. Rendered once at the first build and
   * then replayed from `memory/injected`, so the prefix stays byte-stable even
   * when the journal changes mid-session.
   */
  async injection(sessionId: string): Promise<string> {
    const record = this.ctx.sessions.get(sessionId)
    if (!record) return ''
    const previous = latestInjected(record)
    if (previous && !this.refreshNeeded.has(sessionId)) return previous.text

    const compiled = compileInjection([...(await this.items(sessionId)).values()], {
      maxTokens: this.config.maxInjectTokens,
    })
    this.refreshNeeded.delete(sessionId)
    if (!compiled.text && !previous) return ''

    this.ctx.sessions.append(sessionId, 'memory/injected', {
      at: Date.now(),
      revision: compiled.revision,
      scope: 'all',
      text: compiled.text,
      bytes: compiled.text.length,
      ids: compiled.ids,
    })
    return compiled.text
  }

  async search(query: string | undefined, options: SearchOptions = {}, sessionId?: string): Promise<SearchResult> {
    const term = normalizeText(query ?? '').toLowerCase()
    const limit = Math.max(1, Math.min(options.limit ?? this.config.searchLimit ?? 20, 100))
    const maxChars = Math.max(1, options.maxChars ?? this.config.searchMaxChars ?? 4_000)
    const matches = [...(await this.items(sessionId)).values()]
      .filter(item => !options.scope || item.scope === options.scope)
      .filter(item => !options.tag || item.tags.includes(options.tag))
      .map(item => ({ item, score: matchScore(item, term) }))
      .filter(entry => entry.score !== undefined)
      .sort((left, right) => left.score! - right.score!
        || Number(right.item.pinned) - Number(left.item.pinned)
        || left.item.id.localeCompare(right.item.id))

    const items: MemoryItem[] = []
    let chars = 0
    for (const { item } of matches) {
      if (items.length >= limit) break
      if (chars + item.text.length > maxChars) break
      items.push(item)
      chars += item.text.length
    }
    return { items, truncated: items.length < matches.length }
  }

  async save(input: SaveInput, sessionId?: string): Promise<{ id: string; item: MemoryItem; created: boolean }> {
    const text = input.text.replace(/\s+/g, ' ').trim()
    const problem = screenText(text)
    if (problem) throw new Error(problem)
    const scope = input.scope ?? 'project'
    const kind = input.kind ?? 'fact'
    const store = this.storeFor(scope, sessionId)
    const items = foldJournal(await store.load())
    const id = memoryId(scope, text)
    const existing = items.get(id)
    if (existing && isActive(existing)) return { id, item: existing, created: false }

    const now = Date.now()
    const item: MemoryItem = {
      id,
      scope,
      kind,
      text,
      tags: unique(input.tags ?? []),
      source: { kind: 'user', ...(sessionId ? { sessionId } : {}), ...input.source },
      confidence: input.confidence ?? (input.source?.kind === 'assistant' ? 0.6 : 1),
      ...(input.pinned ? { pinned: true } : {}),
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      hits: 0,
    }
    await store.append({ op: 'add', at: now, item })
    items.set(id, item)
    await store.writeSnapshot([...items.values()])
    if (sessionId) {
      this.ctx.sessions.append(sessionId, 'memory/added', {
        id,
        item,
        reason: 'save',
        source: item.source,
      })
    }
    return { id, item, created: true }
  }

  async forget(target: { id?: string; query?: string }, sessionId?: string): Promise<string[]> {
    const dirs = this.dirs(sessionId)
    const stores = [this.store(dirs.global), this.store(dirs.project)]
    const folded = await Promise.all(stores.map(store => store.load()))
    const forgotten: string[] = []

    for (let index = 0; index < stores.length; index += 1) {
      const items = foldJournal(folded[index]!)
      const matches = [...items.values()].filter(item => {
        if (!isActive(item)) return false
        if (target.id) return item.id === target.id
        const query = normalizeText(target.query ?? '').toLowerCase()
        return Boolean(query) && item.text.toLowerCase().includes(query)
      })
      if (!matches.length) continue
      const now = Date.now()
      for (const item of matches) {
        await stores[index]!.append({ op: 'forget', at: now, id: item.id, reason: 'user' })
        item.validTo = now
        forgotten.push(item.id)
        if (sessionId) {
          this.ctx.sessions.append(sessionId, 'memory/forgot', {
            id: item.id,
            reason: 'user',
            source: { kind: 'user' },
          })
        }
      }
      await stores[index]!.writeSnapshot([...items.values()])
    }

    if (!forgotten.length) throw new Error('no matching memory')
    return forgotten
  }

  /** Current injected revision, for UI and diagnostics. */
  async revision(sessionId?: string) {
    return revisionOf([...(await this.items(sessionId)).values()])
  }
}

function matchScore(item: MemoryItem, term: string) {
  if (!term) return 3
  if (item.text.toLowerCase().includes(term)) return 0
  if (item.tags.some(tag => tag.toLowerCase().includes(term))) return 1
  if (item.kind === term) return 2
  return undefined
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function latestInjected(record: { events: Array<{ type: string; data: any }> }) {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index]!
    if (event.type === 'memory/injected') return { text: String(event.data?.text ?? '') }
  }
}

function memoryTools(service: MemoryService): ToolDefinition[] {
  return [
    {
      name: 'memory_search',
      description: 'Search long-term memory entries (active and dormant). Returns id, kind, scope, text and tags.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against text, tags or kind.' },
          scope: { type: 'string', enum: ['global', 'project'] },
          tag: { type: 'string' },
          limit: { type: 'number', description: 'Default 20.' },
        },
      },
      readOnly: true,
      async execute(args, run) {
        const result = await service.search(args?.query, {
          limit: args?.limit,
          ...(args?.scope ? { scope: args.scope } : {}),
          ...(args?.tag ? { tag: args.tag } : {}),
        }, run?.sessionId)
        if (!result.items.length) return 'No matching memory.'
        const lines = result.items.map(item =>
          `${item.id} [${item.kind}] (${item.scope}${item.validTo ? ', dormant' : ''}) ${item.text}`
          + (item.tags.length ? ` #${item.tags.join(' #')}` : ''))
        if (result.truncated) lines.push('… more matches omitted')
        return lines.join('\n')
      },
    },
    {
      name: 'memory_save',
      description: 'Save one durable fact to long-term memory. Use for user preferences, constraints, confirmed decisions and gotchas.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One self-contained sentence, at most 240 characters.' },
          kind: { type: 'string', enum: ['preference', 'constraint', 'decision', 'fact', 'gotcha', 'procedure'] },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Defaults to project.' },
        },
        required: ['text'],
      },
      requiresApproval: true,
      preview(args) {
        return {
          summary: `Save [${args?.kind ?? 'fact'}] memory (${args?.scope ?? 'project'}): ${String(args?.text ?? '').slice(0, 160)}`,
        }
      },
      async execute(args, run) {
        const result = await service.save({
          text: String(args?.text ?? ''),
          ...(args?.kind ? { kind: args.kind } : {}),
          ...(Array.isArray(args?.tags) ? { tags: args.tags } : {}),
          ...(args?.scope ? { scope: args.scope } : {}),
          source: { kind: 'assistant', ...(run?.sessionId ? { sessionId: run.sessionId } : {}) },
        }, run?.sessionId)
        return result.created ? `Saved ${result.id}` : `Already saved as ${result.id}`
      },
    },
    {
      name: 'memory_forget',
      description: 'Invalidate matching long-term memory entries. History stays in the journal.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact memory id.' },
          query: { type: 'string', description: 'Forget every active entry matching this text.' },
        },
      },
      requiresApproval: true,
      preview(args) {
        return {
          summary: args?.id ? `Forget memory ${args.id}` : `Forget memories matching "${String(args?.query ?? '').slice(0, 80)}"`,
        }
      },
      async execute(args, run) {
        const forgotten = await service.forget({
          ...(args?.id ? { id: String(args.id) } : {}),
          ...(args?.query ? { query: String(args.query) } : {}),
        }, run?.sessionId)
        return `Forgot ${forgotten.join(', ')}`
      },
    },
  ]
}

export default MemoryService

export const meta = {
  title: '长期记忆',
  description: '跨会话保存偏好、约束与决策，按预算注入会话。',
}

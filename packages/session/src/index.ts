import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'
import type {
  EventVisibility,
  ProjectionDefinition,
  SessionEvent,
  SessionMeta,
  SessionRecord,
  SessionView,
} from './types.ts'
import { inferVisibility } from './visibility.ts'

export type * from './types.ts'
export { inferVisibility, visibleTo } from './visibility.ts'

export interface CreateSessionOptions {
  id?: string
  title?: string
  model?: string
  provider?: string
  mode?: string
  kind?: string
  parentId?: string
  workspace?: string
  permission?: string
  profile?: string
  createdAt?: number
}

export interface ForkOptions {
  /** Copy events only up to and including this seq. Defaults to the whole log. */
  upToSeq?: number
  title?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    sessions: SessionService
  }

  interface Events {
    'session/created'(meta: SessionMeta): void
    'session/removed'(id: string): void
    'session/event'(sessionId: string, event: SessionEvent): void
    'session/updated'(meta: SessionMeta): void
  }
}

/**
 * Event-sourced session store.
 *
 * The log is the source of truth; titles, model metadata and every plugin
 * projection are derived from appending to it. Persistence adapters subscribe
 * to `session/event` and never mutate a session directly.
 */
export class SessionService extends Service {
  private readonly records = new Map<string, SessionRecord>()
  private readonly projections = new Map<string, ProjectionDefinition>()
  private readonly views = new Map<string, SessionView>()
  private readonly projectionFailures: Array<{ key: string; seq: number; message: string }> = []

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  list(): SessionMeta[] {
    return [...this.records.values()]
      .map(record => record.meta)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id)
  }

  has(id: string) {
    return this.records.has(id)
  }

  create(options: CreateSessionOptions = {}): SessionMeta {
    const now = options.createdAt ?? Date.now()
    const id = options.id ?? randomUUID()
    const meta: SessionMeta = {
      id,
      title: options.title ?? 'New session',
      model: options.model,
      provider: options.provider,
      mode: options.mode,
      kind: options.kind,
      parentId: options.parentId,
      workspace: options.workspace,
      permission: options.permission,
      profile: options.profile,
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(id, { meta, events: [] })
    this.views.set(id, this.buildView(id))
    this.ctx.emit('session/created', meta)
    // The title must be an event, otherwise a restart would restore the default.
    if (options.title && options.title !== 'New session') this.append(id, 'session/title', { title: options.title })
    if (options.model || options.provider || options.mode || options.kind || options.parentId || options.workspace || options.permission || options.profile) {
      this.append(id, 'session/meta', {
        model: options.model,
        provider: options.provider,
        mode: options.mode,
        kind: options.kind,
        parentId: options.parentId,
        workspace: options.workspace,
        permission: options.permission,
        profile: options.profile,
      })
    }
    return this.records.get(id)!.meta
  }

  /** Load a persisted session without emitting or re-persisting its events. */
  restore(meta: SessionMeta, events: SessionEvent[]) {
    const record: SessionRecord = { meta: { ...meta }, events: [] }
    this.records.set(meta.id, record)
    for (const event of events) {
      record.events.push(event)
      this.applyMeta(record.meta, event)
    }
    if (events.length) record.meta.updatedAt = events.at(-1)!.ts
    this.views.set(meta.id, this.buildView(meta.id))
  }

  append<T>(id: string, type: string, data: T, options?: { visibility?: EventVisibility }): SessionEvent<T> {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    const event: SessionEvent<T> = {
      seq: record.events.length,
      ts: Date.now(),
      type,
      data,
      visibility: options?.visibility ?? inferVisibility(type),
    }
    record.events.push(event)
    record.meta.updatedAt = event.ts
    this.applyMeta(record.meta, event)
    this.applyProjections(id, event)
    this.ctx.emit('session/event', id, event)
    this.ctx.emit('session/updated', record.meta)
    // Report projection failures only after the event is fully applied, and
    // never for the failure event itself: a broken projection must not loop.
    if (event.type !== 'projection/error') this.flushProjectionFailures(id)
    return event
  }

  rename(id: string, title: string) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    if (record.meta.title === title) return
    this.append(id, 'session/title', { title })
  }

  setMode(id: string, mode: string) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    if (record.meta.mode === mode) return
    this.append(id, 'session/meta', { mode })
  }

  setArchived(id: string, archived: boolean) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    if (Boolean(record.meta.archived) === archived) return
    this.append(id, 'session/meta', { archived })
  }

  setPermission(id: string, permission: string) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    if (record.meta.permission === permission) return
    this.append(id, 'session/meta', { permission })
  }

  setProfile(id: string, profile: string) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    if (record.meta.profile === profile) return
    this.append(id, 'session/meta', { profile })
  }

  setModel(id: string, provider: string, model: string) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    if (record.meta.provider === provider && record.meta.model === model) return
    this.append(id, 'session/meta', { provider, model })
  }

  /**
   * Copy a session's log into a new session.
   *
   * Title/meta events are skipped because the fork itself owns them, and
   * compaction summaries are dropped because their `upToSeq` points into the
   * source log; the fork keeps the full history instead.
   */
  fork(id: string, options: ForkOptions = {}): SessionMeta {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown session: ${id}`)
    const upToSeq = options.upToSeq ?? Number.POSITIVE_INFINITY
    const title = options.title?.trim() || `${record.meta.title} (fork)`
    const meta = this.create({
      title,
      model: record.meta.model,
      provider: record.meta.provider,
      mode: record.meta.mode,
      workspace: record.meta.workspace,
      permission: record.meta.permission,
      profile: record.meta.profile,
    })

    for (const event of record.events) {
      if (event.seq > upToSeq) break
      if (event.type === 'session/title' || event.type === 'session/meta' || event.type === 'context/summary') continue
      this.append(meta.id, event.type, structuredClone(event.data))
    }
    return this.records.get(meta.id)!.meta
  }

  remove(id: string) {
    if (!this.records.delete(id)) return
    this.views.delete(id)
    this.ctx.emit('session/removed', id)
  }

  view<T = SessionView>(id: string): T | undefined {
    return this.views.get(id) as T | undefined
  }

  /** Register a derived view; runs immediately for every existing session. */
  registerProjection(key: string, definition: ProjectionDefinition): () => void {
    if (this.projections.has(key)) throw new Error(`projection "${key}" is already registered`)
    this.projections.set(key, definition)
    for (const id of this.records.keys()) {
      const view = this.views.get(id) ?? {}
      view[key] = this.replay(id, key, definition)
      this.views.set(id, view)
    }
    return () => {
      if (this.projections.get(key) !== definition) return
      this.projections.delete(key)
      for (const view of this.views.values()) delete view[key]
    }
  }

  private replay(id: string, key: string, definition: ProjectionDefinition) {
    const record = this.records.get(id)
    if (!record) return definition.init()
    let state = definition.init()
    for (const event of record.events) state = definition.apply(state, event)
    return state
  }

  private buildView(id: string): SessionView {
    const view: SessionView = {}
    for (const [key, definition] of this.projections) view[key] = this.replay(id, key, definition)
    return view
  }

  private applyProjections(id: string, event: SessionEvent) {
    let view = this.views.get(id)
    if (!view) {
      view = {}
      this.views.set(id, view)
    }
    for (const [key, definition] of this.projections) {
      try {
        view[key] = definition.apply((view[key] ?? definition.init()) as never, event)
      } catch (error) {
        // The event is already a fact; the view is a derivative. Keep the last
        // good value and report the failure instead of failing the append.
        this.projectionFailures.push({
          key,
          seq: event.seq,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  /** Append one `projection/error` per failed projection, capped per event. */
  private flushProjectionFailures(sessionId: string) {
    if (!this.projectionFailures.length) return
    const failures = this.projectionFailures.splice(0, 5)
    for (const failure of failures) {
      this.append(sessionId, 'projection/error', { ...failure, at: Date.now() })
    }
  }

  private applyMeta(meta: SessionMeta, event: SessionEvent) {
    if (event.type === 'session/title') meta.title = event.data.title
    if (event.type === 'session/meta') {
      meta.model = event.data.model ?? meta.model
      meta.provider = event.data.provider ?? meta.provider
      meta.mode = event.data.mode ?? meta.mode
      meta.kind = event.data.kind ?? meta.kind
      meta.parentId = event.data.parentId ?? meta.parentId
      meta.workspace = event.data.workspace ?? meta.workspace
      meta.archived = event.data.archived ?? meta.archived
      meta.permission = event.data.permission ?? meta.permission
      meta.profile = event.data.profile ?? meta.profile
    }
  }
}

export default SessionService

export const meta = {
  title: '会话服务',
  description: '以事件日志保存会话状态。',
}

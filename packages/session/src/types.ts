/** One durable fact in a session's append-only log. */
export interface SessionEvent<T = any> {
  /** Contiguous index within the session; equals the log length before append. */
  seq: number
  ts: number
  type: string
  data: T
}

export interface SessionMeta {
  id: string
  title: string
  model?: string
  provider?: string
  createdAt: number
  updatedAt: number
}

export interface SessionRecord {
  meta: SessionMeta
  events: SessionEvent[]
}

export interface ProjectionDefinition<S = any> {
  init: () => S
  apply: (state: S, event: SessionEvent) => S
}

export type SessionView = Record<string, unknown>

/** Events understood by the session service itself; plugins may append anything. */
export interface SessionEventMap {
  'session/title': { title: string }
  'session/meta': { model?: string; provider?: string }
}

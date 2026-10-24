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
  /** Agent mode id active for this session. */
  mode?: string
  /** `subagent` sessions stay out of the user-facing session list. */
  kind?: string
  /** Parent session for a sub-agent run. */
  parentId?: string
  /** Absolute workspace root that tools and file APIs resolve against. */
  workspace?: string
  /** Hidden from the default session list, restorable from the archive view. */
  archived?: boolean
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
  'session/meta': {
    model?: string
    provider?: string
    mode?: string
    kind?: string
    parentId?: string
    workspace?: string
    archived?: boolean
  }
}

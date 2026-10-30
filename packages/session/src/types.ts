/** Who may see this fact outside the harness process. */
export type EventVisibility = 'client' | 'internal' | 'secret'

/** One durable fact in a session's append-only log. */
export interface SessionEvent<T = any> {
  /** Contiguous index within the session; equals the log length before append. */
  seq: number
  ts: number
  type: string
  data: T
  /**
   * Who may see this event when it leaves the harness (export, handoff, audit).
   * Missing means "infer from type"; see `inferVisibility`.
   */
  visibility?: EventVisibility
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
  /** Permission preset id enforced for this session's tool calls. */
  permission?: string
  /** Environment profile id snapshotted at creation; see settings.profiles. */
  profile?: string
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
    permission?: string
    profile?: string
  }
}

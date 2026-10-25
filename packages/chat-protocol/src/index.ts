/**
 * Wire types shared by the chat service and the browser app.
 *
 * Kept dependency-free so both sides can import it without pulling the
 * framework (server) or DOM types (client) into each other's program.
 */

export type ChatRole = 'user' | 'assistant' | 'tool'

export interface TextBlock {
  type: 'text'
  text: string
}

/** Provider-reported chain of thought, shown folded above the answer. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ToolBlock {
  type: 'tool'
  /** Correlates the block with the model's tool call and its later result. */
  callId?: string
  name: string
  input: string
  output: string
  isError?: boolean
}

export interface AttachmentMeta {
  id: string
  kind: 'image' | 'file'
  name: string
  mime: string
  /** Decoded byte length. */
  size: number
  /** Images: base64 without the `data:` prefix. */
  data?: string
  /** Text files: decoded UTF-8 content. */
  text?: string
  /** Workspace-relative path when the attachment came from an `@` reference. */
  path?: string
}

export interface AttachmentBlock {
  type: 'attachment'
  attachment: AttachmentMeta
}

export type ChatBlock = TextBlock | ReasoningBlock | ToolBlock | AttachmentBlock

export interface ChatMessage {
  id: string
  role: ChatRole
  blocks: ChatBlock[]
  status: 'streaming' | 'done'
  createdAt: number
}

export interface ChatSession {
  id: string
  title: string
  model: string
  /** Provider id selected for this session. */
  provider?: string
  /** Active agent mode id. */
  mode?: string
  /** Enforced permission preset; absent means the settings default. */
  permission?: string
  /** Absolute workspace root for this conversation. */
  workspace?: string
  /** Hidden from the default session list. */
  archived?: boolean
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  streaming: boolean
  /** Metrics for the most recent turn; not persisted. */
  stats?: TurnStats
}

export interface SessionSummary {
  id: string
  title: string
  model: string
  provider?: string
  mode?: string
  permission?: string
  workspace?: string
  archived?: boolean
  updatedAt: number
  messageCount: number
  streaming: boolean
}

/** Ephemeral metrics for the most recent turn. */
export interface TurnStats {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  /** Time from turn start to the first text delta. */
  ttftMs?: number
  /** Time between first and last text delta. */
  generationMs?: number
  durationMs?: number
  steps?: number
  outputChars?: number
}

export type ChatEvent =
  | { type: 'session-created'; session: ChatSession }
  | { type: 'session-updated'; session: ChatSession }
  | { type: 'session-deleted'; sessionId: string }
  | { type: 'message-added'; sessionId: string; message: ChatMessage }
  | { type: 'message-updated'; sessionId: string; message: ChatMessage }
  | { type: 'message-delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'message-reasoning'; sessionId: string; messageId: string; delta: string }
  | { type: 'message-block'; sessionId: string; messageId: string; block: ChatBlock }
  | { type: 'message-done'; sessionId: string; session: ChatSession }
  | { type: 'session-stats'; sessionId: string; stats: TurnStats }

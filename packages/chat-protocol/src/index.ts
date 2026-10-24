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

export interface ToolBlock {
  type: 'tool'
  /** Correlates the block with the model's tool call and its later result. */
  callId?: string
  name: string
  input: string
  output: string
  isError?: boolean
}

export type ChatBlock = TextBlock | ToolBlock

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
  /** Active agent mode id. */
  mode?: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  streaming: boolean
}

export interface SessionSummary {
  id: string
  title: string
  model: string
  mode?: string
  updatedAt: number
  messageCount: number
  streaming: boolean
}

export type ChatEvent =
  | { type: 'session-created'; session: ChatSession }
  | { type: 'session-updated'; session: ChatSession }
  | { type: 'message-added'; sessionId: string; message: ChatMessage }
  | { type: 'message-updated'; sessionId: string; message: ChatMessage }
  | { type: 'message-delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'message-block'; sessionId: string; messageId: string; block: ChatBlock }
  | { type: 'message-done'; sessionId: string; session: ChatSession }

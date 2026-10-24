/** Conversation vocabulary shared by the LLM service and provider adapters. */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool-call'
  id: string
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

export interface ToolResultPart {
  type: 'tool-result'
  callId: string
  name: string
  content: string
  isError?: boolean
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart

export interface Message {
  role: Role
  content: ContentPart[]
}

/** JSON-Schema description of a callable tool. */
export interface ToolSchema {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
}

export interface ModelRequest {
  model?: string
  messages: Message[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export type StopReason = 'stop' | 'tool-calls' | 'length' | 'aborted'

export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'done'; reason?: StopReason; usage?: Usage }
  | { type: 'error'; message: string }

/** A provider turns a model request into a chunk stream. */
export interface LlmProvider {
  name: string
  models?: string[]
  stream(request: ModelRequest): AsyncIterable<StreamChunk>
}

export function text(content: string): TextPart {
  return { type: 'text', text: content }
}

export function message(role: Role, ...parts: ContentPart[]): Message {
  return { role, content: parts }
}

export function textOf(message: Message) {
  return message.content.map(part => part.type === 'text' ? part.text : '').join('')
}

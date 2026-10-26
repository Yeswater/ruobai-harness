/** Conversation vocabulary shared by the LLM service and provider adapters. */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

/** Provider-reported chain of thought; shown to the user, never sent back. */
export interface ReasoningPart {
  type: 'reasoning'
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

/** Inline image bytes, base64 without the `data:` prefix. */
export interface ImagePart {
  type: 'image'
  mimeType: string
  data: string
  name?: string
}

/** Text file attached to a user message. */
export interface FilePart {
  type: 'file'
  name: string
  /** Workspace-relative path, when the attachment came from a file reference. */
  path?: string
  mimeType?: string
  text: string
}

export type ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | ImagePart | FilePart

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

/**
 * Token accounting for one model call.
 *
 * Counts are DISJOINT, the way provider billing works: `inputTokens` is the
 * *uncached* prompt, cache reads and cache writes are reported beside it. Billed
 * input is the sum of all three, which is what makes a hit ratio well defined.
 * Adapters whose provider folds cache hits into a single prompt count subtract
 * them out on the way in.
 */
export interface Usage {
  /** Uncached prompt tokens. */
  inputTokens?: number
  outputTokens?: number
  /** Prompt tokens served from the cache. */
  cachedInputTokens?: number
  /** Prompt tokens written to the cache (Anthropic-style providers). */
  cacheWriteInputTokens?: number
}

/**
 * How a request wants its prompt prefix cached. Adapters map this onto their
 * provider's mechanism or ignore it when caching is automatic.
 */
export interface CacheIntent {
  /** Stable routing identity for providers that bucket requests by prefix. */
  key?: string
  /** Cache only the static prefix; the tail is read once (side calls). */
  staticOnly?: boolean
  /** Preferred retention tier, when the provider offers more than one. */
  ttl?: '5m' | '1h'
}

export interface ModelRequest {
  model?: string
  messages: Message[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  cache?: CacheIntent
  signal?: AbortSignal
}

export type StopReason = 'stop' | 'tool-calls' | 'length' | 'aborted'

export type StreamChunk =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'done'; reason?: StopReason; usage?: Usage }
  | { type: 'error'; message: string; code?: string }

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

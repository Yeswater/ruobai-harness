import { Service, type Context } from '@ruobai/cordis'
import type { ToolSchema } from '@ruobai/llm'

export interface ToolRunContext {
  signal?: AbortSignal
  sessionId?: string
  /** The model's tool-call id, for correlating side effects. */
  callId?: string
  /** Absolute workspace root for this run; tools fall back to their config root. */
  workspace?: string
}

export interface ToolImage {
  /** e.g. image/png */
  mimeType: string
  /** Base64 without the data: prefix. */
  data: string
  name?: string
}

export interface ToolOutputObject {
  text: string
  /** Attached to the tool result; only models that accept images can use it. */
  images?: ToolImage[]
}

export type ToolOutput = string | ToolOutputObject

export interface ToolDefinition extends ToolSchema {
  /** Ask for human approval before executing (mutating tools). */
  requiresApproval?: boolean
  /** Tool only observes state; required for the read-only permission mode. */
  readOnly?: boolean
  /**
   * Keep the tool out of the default offered set. The agent loads it with
   * `tool_search` when the task enters that domain; a mode that names it in
   * `allowTools` / `extraTools` still sees it. Domain integrations (Forges,
   * wiki, memory, contracts) are deferred so they do not tax every step.
   */
  defer?: boolean
  /** Extra search terms for `tool_search`; never sent to the model. */
  keywords?: string[]
  /**
   * Runs alone and before the rest of its step. Use it for tools whose result
   * can change what the sibling calls should do — a question to the human, for
   * example: acting first would defeat the answer.
   */
  blocksBatch?: boolean
  /** What a persistent approval rule matches against. */
  approvalSubject?(args: any, run: ToolRunContext): { kind: 'command' | 'path'; value: string } | undefined
  /** Human-readable summary and optional diff shown in the approval card. */
  preview?(args: any, run: ToolRunContext): Promise<ToolPreview> | ToolPreview
  execute(args: any, run: ToolRunContext): Promise<ToolOutput> | ToolOutput
}

export interface ToolPreview {
  summary: string
  diff?: string
}

export interface ToolResult {
  content: string
  isError: boolean
  images?: ToolImage[]
}

export interface ToolCallInfo {
  name: string
  args: any
  sessionId?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    tools: ToolRegistry
  }

  interface Events {
    'tools/registered'(name: string): void
    'tools/removed'(name: string): void
    'tool/before'(call: ToolCallInfo): void
    'tool/after'(call: ToolCallInfo, result: ToolResult): void
  }
}

/**
 * Tool registry.
 *
 * Registration returns a disposer; the owning plugin wraps it in
 * `ctx.effect()`. Failures are returned as `isError` results rather than
 * thrown, because the agent feeds them back to the model.
 */
export class ToolRegistry extends Service {
  private readonly tools = new Map<string, ToolDefinition>()
  /** Deferred tools each session has opened with `tool_search`. */
  private readonly active = new Map<string, Set<string>>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.effect(() => ctx.on('session/removed', (id: string) => {
      this.active.delete(id)
    }), 'tools.forget-session')
  }

  /**
   * Whether the active model declares image input.
   *
   * `unknown` means the provider's model entry has no `inputTypes`; tools that
   * can attach images treat it as text-only unless configured otherwise, so a
   * text-only endpoint is not asked to parse image content.
   */
  imageSupport(sessionId?: string): 'yes' | 'no' | 'unknown' {
    // Optional lookup: this registry does not inject sessions or settings, and
    // a test or a partial composition may mount it without either.
    const sessions = this.ctx.get('sessions', false) as
      | { get?(id: string): { meta?: { provider?: string; model?: string } } | undefined }
      | undefined
    const meta = sessionId ? sessions?.get?.(sessionId)?.meta : undefined
    const settings = this.ctx.get('settings', false) as
      | { findProvider?(id: string): { models?: Array<{ id: string; inputTypes?: string[] }> } | undefined }
      | undefined
    const entry = meta?.provider ? settings?.findProvider?.(meta.provider) : undefined
    const model = entry?.models?.find(item => item.id === meta?.model)
    const types = model?.inputTypes
    if (!types?.length) return 'unknown'
    return types.includes('image') ? 'yes' : 'no'
  }

  register(definition: ToolDefinition): () => void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`)
    }
    this.tools.set(definition.name, definition)
    this.ctx.emit('tools/registered', definition.name)
    return () => {
      if (this.tools.get(definition.name) !== definition) return
      this.tools.delete(definition.name)
      this.ctx.emit('tools/removed', definition.name)
    }
  }

  get(name: string) {
    return this.tools.get(name)
  }

  has(name: string) {
    return this.tools.has(name)
  }

  list(): ToolSchema[] {
    // Tool definitions render at the front of the prompt, so their byte order
    // is part of the cache key. Registration order follows plugin load order;
    // sorting makes the rendered set independent of it.
    return [...this.tools.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
  }

  /**
   * Tool schemas offered to one request: every non-deferred tool, plus the
   * deferred tools this session opened and those its mode names explicitly.
   * `list()` still reports the full catalog for UI and diagnostics.
   */
  offered(sessionId: string | undefined, options: {
    allow?: (name: string) => boolean
    includeDeferred?: (name: string) => boolean
    deny?: string[]
  } = {}): ToolSchema[] {
    const active = sessionId ? this.active.get(sessionId) : undefined
    return [...this.tools.values()]
      .filter((tool) => {
        if (options.deny?.includes(tool.name)) return false
        if (options.allow && !options.allow(tool.name)) return false
        if (!tool.defer) return true
        return active?.has(tool.name) === true || options.includeDeferred?.(tool.name) === true
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
  }

  /**
   * Deferred tools matching a free-text query, best match first. An empty
   * query returns every deferred tool so the caller can name the groups that
   * exist. `keywords` are matched too, which is how a Chinese query finds an
   * English tool name.
   */
  searchDeferred(query: string, allow?: (name: string) => boolean): ToolDefinition[] {
    const phrase = query.trim().toLowerCase()
    const terms = phrase.split(/[^a-z0-9_]+/).filter(Boolean)
    const scored: Array<{ tool: ToolDefinition; score: number }> = []
    for (const tool of this.tools.values()) {
      if (!tool.defer) continue
      if (allow && !allow(tool.name)) continue
      const name = tool.name.toLowerCase()
      const description = (tool.description ?? '').toLowerCase()
      const keywords = (tool.keywords ?? []).map(word => word.toLowerCase())
      const group = name.split('_')[0] ?? ''
      let score = 0
      if (!phrase) score = 1
      else if (name === phrase) score = 100
      else if (name.includes(phrase)) score = 60
      else if (terms.includes(group)) score = 40
      else if (terms.some(term => name.includes(term))) score = 30
      else if (keywords.some(word => word === phrase || terms.includes(word) || word.includes(phrase))) score = 25
      else if (description.includes(phrase)) score = 20
      else if (terms.some(term => description.includes(term))) score = 10
      if (score > 0) scored.push({ tool, score })
    }
    return scored
      .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
      .map(entry => entry.tool)
  }

  /** Open deferred tools for one session; returns the names that took effect. */
  activate(sessionId: string | undefined, names: string[]): string[] {
    if (!sessionId) return []
    const active = this.active.get(sessionId) ?? new Set<string>()
    this.active.set(sessionId, active)
    const opened: string[] = []
    for (const name of names) {
      const tool = this.tools.get(name)
      if (!tool?.defer || active.has(name)) continue
      active.add(name)
      opened.push(name)
    }
    return opened
  }

  async invoke(name: string, args: any, run: ToolRunContext = {}): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { content: `unknown tool: ${name}`, isError: true }

    const call: ToolCallInfo = { name, args, sessionId: run.sessionId }

    // Configuration protection runs before policy: a permission preset must
    // not be able to re-enable writes to hook/lint files.
    const hooks = this.ctx.get('hooks', false) as
      | {
        guard(call: { name: string; args: Record<string, unknown>; sessionId?: string }):
          | { deny: true; reason: string }
          | undefined
      }
      | undefined
    if (hooks) {
      const decision = hooks.guard({
        name,
        args: (args ?? {}) as Record<string, unknown>,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      })
      if (decision) {
        const result: ToolResult = { content: decision.reason, isError: true }
        this.ctx.emit('tool/after', call, result)
        return result
      }
    }

    // Defense in depth: the agent already hides unavailable tools, but a
    // model may still emit a call for one it saw earlier in the turn.
    const permissions = this.ctx.get('permissions', false) as
      | {
        modeFor(sessionId?: string): string
        allowsTool(sessionId: string | undefined, tool: ToolDefinition): boolean
      }
      | undefined
    if (permissions && !permissions.allowsTool(run.sessionId, tool)) {
      const result: ToolResult = {
        content: `tool "${name}" is not available in ${permissions.modeFor(run.sessionId)} mode`,
        isError: true,
      }
      this.ctx.emit('tool/after', call, result)
      return result
    }

    if (tool.requiresApproval) {
      const approval = this.ctx.get('approval', false) as
        | { request(input: any, run?: { signal?: AbortSignal }): Promise<string> }
        | undefined
      if (!approval) {
        const result: ToolResult = {
          content: 'This operation requires an approval service, which is not loaded.',
          isError: true,
        }
        this.ctx.emit('tool/after', call, result)
        return result
      }

      let preview: ToolPreview
      try {
        preview = tool.preview ? await tool.preview(args, run) : { summary: name }
      } catch (error) {
        preview = { summary: `${name}: ${error instanceof Error ? error.message : String(error)}` }
      }

      let subject: { kind: 'command' | 'path'; value: string } | undefined
      if (tool.approvalSubject) {
        try {
          subject = tool.approvalSubject(args, run)
        } catch {
          // An unusable argument cannot match a persistent rule; ask instead.
          subject = undefined
        }
      }

      const decision = await approval.request({
        sessionId: run.sessionId ?? '',
        tool: name,
        args,
        subject,
        ...preview,
      }, { signal: run.signal })
      if (decision === 'deny') {
        const result: ToolResult = { content: 'The operation was denied by the approval policy.', isError: true }
        this.ctx.emit('tool/after', call, result)
        return result
      }
    }

    this.ctx.emit('tool/before', call)
    try {
      const value = await tool.execute(args, run)
      const output: ToolOutputObject = typeof value === 'string' ? { text: value } : value
      const result: ToolResult = {
        content: output.text,
        isError: false,
        ...(output.images?.length ? { images: output.images } : {}),
      }
      this.ctx.emit('tool/after', call, result)
      return result
    } catch (error) {
      const result: ToolResult = {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
      this.ctx.emit('tool/after', call, result)
      return result
    }
  }
}

export default ToolRegistry

export const meta = {
  title: '工具注册表',
  description: '注册并执行模型可调用的工具。',
}

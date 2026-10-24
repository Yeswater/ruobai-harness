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

export interface ToolDefinition extends ToolSchema {
  /** Ask for human approval before executing (mutating tools). */
  requiresApproval?: boolean
  /** What a persistent approval rule matches against. */
  approvalSubject?(args: any, run: ToolRunContext): { kind: 'command' | 'path'; value: string } | undefined
  /** Human-readable summary and optional diff shown in the approval card. */
  preview?(args: any, run: ToolRunContext): Promise<ToolPreview> | ToolPreview
  execute(args: any, run: ToolRunContext): Promise<string> | string
}

export interface ToolPreview {
  summary: string
  diff?: string
}

export interface ToolResult {
  content: string
  isError: boolean
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

  constructor(ctx: Context) {
    super(ctx, 'tools')
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
    return [...this.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  async invoke(name: string, args: any, run: ToolRunContext = {}): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { content: `unknown tool: ${name}`, isError: true }

    const call: ToolCallInfo = { name, args, sessionId: run.sessionId }

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
      const result: ToolResult = {
        content: typeof value === 'string' ? value : JSON.stringify(value),
        isError: false,
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

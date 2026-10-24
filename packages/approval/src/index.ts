import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@ruobai/cordis'

export type ApprovalDecision = 'allow' | 'always' | 'deny'

export interface ApprovalPreview {
  summary: string
  diff?: string
}

export interface ApprovalRequest extends ApprovalPreview {
  id: string
  sessionId: string
  tool: string
  args: unknown
  createdAt: number
}

export interface ApprovalResolution {
  id: string
  decision: ApprovalDecision
  request: ApprovalRequest
}

declare module '@ruobai/cordis' {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    'approval/requested'(request: ApprovalRequest): void
    'approval/resolved'(resolution: ApprovalResolution): void
  }
}

export interface ApprovalRequestInput extends ApprovalPreview {
  sessionId: string
  tool: string
  args: unknown
}

/**
 * Blocks mutating tool calls until a human (or a bypass setting) decides.
 *
 * Decisions default to deny when the turn is aborted or the service unloads.
 * "always" is scoped to one session + tool for the process lifetime.
 */
export class ApprovalService extends Service {
  private readonly pending = new Map<string, { request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void }>()
  private readonly always = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'approval')
    ctx.effect(() => () => this.denyAll(), 'approval.dispose')
  }

  /** True when settings opt out of approvals entirely. */
  bypassed() {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { bypassApprovals?: boolean } } }
      | undefined
    return Boolean(settings?.raw().agent?.bypassApprovals)
  }

  list(sessionId?: string) {
    return [...this.pending.values()]
      .map(entry => entry.request)
      .filter(request => !sessionId || request.sessionId === sessionId)
  }

  async request(input: ApprovalRequestInput, run: { signal?: AbortSignal } = {}): Promise<ApprovalDecision> {
    if (this.bypassed()) return 'allow'
    const key = `${input.sessionId}:${input.tool}`
    if (this.always.has(key)) return 'allow'

    const request: ApprovalRequest = {
      id: randomUUID(),
      createdAt: Date.now(),
      ...input,
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      run.signal?.addEventListener('abort', () => {
        if (this.pending.has(request.id)) this.resolve(request.id, 'deny')
      }, { once: true })
      this.ctx.emit('approval/requested', request)
    })

    return decision
  }

  resolve(id: string, decision: ApprovalDecision) {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (decision === 'always') {
      this.always.add(`${entry.request.sessionId}:${entry.request.tool}`)
    }
    this.ctx.emit('approval/resolved', { id, decision, request: entry.request })
    entry.resolve(decision)
    return true
  }

  denyAll(sessionId?: string) {
    for (const request of this.list(sessionId)) this.resolve(request.id, 'deny')
  }
}

export default ApprovalService

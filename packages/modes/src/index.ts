import { Service, type Context } from '@ruobai/cordis'

export interface ModeDefinition {
  id: string
  name: string
  description?: string
  order?: number
  /** Extra instructions appended to the system prompt. */
  systemPrompt?: string
  /** If set, only these tools are offered (plus `extraTools`). */
  allowTools?: string[]
  denyTools?: string[]
  /** Tools from this list are offered regardless of `allowTools`. */
  extraTools?: string[]
  /** Keep running after a text-only step until a tool marks completion. */
  autonomous?: boolean
}

export interface ModeInfo {
  id: string
  name: string
  description?: string
  order?: number
  autonomous?: boolean
}

declare module '@ruobai/cordis' {
  interface Context {
    modes: ModeService
  }

  interface Events {
    'modes/changed'(): void
  }
}

/**
 * Registry of agent modes. Ships no built-ins: Ask/Plan/Goal/Agent are
 * separate plugins, so removing one removes it from the UI and the runtime.
 */
export class ModeService extends Service {
  private readonly modes = new Map<string, ModeDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'modes')
  }

  register(mode: ModeDefinition): () => void {
    if (this.modes.has(mode.id)) throw new Error(`mode "${mode.id}" is already registered`)
    this.modes.set(mode.id, mode)
    this.ctx.emit('modes/changed')
    return () => {
      if (this.modes.get(mode.id) !== mode) return
      this.modes.delete(mode.id)
      this.ctx.emit('modes/changed')
    }
  }

  get(id: string | undefined): ModeDefinition | undefined {
    return id ? this.modes.get(id) : undefined
  }

  /** Sorted public metadata for the UI. */
  list(): ModeInfo[] {
    return [...this.modes.values()]
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name))
      .map(mode => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
        order: mode.order,
        autonomous: mode.autonomous,
      }))
  }

  /** Settings' default if registered, else the first registered mode. */
  defaultId(): string {
    const settings = this.ctx.get('settings', false) as
      | { raw(): { agent?: { defaultMode?: string } } }
      | undefined
    const preferred = settings?.raw().agent?.defaultMode
    if (preferred && this.modes.has(preferred)) return preferred
    return this.list()[0]?.id ?? 'agent'
  }

  /** Whether a tool may be offered/executed in this mode. */
  allows(modeId: string | undefined, tool: string): boolean {
    const mode = this.get(modeId)
    if (!mode) return true
    const extra = mode.extraTools ?? []
    if (mode.allowTools && !mode.allowTools.includes(tool) && !extra.includes(tool)) return false
    if (mode.denyTools?.includes(tool)) return false
    return true
  }
}

export default ModeService

export const meta = {
  title: '模式注册表',
  description: '管理 Ask、Plan、Agent、Goal 等模式。',
}

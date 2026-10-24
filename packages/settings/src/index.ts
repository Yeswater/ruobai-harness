import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'

export interface ProviderModel {
  id: string
}

export type ProviderMode = 'direct' | 'mapping'

export interface ProviderEntry {
  /** Stable identifier referenced by sessions. */
  id: string
  name: string
  note?: string
  website?: string
  baseUrl: string
  /** Write-only: never leaves the process through `get()`. */
  apiKey?: string
  mode: ProviderMode
  models: ProviderModel[]
}

export interface ProviderInput {
  id?: string
  name?: string
  note?: string
  website?: string
  baseUrl?: string
  apiKey?: string
  mode?: ProviderMode
  models?: Array<ProviderModel | string>
}

export interface LlmSettings {
  activeProvider?: string
  activeModel?: string
  providers?: ProviderEntry[]
  /** Legacy single-provider fields, migrated on startup. */
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
}

export interface UiSettings {
  theme?: 'light' | 'dark'
}

export interface AgentSettings {
  /** Mode used for new sessions. */
  defaultMode?: string
  /** Skip write approvals entirely. Dangerous; surfaced in settings as bypass. */
  bypassApprovals?: boolean
  /** Estimated-token threshold that triggers LLM summarization. */
  compactAt?: number
}

export interface SettingsData {
  llm?: LlmSettings
  ui?: UiSettings
  agent?: AgentSettings
}

export interface PublicProvider {
  id: string
  name: string
  note?: string
  website?: string
  baseUrl: string
  mode: ProviderMode
  models: ProviderModel[]
  hasApiKey: boolean
}

export interface PublicSettings {
  llm?: {
    activeProvider?: string
    activeModel?: string
    providers: PublicProvider[]
  }
  ui?: UiSettings
  agent?: AgentSettings
}

export interface Config {
  path?: string
}

export class SettingsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

declare module '@ruobai/cordis' {
  interface Context {
    settings: SettingsService
  }

  interface Events {
    'settings/updated'(settings: PublicSettings): void
  }
}

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'

/** JSON-file settings with write-only secrets and provider CRUD. */
export class SettingsService extends Service {
  static Config: z<Config> = z.object({
    path: z.string().default('.ruobai/settings.json'),
  })

  readonly path: string
  private data: SettingsData = {}
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'settings')
    this.path = resolve(config.path ?? '.ruobai/settings.json')
  }

  async *[Service.init]() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger('settings').warn(error)
      }
    }

    if (this.migrate()) await this.persist()
    yield () => undefined
  }

  raw(): SettingsData {
    return structuredClone(this.data)
  }

  rawProviders(): ProviderEntry[] {
    return structuredClone(this.data.llm?.providers ?? [])
  }

  findProvider(id: string): ProviderEntry | undefined {
    return this.data.llm?.providers?.find(entry => entry.id === id)
  }

  /** Effective key: stored value, then environment fallbacks. */
  apiKeyFor(id: string): string | undefined {
    const entry = this.findProvider(id)
    return entry?.apiKey
      || process.env.RBU_API_KEY
      || (entry?.baseUrl?.includes('deepseek') || id === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined)
  }

  get(): PublicSettings {
    const llm = this.data.llm
    const result: PublicSettings = {}
    if (llm) {
      result.llm = {
        activeProvider: llm.activeProvider,
        activeModel: llm.activeModel,
        providers: (llm.providers ?? []).map(entry => this.publicProvider(entry)),
      }
    }
    if (this.data.ui) result.ui = { ...this.data.ui }
    if (this.data.agent) result.agent = { ...this.data.agent }
    return result
  }

  publicProvider(entry: ProviderEntry): PublicProvider {
    const { apiKey, ...rest } = entry
    return { ...rest, hasApiKey: Boolean(this.apiKeyFor(entry.id)) }
  }

  async update(patch: { llm?: { activeProvider?: string; activeModel?: string }; ui?: UiSettings; agent?: AgentSettings }): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    if (patch.llm?.activeProvider !== undefined) llm.activeProvider = patch.llm.activeProvider || 'mock'
    if (patch.llm?.activeModel !== undefined) llm.activeModel = patch.llm.activeModel || undefined
    if (patch.ui) this.data.ui = { ...this.data.ui, ...patch.ui }
    if (patch.agent) {
      const agent = this.data.agent ??= {}
      if (patch.agent.defaultMode !== undefined) agent.defaultMode = patch.agent.defaultMode || undefined
      if (patch.agent.bypassApprovals !== undefined) agent.bypassApprovals = Boolean(patch.agent.bypassApprovals)
      if (patch.agent.compactAt !== undefined) agent.compactAt = Math.max(1000, Number(patch.agent.compactAt) || 0) || undefined
    }
    return this.commit()
  }

  async upsertProvider(input: ProviderInput, id?: string): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    const providers = llm.providers ??= []

    const targetId = (id ?? input.id)?.trim() || this.uniqueId(slug(input.name || 'provider'))
    const existing = providers.find(entry => entry.id === targetId)
    const name = (input.name ?? existing?.name ?? targetId).trim()
    if (!name) throw new SettingsError(400, 'provider name is required')

    const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl)
    const models = normalizeModels(input.models ?? existing?.models)
    const mode = input.mode ?? existing?.mode ?? 'direct'
    if (mode !== 'direct' && mode !== 'mapping') throw new SettingsError(400, 'invalid provider mode')

    const entry: ProviderEntry = {
      id: targetId,
      name,
      baseUrl,
      mode,
      models,
      ...(input.note !== undefined ? { note: input.note } : existing?.note ? { note: existing.note } : {}),
      ...(input.website !== undefined ? { website: input.website } : existing?.website ? { website: existing.website } : {}),
      ...(input.apiKey === undefined
        ? existing?.apiKey ? { apiKey: existing.apiKey } : {}
        : input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}),
    }

    const index = providers.findIndex(item => item.id === targetId)
    if (index >= 0) providers[index] = entry
    else providers.push(entry)

    if (!llm.activeProvider || llm.activeProvider === 'mock') {
      llm.activeProvider = targetId
      llm.activeModel = models[0]?.id
    } else if (llm.activeProvider === targetId && (!llm.activeModel || !models.some(model => model.id === llm.activeModel))) {
      llm.activeModel = models[0]?.id
    }

    return this.commit()
  }

  async removeProvider(id: string): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    llm.providers = (llm.providers ?? []).filter(entry => entry.id !== id)
    if (llm.activeProvider === id) {
      const next = llm.providers[0]
      llm.activeProvider = next?.id ?? 'mock'
      llm.activeModel = next?.models[0]?.id
    }
    return this.commit()
  }

  async activate(providerId: string, model?: string): Promise<PublicSettings> {
    const llm = this.data.llm ??= {}
    if (providerId === 'mock') {
      llm.activeProvider = 'mock'
      llm.activeModel = model || 'mock-1'
      return this.commit()
    }

    const entry = this.findProvider(providerId)
    if (!entry) throw new SettingsError(404, `unknown provider: ${providerId}`)
    const selected = model?.trim() || entry.models[0]?.id
    if (model?.trim() && !entry.models.some(item => item.id === model.trim())) {
      throw new SettingsError(400, `model "${model}" is not in provider "${providerId}"`)
    }
    llm.activeProvider = providerId
    llm.activeModel = selected
    return this.commit()
  }

  flush() {
    return this.queue
  }

  private async commit() {
    const snapshot = this.get()
    this.queue = this.queue
      .then(() => this.persist())
      .catch(error => this.ctx.logger('settings').error(error))
    this.ctx.emit('settings/updated', snapshot)
    await this.queue
    return snapshot
  }

  private async persist() {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.data, null, 2) + '\n')
    await rename(temp, this.path)
  }

  /** Seed defaults or convert the legacy single-provider shape. Returns true if changed. */
  private migrate() {
    const llm = this.data.llm ??= {}
    let changed = false

    if (!llm.providers?.length) {
      if (llm.provider || llm.model || llm.baseUrl || llm.apiKey) {
        const model = llm.model?.trim()
        const id = this.uniqueId(slug(llm.provider || 'provider'))
        llm.providers = [{
          id,
          name: llm.provider || 'Provider',
          baseUrl: llm.baseUrl?.trim()
            || (model?.toLowerCase().includes('deepseek') ? DEEPSEEK_BASE : 'https://api.openai.com/v1'),
          mode: 'direct',
          models: model ? [{ id: model }] : [],
          ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
        }]
        llm.activeProvider = id
        llm.activeModel = model
      } else {
        llm.providers = [{
          id: 'deepseek',
          name: 'DeepSeek',
          website: 'https://platform.deepseek.com',
          baseUrl: process.env.RBU_BASE_URL ?? DEEPSEEK_BASE,
          mode: 'direct',
          models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
        }]
        llm.activeProvider = process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'mock'
        llm.activeModel = process.env.DEEPSEEK_API_KEY ? 'deepseek-chat' : undefined
      }
      changed = true
    }

    for (const key of ['provider', 'model', 'baseUrl', 'apiKey'] as const) {
      if (key in llm) {
        delete llm[key]
        changed = true
      }
    }
    if (!llm.activeProvider) {
      llm.activeProvider = 'mock'
      changed = true
    }

    if (!this.data.agent) {
      this.data.agent = { defaultMode: 'agent', bypassApprovals: false, compactAt: 48_000 }
      changed = true
    }
    return changed
  }

  private uniqueId(base: string) {
    const providers = this.data.llm?.providers ?? []
    let id = base || 'provider'
    let index = 2
    while (providers.some(entry => entry.id === id)) id = `${base}-${index++}`
    return id
  }
}

function slug(value: string) {
  const slugged = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slugged || 'provider'
}

function normalizeBaseUrl(value: string | undefined) {
  const url = value?.trim().replace(/\/+$/, '')
  if (!url) throw new SettingsError(400, 'base URL is required')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SettingsError(400, `invalid base URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingsError(400, 'base URL must be http(s)')
  }
  return url
}

function normalizeModels(models: Array<ProviderModel | string> | undefined): ProviderModel[] {
  const seen = new Set<string>()
  const result: ProviderModel[] = []
  for (const item of models ?? []) {
    const id = typeof item === 'string' ? item : item?.id
    if (typeof id !== 'string') continue
    const value = id.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push({ id: value })
  }
  return result
}

export default SettingsService

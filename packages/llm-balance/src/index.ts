import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { balanceApiFor, type BalanceApi } from '@ruobai/provider-catalog'
import type { SettingsService } from '@ruobai/settings'
import type { SessionService } from '@ruobai/session'
import { BalanceError, queryBalance, type ProviderBalance } from './balances.ts'

export type * from './balances.ts'

export interface ProviderOverview {
  id: string
  name: string
  preset?: string
  active: boolean
  hasKey: boolean
  modelCount: number
  state: 'ok' | 'no-key' | 'unsupported' | 'error'
  balance?: ProviderBalance
  message?: string
}

export interface UsageToday {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  /** All four counters added up. */
  totalTokens: number
  /** Assistant steps that reported usage. */
  calls: number
}

export interface LlmOverview {
  providers: ProviderOverview[]
  usage: UsageToday
  updatedAt: number
}

export interface Config {
  /** How long one provider's balance is reused. */
  refreshMs?: number
  /** Cache for the today-token scan, which walks every session's events. */
  usageRefreshMs?: number
}

declare module '@ruobai/cordis' {
  interface Context {
    llmBalance: LlmBalanceService
  }
}

interface CacheEntry {
  at: number
  value: ProviderOverview
}

/**
 * Account balance and today's token usage for the configured providers.
 *
 * Balance is vendor-specific and optional: only the vendors in the catalog
 * with a documented endpoint are queried, everything else reports why it has
 * no figure instead of guessing one.
 */
export class LlmBalanceService extends Service {
  static inject = ['settings', 'sessions']

  static Config: z<Config> = z.object({
    refreshMs: z.number().default(300_000),
    usageRefreshMs: z.number().default(15_000),
  })

  private readonly cache = new Map<string, CacheEntry>()
  private usageCache?: { at: number; value: UsageToday }

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'llmBalance')
  }

  async overview(force = false): Promise<LlmOverview> {
    const settings = this.ctx.settings
    const active = settings.get().llm?.activeProvider
    const providers = await Promise.all(settings.rawProviders().map(entry => this.providerView(entry.id, active, force)))
    return {
      providers,
      usage: this.usageToday(force),
      updatedAt: Date.now(),
    }
  }

  private async providerView(id: string, active: string | undefined, force: boolean): Promise<ProviderOverview> {
    const settings = this.ctx.settings
    const entry = settings.findProvider(id)
    if (!entry) {
      return { id, name: id, active: false, hasKey: false, modelCount: 0, state: 'unsupported' }
    }

    const hasKey = Boolean(settings.apiKeyFor(id))
    const base: ProviderOverview = {
      id,
      name: entry.name,
      ...(entry.preset ? { preset: entry.preset } : {}),
      active: id === active,
      hasKey,
      modelCount: entry.models.length,
      state: 'unsupported',
    }

    const api: BalanceApi | undefined = balanceApiFor(entry.preset, entry.baseUrl)
    if (!api) return { ...base, state: 'unsupported' }
    if (!hasKey) return { ...base, state: 'no-key' }

    const cached = this.cache.get(id)
    if (!force && cached && Date.now() - cached.at < (this.config.refreshMs ?? 300_000)) return cached.value

    let value: ProviderOverview
    try {
      const balance = await queryBalance(api, entry.baseUrl, settings.apiKeyFor(id)!)
      value = { ...base, state: 'ok', balance }
    } catch (error) {
      value = {
        ...base,
        state: 'error',
        message: error instanceof BalanceError ? error.message : `余额查询失败：${String(error)}`,
      }
    }
    this.cache.set(id, { at: Date.now(), value })
    return value
  }

  private usageToday(force: boolean): UsageToday {
    const ttl = this.config.usageRefreshMs ?? 15_000
    if (!force && this.usageCache && Date.now() - this.usageCache.at < ttl) return this.usageCache.value

    const start = startOfToday()
    const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, calls: 0 }
    for (const meta of this.ctx.sessions.list()) {
      // Sessions untouched since midnight cannot hold today's usage.
      if (meta.updatedAt < start) continue
      const record = this.ctx.sessions.get(meta.id)
      if (!record) continue
      for (const event of record.events) {
        if (event.ts < start) continue
        if (event.type !== 'message/assistant') continue
        const usage = event.data?.usage
        if (!usage) continue
        totals.calls += 1
        totals.inputTokens += Number(usage.inputTokens ?? 0)
        totals.outputTokens += Number(usage.outputTokens ?? 0)
        totals.cachedInputTokens += Number(usage.cachedInputTokens ?? 0)
        totals.cacheWriteInputTokens += Number(usage.cacheWriteInputTokens ?? 0)
      }
    }

    const value: UsageToday = {
      ...totals,
      totalTokens: totals.inputTokens + totals.outputTokens + totals.cachedInputTokens + totals.cacheWriteInputTokens,
    }
    this.usageCache = { at: Date.now(), value }
    return value
  }
}

function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export default LlmBalanceService

export const meta = {
  title: '模型余额',
  description: '查询供应商余额并汇总今日 token 用量。',
}

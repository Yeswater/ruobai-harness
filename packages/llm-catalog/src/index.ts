import type { Context } from '@ruobai/cordis'
import { OpenAiProvider } from '@ruobai/llm-openai'
import type {} from '@ruobai/settings'

export const name = 'llm-catalog'
export const inject = ['llm', 'settings']

/**
 * Keeps `ctx.llm` in sync with the provider entries stored in settings.
 *
 * Every configured provider is registered as an OpenAI-compatible adapter
 * under its stable id; base URL, key and default model are resolved from
 * settings at call time, so edits need no re-registration. Adding or
 * removing a provider updates the registry immediately.
 */
export function apply(ctx: Context) {
  const registered = new Map<string, () => void>()

  const sync = () => {
    const providers = ctx.settings.rawProviders()
    const desired = new Map(providers.map(entry => [entry.id, entry]))

    for (const [id, off] of registered) {
      if (desired.has(id)) continue
      off()
      registered.delete(id)
    }

    for (const entry of providers) {
      if (registered.has(entry.id) || entry.id === 'mock') continue
      if (ctx.llm.get(entry.id)) continue

      const provider = new OpenAiProvider(
        {
          name: entry.id,
          baseUrl: entry.baseUrl,
          apiKey: ctx.settings.apiKeyFor(entry.id),
          model: entry.models[0]?.id,
          timeoutMs: 180_000,
        },
        () => {
          const current = ctx.settings.findProvider(entry.id)
          if (!current) return {}
          return {
            baseUrl: current.baseUrl,
            apiKey: ctx.settings.apiKeyFor(entry.id),
            model: current.models[0]?.id,
          }
        },
      )

      registered.set(entry.id, ctx.llm.register(provider))
    }
  }

  ctx.effect(() => () => {
    for (const off of registered.values()) off()
    registered.clear()
  }, 'llm-catalog.dispose')

  sync()
  ctx.on('settings/updated', sync)
}

export default { name, inject, apply }

export const meta = {
  title: '模型目录',
  description: '把设置中的供应商注册为模型适配器。',
}

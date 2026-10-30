import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import { builtinDangerRules } from '@ruobai/approval'
import type { CommandPrefix, PermissionMode, ProviderEntry, ProviderInput } from '@ruobai/settings'
import { modelsFromPayload, presetById, PROVIDER_PRESETS } from '@ruobai/provider-catalog'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'settings-web'
export const inject = ['web', 'settings']

/** Provider management + settings API. Secrets never leave the server. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/settings',
    handler: (req, res, url) => handleSettings(ctx, req, res, url),
  }), 'settings-web.settings')

  ctx.effect(() => ctx.web.register({
    prefix: '/api/providers',
    handler: (req, res, url) => handleProviders(ctx, req, res, url),
  }), 'settings-web.providers')

  ctx.effect(() => ctx.web.register({
    prefix: '/api/approval',
    handler: (req, res, url) => handleApproval(ctx, req, res, url),
  }), 'settings-web.approval')
}

export default { name, inject, apply }

async function handleSettings(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    if (url.pathname !== '/api/settings') throw new HttpError(404, 'not found')
    if (req.method === 'GET') {
      sendJson(res, 200, { settings: ctx.settings.get() })
      return true
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req)
      const settings = await ctx.settings.update({
        llm: body?.llm && typeof body.llm === 'object'
          ? {
              activeProvider: typeof body.llm.activeProvider === 'string' ? body.llm.activeProvider : undefined,
              activeModel: typeof body.llm.activeModel === 'string' ? body.llm.activeModel : undefined,
            }
          : undefined,
        ui: body?.ui && typeof body.ui === 'object' && (body.ui.theme === 'light' || body.ui.theme === 'dark')
          ? { theme: body.ui.theme }
          : undefined,
        agent: body?.agent && typeof body.agent === 'object'
          ? {
              defaultMode: typeof body.agent.defaultMode === 'string' ? body.agent.defaultMode : undefined,
              defaultPermission: normalizeDefaultPermission(body.agent.defaultPermission),
              commandPrefix: normalizeCommandPrefix(body.agent.commandPrefix),
              compactPercent: normalizeCompactPercent(body.agent.compactPercent),
              bypassApprovals: typeof body.agent.bypassApprovals === 'boolean' ? body.agent.bypassApprovals : undefined,
              compactAt: typeof body.agent.compactAt === 'number' ? body.agent.compactAt : undefined,
            }
          : undefined,
        profiles: Array.isArray(body?.profiles) ? normalizeProfiles(body.profiles) : undefined,
        activeProfile: typeof body?.activeProfile === 'string' ? body.activeProfile : undefined,
      })
      sendJson(res, 200, { settings })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  } catch (error) {
    fail(ctx, res, error, 'settings-web')
  }
  return true
}

/**
 * Profiles are environment labels, not a second settings tree: only the fields
 * that differ per environment are kept, and secrets stay behind `keyRef`.
 */
function normalizeProfiles(input: unknown[]) {
  return input.slice(0, 20).map((raw, index) => {
    const profile = (raw ?? {}) as Record<string, any>
    const id = typeof profile.id === 'string' ? profile.id.trim() : ''
    if (!id) throw new HttpError(400, `profile ${index + 1} needs an id`)
    const label = typeof profile.label === 'string' && profile.label.trim() ? profile.label.trim() : id
    const llm = profile.llm && typeof profile.llm === 'object'
      ? {
          ...(typeof profile.llm.provider === 'string' ? { provider: profile.llm.provider } : {}),
          ...(typeof profile.llm.baseUrl === 'string' ? { baseUrl: profile.llm.baseUrl } : {}),
          ...(typeof profile.llm.keyRef === 'string' ? { keyRef: profile.llm.keyRef } : {}),
        }
      : undefined
    const root = profile.workspace && typeof profile.workspace.root === 'string'
      ? profile.workspace.root.trim()
      : ''
    return {
      id,
      label,
      ...(llm && Object.keys(llm).length ? { llm } : {}),
      ...(root ? { workspace: { root } } : {}),
    }
  })
}

async function handleProviders(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const parts = url.pathname.split('/').filter(Boolean) // ['api','providers', id?, action?]

    if (parts.length === 2) {
      if (req.method === 'GET') {
        sendJson(res, 200, { settings: ctx.settings.get() })
        return true
      }
      if (req.method === 'POST') {
        const settings = await ctx.settings.upsertProvider(applyPreset(ctx, await readJson(req) as ProviderInput))
        sendJson(res, 201, { settings })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (parts[2] === 'presets' && parts.length === 3) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
      sendJson(res, 200, { presets: PROVIDER_PRESETS })
      return true
    }

    if (parts[2] === 'models' && parts.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = await readJson(req) as { baseUrl?: string; apiKey?: string; id?: string; preset?: string }
      const models = await fetchModels(ctx, body)
      sendJson(res, 200, { models })
      return true
    }

    const id = decodeURIComponent(parts[2] ?? '')
    if (!id) throw new HttpError(404, 'not found')

    if (parts[3] === 'activate' && parts.length === 4) {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = await readJson(req) as { model?: string }
      const settings = await ctx.settings.activate(id, typeof body.model === 'string' ? body.model : undefined)
      sendJson(res, 200, { settings })
      return true
    }

    if (parts.length === 3) {
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const settings = await ctx.settings.upsertProvider(
          applyPreset(ctx, await readJson(req) as ProviderInput, ctx.settings.findProvider(id)),
          id,
        )
        sendJson(res, 200, { settings })
        return true
      }
      if (req.method === 'DELETE') {
        const settings = await ctx.settings.removeProvider(id)
        sendJson(res, 200, { settings })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    throw new HttpError(404, 'not found')
  } catch (error) {
    fail(ctx, res, error, 'settings-web')
  }
  return true
}

/**
 * Fill an incomplete provider from its building block.
 *
 * A create may name only a preset and a key; edits keep whatever the user
 * already saved, so PATCHing just `preset` never rewrites the endpoint.
 */
function applyPreset(ctx: Context, input: ProviderInput, existing?: ProviderEntry): ProviderInput {
  const key = (input.preset ?? existing?.preset)?.trim()
  if (!key) return input
  const preset = presetById(key)
  if (!preset) throw new HttpError(400, `unknown provider preset: ${key}`)
  const next: ProviderInput = { ...input, preset: key }
  if (existing) return next

  // Connecting the same vendor twice should edit that connection, not queue a
  // duplicate beside it (the seeded DeepSeek row is exactly this case).
  const providers = ctx.settings.rawProviders()
  const same = providers.find(provider => provider.preset === key)
  if (same) next.id = same.id
  else if (!providers.some(provider => provider.id === preset.id)) next.id = preset.id

  if (!next.name?.trim()) next.name = preset.name
  if (!next.baseUrl?.trim()) next.baseUrl = preset.baseUrl
  if (!next.note) next.note = preset.note
  if (!next.website) next.website = preset.website
  if (!next.models?.length) next.models = preset.models
  return next
}

async function fetchModels(ctx: Context, body: { baseUrl?: string; apiKey?: string; id?: string; preset?: string }) {
  const entry = body.id ? ctx.settings.findProvider(body.id) : undefined
  const baseUrl = (body.baseUrl?.trim() || entry?.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) throw new HttpError(400, 'baseUrl is required')
  const key = body.apiKey?.trim() || (body.id ? ctx.settings.apiKeyFor(body.id) : undefined)
  const presetId = body.preset?.trim() || entry?.preset

  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new HttpError(502, describeNetworkError(error))
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HttpError(502, describeHttpStatus(response.status, text))
  }

  const payload: any = await response.json().catch(() => undefined)
  return modelsFromPayload(payload, presetId)
}

function describeHttpStatus(status: number, detail: string): string {
  const suffix = detail ? `：${detail.slice(0, 200)}` : ''
  if (status === 401 || status === 403) return `密钥无效或没有权限（HTTP ${status}）${suffix}`
  if (status === 404) return `请求地址可能不对，OpenAI 兼容接口通常以 /v1 结尾（HTTP 404）${suffix}`
  if (status === 429) return `被限流或额度不足（HTTP 429）${suffix}`
  if (status >= 500) return `供应商服务异常（HTTP ${status}）${suffix}`
  return `模型列表请求失败（HTTP ${status}）${suffix}`
}

function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|aborted|timed out/i.test(message)) return '连接超时：检查地址是否可达、是否需要代理'
  if (/ECONNREFUSED/i.test(message)) return '连接被拒绝：本地服务未启动，或端口不对'
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '域名解析失败：检查地址拼写与网络'
  if (/certificate|self[- ]signed/i.test(message)) return '证书校验失败：本地服务需要有效的 HTTPS 证书'
  return `连接失败：${message}`
}

async function handleApproval(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const parts = url.pathname.split('/').filter(Boolean) // ['api','approval','rules'|'guard', id?]

    if (parts.length === 3 && parts[2] === 'guard') {
      if (req.method === 'GET') {
        sendJson(res, 200, { guard: ctx.settings.approvalGuard(), builtin: builtinDangerRules() })
        return true
      }
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await readJson(req)
        await ctx.settings.updateApprovalGuard({
          enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
        })
        sendJson(res, 200, { guard: ctx.settings.approvalGuard() })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (parts[2] !== 'rules' || parts.length > 4) throw new HttpError(404, 'not found')

    if (parts.length === 3) {
      if (req.method === 'GET') {
        sendJson(res, 200, { rules: ctx.settings.approvalRules() })
        return true
      }
      if (req.method === 'POST') {
        await ctx.settings.upsertApprovalRule(await readJson(req))
        sendJson(res, 201, { rules: ctx.settings.approvalRules() })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    const id = decodeURIComponent(parts[3]!)
    if (req.method === 'PATCH' || req.method === 'PUT') {
      await ctx.settings.upsertApprovalRule(await readJson(req), id)
      sendJson(res, 200, { rules: ctx.settings.approvalRules() })
      return true
    }
    if (req.method === 'DELETE') {
      await ctx.settings.removeApprovalRule(id)
      sendJson(res, 200, { rules: ctx.settings.approvalRules() })
      return true
    }
    throw new HttpError(405, 'method not allowed')
  } catch (error) {
    fail(ctx, res, error, 'settings-web')
  }
  return true
}

function fail(ctx: Context, res: ServerResponse, error: unknown, label: string) {
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500
  if (status >= 500) ctx.logger(label).error(error)
  if (!res.headersSent) sendJson(res, status, { error: message })
}

/** Any preset may be the global default; the UI confirms `full-access` on the way in. */
function normalizeDefaultPermission(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined
  if (value === 'read-only' || value === 'workspace-write' || value === 'full-access' || value === 'auto-review') {
    return value
  }
  throw new HttpError(400, 'defaultPermission must be read-only, workspace-write, full-access or auto-review')
}

function normalizeCommandPrefix(value: unknown): CommandPrefix | undefined {
  if (value === undefined) return undefined
  if (value === '～' || value === '！' || value === '#') return value
  throw new HttpError(400, 'commandPrefix must be ～, ！ or #')
}

function normalizeCompactPercent(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const percent = Number(value)
  if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
    throw new HttpError(400, 'compactPercent must be between 1 and 100')
  }
  return Math.round(percent)
}

export const meta = {
  title: '设置接口',
  description: '提供设置、供应商与审批规则接口。',
}

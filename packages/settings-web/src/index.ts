import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type { ProviderInput } from '@ruobai/settings'
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

async function handleProviders(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const parts = url.pathname.split('/').filter(Boolean) // ['api','providers', id?, action?]

    if (parts.length === 2) {
      if (req.method === 'GET') {
        sendJson(res, 200, { settings: ctx.settings.get() })
        return true
      }
      if (req.method === 'POST') {
        const settings = await ctx.settings.upsertProvider(await readJson(req) as ProviderInput)
        sendJson(res, 201, { settings })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (parts[2] === 'models' && parts.length === 3) {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = await readJson(req) as { baseUrl?: string; apiKey?: string; id?: string }
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
        const settings = await ctx.settings.upsertProvider(await readJson(req) as ProviderInput, id)
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

async function fetchModels(ctx: Context, body: { baseUrl?: string; apiKey?: string; id?: string }) {
  const entry = body.id ? ctx.settings.findProvider(body.id) : undefined
  const baseUrl = (body.baseUrl?.trim() || entry?.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) throw new HttpError(400, 'baseUrl is required')
  const key = body.apiKey?.trim() || (body.id ? ctx.settings.apiKeyFor(body.id) : undefined)

  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new HttpError(502, `model list request failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HttpError(502, `models ${response.status}: ${text.slice(0, 300)}`)
  }

  const payload: any = await response.json().catch(() => undefined)
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : []
  const ids = rows
    .map((row: any) => typeof row === 'string' ? row : row?.id)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set<string>(ids)].map(id => ({ id }))
}

function fail(ctx: Context, res: ServerResponse, error: unknown, label: string) {
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500
  if (status >= 500) ctx.logger(label).error(error)
  if (!res.headersSent) sendJson(res, status, { error: message })
}

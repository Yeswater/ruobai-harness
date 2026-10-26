import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/hooks'
import type { HookSettings } from '@ruobai/settings'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'hooks-web'
export const inject = ['web', 'hooks']

/** Gate status, run history, settings and a dry-run endpoint for the panel. */
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.web.register({
        prefix: '/api/hooks',
        handler: (req, res, url) => handle(ctx, req, res, url),
      }),
    'hooks-web.api',
  )

  const push = (payload: unknown) => {
    const ui = ctx.get('ui', false) as
      | { broadcast?(channel: string, data: unknown): void }
      | undefined
    ui?.broadcast?.('hooks', payload)
  }

  ctx.effect(() => {
    const offRun = ctx.on('hooks/run', (run) => push({ kind: 'run', run }))
    const offBlocked = ctx.on('hooks/blocked', (info) =>
      push({ kind: 'blocked', ...info }),
    )
    const offEscalated = ctx.on('hooks/escalated', (info) =>
      push({ kind: 'escalated', ...info }),
    )
    const offViolation = ctx.on('hooks/violation', (info) =>
      push({ kind: 'violation', ...info }),
    )
    return () => {
      offRun()
      offBlocked()
      offEscalated()
      offViolation()
    }
  }, 'hooks-web.sse')
}

export default { name, inject, apply }

interface SettingsServiceShape {
  get?(): {
    hooks?: HookSettings
    llm?: {
      providers?: Array<{
        id: string
        name: string
        models: Array<{ id: string }>
      }>
    }
  }
  updateHooks?(patch: HookSettings): Promise<{ hooks?: HookSettings }>
}

async function handle(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  try {
    const path = url.pathname.replace(/^\/api\/hooks/, '') || '/'
    const method = req.method ?? 'GET'

    if (path === '/status' && method === 'GET') {
      sendJson(res, 200, ctx.hooks.status())
      return true
    }

    if (path === '/runs' && method === 'GET') {
      const requested = Number(url.searchParams.get('limit') ?? 20)
      const limit = Number.isFinite(requested)
        ? Math.min(50, Math.max(1, requested))
        : 20
      sendJson(res, 200, { runs: ctx.hooks.listRuns(limit) })
      return true
    }

    if (path === '/metrics' && method === 'GET') {
      sendJson(res, 200, ctx.hooks.status().metrics)
      return true
    }

    if (path === '/settings' && method === 'GET') {
      const settings = ctx.get('settings', false) as
        | SettingsServiceShape
        | undefined
      const view = settings?.get?.()
      sendJson(res, 200, {
        settings: view?.hooks ?? {},
        providers: view?.llm?.providers ?? [],
      })
      return true
    }

    if (path === '/settings' && method === 'PATCH') {
      const settings = ctx.get('settings', false) as
        | SettingsServiceShape
        | undefined
      if (!settings?.updateHooks)
        throw new HttpError(503, 'settings service is not loaded')
      const body = await readJson(req)
      const updated = await settings.updateHooks((body ?? {}) as HookSettings)
      const view = settings.get?.()
      sendJson(res, 200, {
        settings: updated.hooks ?? view?.hooks ?? {},
        providers: view?.llm?.providers ?? [],
      })
      return true
    }

    if (path === '/run' && method === 'POST') {
      const body = await readJson(req)
      const layer =
        body?.layer === 'stop'
          ? 'stop'
          : body?.layer === 'edit'
            ? 'edit'
            : undefined
      if (!layer) throw new HttpError(400, 'layer must be edit or stop')
      const files = Array.isArray(body.files)
        ? body.files.filter(
            (item: unknown): item is string => typeof item === 'string',
          )
        : undefined
      const result = await ctx.hooks.run(layer, {
        ...(files?.length ? { files } : {}),
        ...(typeof body.sessionId === 'string'
          ? { sessionId: body.sessionId }
          : {}),
      })
      sendJson(res, 200, {
        diagnostics: result.check.diagnostics,
        checkers: result.check.checkers,
        durationMs: result.check.durationMs,
        fresh: result.partition.fresh.length,
        worsened: result.partition.worsened.length,
        known: result.partition.known.length,
      })
      return true
    }

    if (path === '/audit' && method === 'POST') {
      const body = await readJson(req)
      const sessionId =
        typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) throw new HttpError(400, 'sessionId is required')
      const findings = await ctx.hooks.audit(sessionId, 'manual')
      sendJson(res, 200, { findings: findings ?? [] })
      return true
    }

    throw new HttpError(404, 'not found')
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : 'internal error'
    if (status === 500) ctx.logger('hooks-web').error(error)
    if (!res.headersSent) sendJson(res, status, { error: message })
  }
  return true
}

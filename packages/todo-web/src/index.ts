import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/session'
import { todoOf } from '@ruobai/todo'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'todo-web'
// `todo` is a function plugin, not a service: it contributes a projection and
// a tool, and this adapter reads the projection at request time.
export const inject = ['web', 'sessions']

/**
 * Snapshot + push for the task panel.
 *
 * The list itself lives in the session log; this plugin only exposes it to the
 * browser. Live updates ride the same `ui` broadcast the other panels use.
 */
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.web.register({
        prefix: '/api/todo',
        handler: (req, res, url) => {
          if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'method not allowed')
          if (url.pathname.replace(/\/$/, '') !== '/api/todo') throw new HttpError(404, 'not found')
          const sessionId = url.searchParams.get('sessionId')?.trim()
          if (!sessionId) throw new HttpError(400, 'sessionId is required')
          if (!ctx.sessions.get(sessionId)) throw new HttpError(404, `unknown session: ${sessionId}`)
          const state = todoOf(ctx, sessionId)
          sendJson(res, 200, {
            sessionId,
            rev: state.rev,
            items: state.items,
          })
          return true
        },
      }),
    'todo-web.api',
  )

  ctx.effect(() => {
    const off = ctx.on('todo/updated', (sessionId, state) => {
      const ui = ctx.get('ui', false) as
        | { broadcast?(channel: string, data: unknown): void }
        | undefined
      ui?.broadcast?.('todo', {
        sessionId,
        rev: state.rev,
        items: state.items,
      })
    })
    return off
  }, 'todo-web.push')
}

export default { name, inject, apply }

export const meta = {
  title: '任务清单面板',
  description: '读取并推送会话级任务清单。',
}

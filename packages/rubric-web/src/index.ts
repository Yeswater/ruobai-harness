import type { Context } from '@ruobai/cordis'
import { analyse } from '@ruobai/rubric'
import type {} from '@ruobai/session'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'rubric-web'
// `rubric` is a function plugin: it derives a report, it does not own a service.
export const inject = ['web', 'sessions']

/**
 * Read-only diagnosis API.
 *
 * One GET, computed per request from the log. There is deliberately no POST:
 * a rubric that could be edited would stop being evidence and start being an
 * instruction.
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/rubric',
    handler: (req, res, url) => {
      if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'read-only diagnosis')
      if (url.pathname.replace(/\/$/, '') !== '/api/rubric') throw new HttpError(404, 'not found')
      const sessionId = url.searchParams.get('sessionId')?.trim()
      if (!sessionId) throw new HttpError(400, 'sessionId is required')
      if (!ctx.sessions.get(sessionId)) throw new HttpError(404, `unknown session: ${sessionId}`)
      sendJson(res, 200, analyse(ctx, sessionId))
      return true
    },
  }), 'rubric-web.api')
}

export default { name, inject, apply }

export const meta = {
  title: '行为诊断',
  description: '从会话日志归纳失败报告与行为准则。',
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { sendJson } from '@ruobai/web-server'

export interface Config {
  /** Shared secret. When empty, auth is disabled (loopback development). */
  token?: string
  /** Read-only tokens: GET only, and only on audit, handoff and export routes. */
  auditTokens?: string[]
  cookieName?: string
  /** Cookie lifetime in seconds. */
  maxAge?: number
}

export const name = 'web-auth'
export const inject = ['web']

export const Config: z<Config> = z.object({
  token: z.string(),
  auditTokens: z.array(z.string()).default([]),
  cookieName: z.string().default('rbu_token'),
  maxAge: z.number().min(1).default(7 * 24 * 3600),
})

/**
 * Optional shared-token gate plus Origin checks for unsafe methods.
 *
 * Accepted credentials: `Authorization: Bearer <token>`, the session cookie
 * set after a successful check, or `?token=` (which sets the cookie and
 * redirects to the clean URL).
 */
export function apply(ctx: Context, config: Config) {
  const token = config.token?.trim()
  const auditTokens = (config.auditTokens ?? []).map(value => value.trim()).filter(Boolean)
  const cookieName = config.cookieName ?? 'rbu_token'
  const maxAge = config.maxAge ?? 7 * 24 * 3600

  ctx.effect(() => ctx.web.use((req, res, url) => {
    if (!checkOrigin(req, res)) return true
    if (!token) return

    const supplied = bearer(req) ?? cookie(req, cookieName) ?? url.searchParams.get('token')
    if (supplied === token) {
      return remember(req, res, url, token, cookieName, maxAge)
    }
    if (supplied && auditTokens.includes(supplied)) {
      // A read-only token may look at the audit, handoff and export surfaces
      // and nothing else: no writes, no settings, no git, no terminal.
      if (!auditAllowed(req, url)) {
        sendJson(res, 403, { error: 'read-only token' })
        return true
      }
      return remember(req, res, url, supplied, cookieName, maxAge)
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 401, { error: 'unauthorized' })
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(loginPage())
    }
    return true
  }), 'web-auth.guard')
}

function bearer(req: IncomingMessage) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return
  return header.slice(7).trim()
}

/** Remember a `?token=` visit in a cookie and redirect to the clean URL. */
function remember(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  value: string,
  cookieName: string,
  maxAge: number,
) {
  if (!url.searchParams.has('token') || (req.method !== 'GET' && req.method !== 'HEAD')) return
  const target = new URL(url)
  target.searchParams.delete('token')
  res.writeHead(302, {
    'Set-Cookie': `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    Location: `${target.pathname}${target.search}`,
  })
  res.end()
  return true
}

/** Routes a read-only token may reach. Everything else is 403, not 401. */
const AUDIT_PREFIXES = ['/api/audit/', '/api/handoff/', '/api/export/session/', '/audit/']

function auditAllowed(req: IncomingMessage, url: URL) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  return AUDIT_PREFIXES.some(prefix => url.pathname.startsWith(prefix))
}

function cookie(req: IncomingMessage, name: string) {
  const raw = req.headers.cookie
  if (!raw) return
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
}

function checkOrigin(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true
  const origin = req.headers.origin
  if (!origin) return true
  try {
    if (new URL(origin).host === req.headers.host) return true
  } catch {
    // fall through
  }
  sendJson(res, 403, { error: 'origin mismatch' })
  return false
}

function loginPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>RuoBai Harness</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#f6f4ef;color:#24221f;font-family:system-ui,sans-serif}
  form{display:flex;flex-direction:column;gap:10px;width:280px;padding:24px;border:1px solid #ded8ce;border-radius:14px;background:#fbfaf7}
  h1{margin:0 0 4px;font-size:16px;font-weight:600}
  input,button{font:inherit;padding:9px 11px;border-radius:9px;border:1px solid #ded8ce}
  button{background:#c2603d;color:#fff;border:0;cursor:pointer}
</style></head><body>
<form method="get">
  <h1>RuoBai Harness</h1>
  <input name="token" type="password" placeholder="access token" autofocus>
  <button>Continue</button>
</form>
</body></html>`
}

export default { name, inject, Config, apply }

export const meta = {
  title: '访问认证',
  description: '可选的访问令牌校验。',
}

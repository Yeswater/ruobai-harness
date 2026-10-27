import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative, sep } from 'node:path'
import type { Context } from '@ruobai/cordis'
import { parseSkillDocument } from '@ruobai/skills'
import type {} from '@ruobai/workspace'
import { HttpError, sendJson } from '@ruobai/web-server'

export const name = 'skills-web'
export const inject = ['web', 'skills', 'sessions', 'workspace']

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Skill catalog plus the accept/reject flow for proposed skills. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'skills-web.routes')
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === '/api/skills') {
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
      sendJson(res, 200, {
        skills: await ctx.skills.list(sessionId),
        roots: ctx.skills.roots(sessionId),
      })
    } catch (error) {
      respond(ctx, res, error)
    }
    return true
  }

  if (url.pathname === '/api/skill-proposals' || url.pathname.startsWith('/api/skill-proposals/')) {
    try {
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      if (sessionId && !ctx.sessions.has(sessionId)) throw new HttpError(404, 'unknown session')
      const root = ctx.workspace.rootFor(sessionId)
      const proposalsDir = join(root, '.ruobai', 'skill-proposals')
      const skillsDir = join(root, '.ruobai', 'skills')

      if (url.pathname === '/api/skill-proposals' && req.method === 'GET') {
        sendJson(res, 200, { proposals: await listProposals(proposalsDir) })
        return true
      }

      const match = /^\/api\/skill-proposals\/([^/]+)\/(accept)?$/.exec(url.pathname)
      if (!match) throw new HttpError(404, 'not found')
      const name = decodeURIComponent(match[1]!)
      if (!SKILL_NAME.test(name)) throw new HttpError(400, `invalid skill name: ${name}`)
      const source = join(proposalsDir, name)
      if (!inside(proposalsDir, source)) throw new HttpError(400, 'path escapes the workspace')

      if (match[2] === 'accept' && req.method === 'POST') {
        const target = join(skillsDir, name)
        await rm(target, { recursive: true, force: true })
        await mkdir(skillsDir, { recursive: true })
        await rename(source, target)
        ctx.skills.invalidate(root)
        sendJson(res, 200, { accepted: name })
        return true
      }
      if (!match[2] && req.method === 'DELETE') {
        await rm(source, { recursive: true, force: true })
        sendJson(res, 200, { removed: name })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    } catch (error) {
      respond(ctx, res, error)
    }
    return true
  }

  return false
}

async function listProposals(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: Array<{ name: string; description: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const raw = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (!raw) continue
    const parsed = parseSkillDocument(raw)
    out.push({
      name: parsed.meta.name ?? entry.name,
      description: parsed.meta.description ?? '',
    })
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))
}

function respond(ctx: Context, res: ServerResponse, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500
  if (status === 500) ctx.logger('skills-web').error(error)
  if (!res.headersSent) {
    sendJson(res, status, { error: error instanceof Error ? error.message : 'internal error' })
  }
}

export default { name, inject, apply }

export const meta = {
  title: '技能接口',
  description: '技能目录、扫描根与技能提案的接受/拒绝接口。',
}

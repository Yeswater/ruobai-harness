import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, relative, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Context } from '@ruobai/cordis'
import type {} from '@ruobai/net'
import { parseSkillDocument } from '@ruobai/skills'
import type {} from '@ruobai/workspace'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'skills-web'
export const inject = ['web', 'skills', 'sessions', 'workspace', 'net']

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

  if (url.pathname === '/api/skillhub' || url.pathname.startsWith('/api/skillhub/')) {
    try {
      await handleSkillHub(ctx, req, res, url)
    } catch (error) {
      respond(ctx, res, error)
    }
    return true
  }

  return false
}

const SKILLHUB_API = 'https://api.skillhub.cn'
const SKILLHUB_TIMEOUT_MS = 20_000
const SKILLZIP_MAX_BYTES = 30 * 1024 * 1024
const SKILLZIP_MAX_FILES = 500

async function handleSkillHub(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === '/api/skillhub/skills') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    const params = new URLSearchParams()
    for (const key of ['page', 'pageSize', 'keyword', 'category', 'sortBy', 'order', 'source']) {
      const value = url.searchParams.get(key)
      if (value) params.set(key, value)
    }
    const body: any = await hubJson(ctx, `/api/skills?${params.toString()}`)
    sendJson(res, 200, { skills: body?.data?.skills ?? [], total: body?.data?.total ?? 0 })
    return
  }

  if (url.pathname === '/api/skillhub/categories') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    const body: any = await hubJson(ctx, '/api/v1/categories')
    sendJson(res, 200, { items: body?.items ?? [] })
    return
  }

  if (url.pathname === '/api/skillhub/showcase') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    const section = url.searchParams.get('section') ?? 'recommended'
    if (!['recommended', 'trending', 'new'].includes(section)) throw new HttpError(400, 'invalid section')
    const body: any = await hubJson(ctx, `/api/v1/showcase/${section}`)
    sendJson(res, 200, { skills: body?.skills ?? [] })
    return
  }

  const installed = /^\/api\/skillhub\/installed\/([^/]+)$/.exec(url.pathname)
  if (installed && req.method === 'DELETE') {
    const name = decodeURIComponent(installed[1]!)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!SKILL_NAME.test(name)) throw new HttpError(400, `invalid skill name: ${name}`)
    if (!sessionId || !ctx.sessions.has(sessionId)) throw new HttpError(400, 'sessionId is required')
    const root = ctx.workspace.rootFor(sessionId)
    const skillsDir = join(root, '.ruobai', 'skills')
    const target = join(skillsDir, name)
    if (!inside(skillsDir, target)) throw new HttpError(400, 'path escapes the workspace')
    await rm(target, { recursive: true, force: true })
    ctx.skills.invalidate(root)
    sendJson(res, 200, { removed: name })
    return
  }

  if (url.pathname === '/api/skillhub/install') {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await readJson(req)
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) throw new HttpError(400, 'invalid skill slug')
    if (!sessionId || !ctx.sessions.has(sessionId)) throw new HttpError(400, 'sessionId is required')
    sendJson(res, 201, await installHubSkill(ctx, slug, sessionId))
    return
  }

  throw new HttpError(404, 'not found')
}

async function hubJson(ctx: Context, path: string) {
  let last: unknown
  // The public edge occasionally drops one of the three parallel first-load
  // requests; a couple of short retries keeps the skills page from flashing an
  // error while the other two sections render.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await ctx.net.fetch(`${SKILLHUB_API}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(SKILLHUB_TIMEOUT_MS),
      })
      if (response.status >= 500 || response.status === 429) {
        last = new Error(`skillhub ${response.status}`)
      } else if (!response.ok) {
        throw new HttpError(502, `skillhub ${response.status}`)
      } else {
        return response.json()
      }
    } catch (error) {
      last = error
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }
  throw new HttpError(502, `skillhub request failed: ${last instanceof Error ? last.message : String(last)}`)
}

async function installHubSkill(ctx: Context, slug: string, sessionId: string) {
  let response: Response
  try {
    response = await ctx.net.fetch(`${SKILLHUB_API}/api/v1/download?slug=${encodeURIComponent(slug)}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    throw new HttpError(502, `skill download failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new HttpError(502, `skill download ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > SKILLZIP_MAX_BYTES) throw new HttpError(413, 'skill package is too large')
  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length > SKILLZIP_MAX_BYTES) throw new HttpError(413, 'skill package is too large')
  if (archive.subarray(0, 2).toString('latin1') !== 'PK') throw new HttpError(502, 'skill package is not a zip file')

  const root = ctx.workspace.rootFor(sessionId)
  const scratch = join(root, '.ruobai', 'skill-downloads', randomUUID())
  let extracted = ''
  try {
    for (const entry of unzipEntries(archive)) {
      const target = join(scratch, entry.name)
      if (!inside(scratch, target)) throw new HttpError(400, 'skill package escapes its directory')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data)
      extracted = target
    }
    if (!extracted) throw new HttpError(422, 'skill package is empty')

    // Packages either put SKILL.md at the root or inside one top-level folder.
    const rootSkill = await readFile(join(scratch, 'SKILL.md'), 'utf8').catch(() => undefined)
    let source = scratch
    if (!rootSkill) {
      const entries = await readdir(scratch, { withFileTypes: true })
      const folders = entries.filter(entry => entry.isDirectory())
      if (folders.length !== 1) throw new HttpError(422, 'SKILL.md not found in skill package')
      source = join(scratch, folders[0]!.name)
    }
    const raw = await readFile(join(source, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (!raw) throw new HttpError(422, 'SKILL.md not found in skill package')
    const parsed = parseSkillDocument(raw)
    const name = parsed.meta.name ?? slug
    if (!SKILL_NAME.test(name)) throw new HttpError(422, `invalid skill name: ${name}`)

    const target = join(root, '.ruobai', 'skills', name)
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    ctx.skills.invalidate(root)
    return { name, path: relative(root, target) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** Minimal, bounded ZIP reader: no symlinks, no traversal, no ZIP64. */
export function unzipEntries(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive)
  if (eocd < 0) throw new HttpError(422, 'invalid zip: end record not found')
  const count = archive.readUInt16LE(eocd + 10)
  const offset = archive.readUInt32LE(eocd + 16)
  if (count > SKILLZIP_MAX_FILES) throw new HttpError(413, 'skill package has too many files')

  const entries: ZipEntry[] = []
  let cursor = offset
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new HttpError(422, 'invalid zip: bad directory entry')
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const compressed = archive.readUInt32LE(cursor + 20)
    const uncompressed = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const external = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const next = cursor + 46 + nameLength + extraLength + commentLength

    if (flags & 1) throw new HttpError(422, 'encrypted skill packages are not supported')
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new HttpError(422, 'ZIP64 is not supported')
    if (((external >>> 16) & 0o170000) === 0o120000) throw new HttpError(422, 'symlinks are not allowed')
    if (name.endsWith('/')) {
      cursor = next
      continue
    }

    const safe = name.replace(/\\/g, '/')
    if (!safe || safe.startsWith('/') || /^[a-zA-Z]:/.test(safe) || safe.split('/').includes('..')) {
      throw new HttpError(422, `unsafe path in skill package: ${name}`)
    }
    total += uncompressed
    if (total > SKILLZIP_MAX_BYTES) throw new HttpError(413, 'skill package expands beyond the size limit')

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new HttpError(422, 'invalid zip: bad local header')
    const localName = archive.readUInt16LE(localOffset + 26)
    const localExtra = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const raw = archive.subarray(start, start + compressed)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(uncompressed, 1) })
    else throw new HttpError(422, `unsupported compression method ${method}`)
    entries.push({ name: safe, data })
    cursor = next
  }
  return entries
}

function findEndOfCentralDirectory(archive: Buffer) {
  if (archive.length < 22) return -1
  const last = Math.max(0, archive.length - 65_557)
  for (let index = archive.length - 22; index >= last; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) return index
  }
  return -1
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

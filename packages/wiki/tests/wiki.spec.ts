import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import WorkspaceService from '@ruobai/workspace'
import { tokenize } from '../src/bm25.ts'
import { chunkPage } from '../src/chunk.ts'
import { parsePage, serializePage, type PageMeta } from '../src/frontmatter.ts'
import WikiService from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const BODY = [
  '## 摘要',
  '',
  'Seatbelt 沙箱只接受 * 或 localhost 作为网络主机。',
  '',
  '## 事实',
  '',
  '- 嵌套 sandbox-exec 会 exit 71。',
  '- process-fork 必须 allow，否则任何管道都无法启动。',
].join('\n')

async function setup() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rbh-wiki-ws-'))
  cleanups.push(() => rm(workspaceRoot, { recursive: true, force: true }))
  const wikiRoot = join(workspaceRoot, '.ruobai', 'wiki')

  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const workspace = ctx.plugin(WorkspaceService, { root: workspaceRoot })
  await workspace
  cleanups.push(() => workspace.dispose())
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(() => tools.dispose())
  const wiki = ctx.plugin(WikiService, { root: wikiRoot })
  await wiki
  cleanups.push(() => wiki.dispose())

  const session = ctx.sessions.create({ workspace: workspaceRoot })
  return { ctx, sessionId: session.id, workspaceRoot, wikiRoot, wikiFiber: wiki }
}

describe('wiki format', () => {
  it('round-trips frontmatter', () => {
    const meta: PageMeta = {
      id: 'sandbox-seatbelt',
      title: 'macOS Seatbelt 沙箱',
      tags: ['sandbox', 'macos'],
      sources: [{ kind: 'file', path: 'docs/sandbox-macos.md' }],
      updated: '2026-10-27T10:00:00.000Z',
      confidence: 'high',
      status: 'ready',
      revision: 3,
    }
    const parsed = parsePage(serializePage({ meta, body: BODY }))
    expect(parsed?.meta).toMatchObject(meta)
    expect(parsed?.body).toContain('sandbox-exec')
  })

  it('chunks by heading and keeps the heading path', () => {
    const chunks = chunkPage(BODY, { maxChars: 120, overlap: 20 })
    expect(chunks.some(chunk => chunk.heading === '摘要')).toBe(true)
    expect(chunks.some(chunk => chunk.heading === '事实')).toBe(true)
    expect(chunks.every(chunk => chunk.text.length <= 120)).toBe(true)
  })

  it('tokenizes CJK into bigrams and keeps identifiers', () => {
    expect(tokenize('沙箱')).toContain('沙箱')
    expect(tokenize('sandbox_exec')).toEqual(expect.arrayContaining(['sandbox_exec', 'sandbox', 'exec']))
  })
})

describe('wiki service', () => {
  it('writes, searches (CJK and ASCII) and reads at three levels', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.wiki.write({
      id: 'sandbox-seatbelt',
      title: 'macOS Seatbelt 沙箱',
      body: BODY,
      tags: ['sandbox'],
      sources: [{ kind: 'file', path: 'docs/sandbox-macos.md' }],
    }, sessionId)

    const cjk = await ctx.wiki.search('沙箱', {}, sessionId)
    expect(cjk.hits[0]?.page).toBe('sandbox-seatbelt')
    const ascii = await ctx.wiki.search('sandbox-exec', {}, sessionId)
    expect(ascii.hits.some(hit => hit.page === 'sandbox-seatbelt')).toBe(true)

    expect(await ctx.wiki.read('sandbox-seatbelt', 'summary', sessionId)).toContain('Seatbelt')
    const overview = (await ctx.wiki.read('sandbox-seatbelt', 'overview', sessionId))!
    expect(overview).toContain('事实')
    expect(overview.length).toBeLessThanOrEqual(4_000)
    expect(await ctx.wiki.read('sandbox-seatbelt', 'full', sessionId)).toContain('exit 71')
  })

  it('rebuilds the same index after .index is deleted', async () => {
    const { ctx, sessionId, wikiRoot, wikiFiber } = await setup()
    await ctx.wiki.write({
      id: 'sandbox-seatbelt',
      title: 'macOS Seatbelt 沙箱',
      body: BODY,
      sources: [{ kind: 'file', path: 'docs/sandbox-macos.md' }],
    }, sessionId)
    const indexPath = join(wikiRoot, '.index', 'index.json')
    const before = await readFile(indexPath, 'utf8')

    // Drop the in-memory cache too: a removed `.index/` must rebuild from
    // Markdown alone and produce the same bytes.
    await wikiFiber.dispose()
    await rm(join(wikiRoot, '.index'), { recursive: true, force: true })
    const remounted = ctx.plugin(WikiService, { root: wikiRoot })
    await remounted
    cleanups.push(() => remounted.dispose())

    await ctx.wiki.search('seatbelt', {}, sessionId)
    expect(await readFile(indexPath, 'utf8')).toBe(before)
  })

  it('excludes unsourced pages from the catalog', async () => {
    const { ctx, sessionId } = await setup()
    await ctx.wiki.write({
      id: 'sandbox-seatbelt',
      title: 'macOS Seatbelt 沙箱',
      body: BODY,
      sources: [{ kind: 'file', path: 'docs/sandbox-macos.md' }],
    }, sessionId)
    await ctx.wiki.write({ id: 'unsourced', title: 'Unverified', body: '## 摘要\n\n无来源的断言。' })

    const catalog = await ctx.wiki.injection(sessionId)
    expect(catalog).toContain('<wiki_catalog>')
    expect(catalog).toContain('sandbox-seatbelt')
    expect(catalog).not.toContain('unsourced')
  })

  it('rejects ids that escape the wiki root', async () => {
    const { ctx } = await setup()
    await expect(ctx.wiki.write({ id: '../evil', title: 'x', body: 'y' })).rejects.toThrow('invalid page id')
  })
})

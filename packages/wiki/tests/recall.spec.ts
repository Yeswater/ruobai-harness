import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import SessionService from '@ruobai/session'
import ToolRegistry from '@ruobai/tools'
import WorkspaceService from '@ruobai/workspace'
import WikiService from '../src/index.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Ten queries over the repository's own docs; Recall@5 is the metric. */
const QUERIES: Array<[string, string]> = [
  ['Seatbelt 沙箱 网络 主机', 'sandbox-macos'],
  ['prompt 前缀缓存 失效 归因', 'prompt-cache'],
  ['压缩 摘要 检查点', 'compaction'],
  ['Gitee 仓库 发布 release', 'gitee-plugin'],
  ['Mermaid 图表 渲染', 'mermaid-render'],
  ['插件 生态 时间线', 'plugin-ecosystem-timeline'],
  ['协议 AGENTS skills MCP', 'protocols'],
  ['沙箱 web 面板 守卫', 'sandbox-web-panel'],
  ['轨迹 面板 记录', 'trajectory-panel'],
  ['长期记忆 wiki 知识库', 'memory-and-wiki'],
  ['seatbelt 嵌套 exit 71', 'sandbox-macos-appendix-f'],
  ['hook lint 门禁 格式化', 'hooks'],
  ['denial escalation 审批', 'sandbox-macos'],
  ['cache break 归因 前缀', 'prompt-cache'],
  ['分块 BM25 检索', 'memory-and-wiki'],
  ['会话 事件 日志 追加', 'compaction'],
  ['工具 输出 裁剪', 'compaction'],
  ['sandbox profile 编译', 'sandbox-macos'],
  ['面板 状态 拒绝记录', 'sandbox-web-panel'],
  ['知识库 页面 提案 审核', 'memory-and-wiki'],
]

async function setup() {
  const wikiRoot = await mkdtemp(join(tmpdir(), 'rbh-recall-'))
  cleanups.push(() => rm(wikiRoot, { recursive: true, force: true }))
  const ctx = new Context()
  const sessions = ctx.plugin(SessionService)
  await sessions
  cleanups.push(() => sessions.dispose())
  const workspace = ctx.plugin(WorkspaceService, { root: process.cwd() })
  await workspace
  cleanups.push(() => workspace.dispose())
  const tools = ctx.plugin(ToolRegistry)
  await tools
  cleanups.push(() => tools.dispose())
  const wiki = ctx.plugin(WikiService, {
    root: wikiRoot,
    searchLimit: 5,
    searchMaxChars: 20_000,
    // Evaluation fixtures are whole documents; the shipped limit is 64 KB.
    maxPageBytes: 512 * 1024,
  })
  await wiki
  cleanups.push(() => wiki.dispose())
  const session = ctx.sessions.create({ workspace: process.cwd() })
  return { ctx, sessionId: session.id }
}

describe('wiki recall', () => {
  it('finds the expected page in the top 5 for repository docs', async () => {
    const { ctx, sessionId } = await setup()
    const docs = (await readdir('docs')).filter(name => name.endsWith('.md')).sort()
    for (const [index, name] of docs.entries()) {
      const body = await readFile(join('docs', name), 'utf8')
      const stem = name.replace(/\.md$/, '')
      // Page ids are ASCII by contract; a Chinese filename still has to be
      // searchable, so it gets a stable surrogate id rather than being skipped.
      const id = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem) ? stem : `doc-${index}`
      await ctx.wiki.write({
        id,
        title: stem.replace(/-/g, ' '),
        body,
        sources: [{ kind: 'file', path: `docs/${name}` }],
      }, sessionId)
    }

    let hit = 0
    for (const [query, expected] of QUERIES) {
      const result = await ctx.wiki.search(query, { limit: 5 }, sessionId)
      if (result.hits.some(item => item.page === expected)) hit += 1
    }
    const recall = hit / QUERIES.length
    console.log(`recall@5 = ${hit}/${QUERIES.length} (${recall.toFixed(2)})`)
    expect(recall).toBeGreaterThanOrEqual(0.75)
  })
})

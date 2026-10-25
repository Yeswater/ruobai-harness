import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ruobai/cordis'
import McpConfigService from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function setup() {
  const workspaceRoot = await tempDir('rbh-mcp-ws-')
  const globalRoot = await tempDir('rbh-mcp-home-')
  const ctx = new Context()
  const service = ctx.plugin(McpConfigService, {
    workspaceRoot,
    globalRoot,
    watchIntervalMs: 0,
  })
  await service
  cleanups.push(() => service.dispose())
  return { ctx, workspaceRoot, globalRoot }
}

describe('mcp config files', () => {
  it('merges workspace, project and global files with workspace priority', async () => {
    const { ctx, workspaceRoot, globalRoot } = await setup()
    await writeFile(join(workspaceRoot, '.mcp.json'), JSON.stringify({
      mcpServers: {
        alpha: { command: 'workspace-alpha' },
        'My Server!': { command: 'slugged' },
        beta: { command: 'masked-beta', disabled: true },
      },
    }))
    await mkdir(join(workspaceRoot, '.ruobai'))
    await writeFile(join(workspaceRoot, '.ruobai', 'mcp.json'), JSON.stringify({
      servers: [
        { id: 'alpha', command: 'project-alpha' },
        { id: 'gamma', command: 'project-gamma', cwd: '.' },
      ],
    }))
    await writeFile(join(globalRoot, 'mcp.json'), JSON.stringify({
      mcpServers: { alpha: { command: 'global-alpha' }, delta: { command: 'global-delta' } },
    }))

    const servers = await ctx.mcpConfig.servers()
    expect(servers.map(server => server.id)).toEqual(['alpha', 'my-server', 'beta', 'gamma', 'delta'])
    expect(servers.find(server => server.id === 'alpha')).toMatchObject({
      command: 'workspace-alpha',
      source: 'file',
      cwd: workspaceRoot,
      filePath: join(workspaceRoot, '.mcp.json'),
    })
    expect(servers.find(server => server.id === 'beta')).toMatchObject({
      command: 'masked-beta',
      disabled: true,
    })
    expect(servers.find(server => server.id === 'gamma')?.cwd).toBe(join(workspaceRoot, '.ruobai'))
    expect(servers.find(server => server.id === 'delta')?.command).toBe('global-delta')
  })

  it('expands env references and home-relative cwd', async () => {
    const { ctx, workspaceRoot } = await setup()
    process.env.RBU_MCP_TOKEN = 'secret-token'
    await writeFile(join(workspaceRoot, '.mcp.json'), JSON.stringify({
      mcpServers: {
        env: {
          command: 'run',
          env: { TOKEN: '${RBU_MCP_TOKEN}', LITERAL: 'plain' },
          cwd: '~/projects',
        },
      },
    }))
    const [server] = await ctx.mcpConfig.servers()
    expect(server?.env).toEqual({ TOKEN: 'secret-token', LITERAL: 'plain' })
    if (server?.cwd) expect(server.cwd.endsWith('/projects') || server.cwd.endsWith('\\projects')).toBe(true)
    delete process.env.RBU_MCP_TOKEN
  })

  it('ignores malformed files and entries without a command', async () => {
    const { ctx, workspaceRoot } = await setup()
    await writeFile(join(workspaceRoot, '.mcp.json'), '{ not json')
    const servers = await ctx.mcpConfig.servers()
    expect(servers).toEqual([])
  })
})

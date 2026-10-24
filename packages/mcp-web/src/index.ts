import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@ruobai/cordis'
import type { McpServerDefinition, McpStatus } from '@ruobai/mcp'
import type { McpServerInput, PublicMcpServer } from '@ruobai/settings'
import { HttpError, readJson, sendJson } from '@ruobai/web-server'

export const name = 'mcp-web'
export const inject = ['web', 'settings', 'mcp']

interface McpServerView extends PublicMcpServer {
  status: McpStatus
  error?: string
  tools: string[]
  pid?: number
}

/** CRUD for MCP servers plus their live connection status. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/mcp',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'mcp-web.api')
}

export default { name, inject, apply }

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    const method = req.method ?? 'GET'
    const parts = url.pathname.split('/').filter(Boolean) // ['api', 'mcp', ...]

    if (parts.length === 2) {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed')
      sendJson(res, 200, { servers: view(ctx) })
      return true
    }

    if (parts[2] !== 'servers') throw new HttpError(404, 'not found')

    if (parts.length === 3) {
      if (method === 'GET') {
        sendJson(res, 200, { servers: view(ctx) })
        return true
      }
      if (method === 'POST') {
        await ctx.settings.upsertMcpServer(await readJson(req) as McpServerInput)
        sendJson(res, 201, { servers: view(ctx) })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    const id = decodeURIComponent(parts[3] ?? '')
    if (!id) throw new HttpError(404, 'not found')

    if (parts[4] === 'reconnect' && parts.length === 5) {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const entry = ctx.settings.findMcpServer(id)
      if (!entry) throw new HttpError(404, 'MCP server not found')
      if (entry.disabled) throw new HttpError(400, 'MCP server is disabled')
      const definition: McpServerDefinition = {
        id: entry.id,
        label: entry.label,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        cwd: entry.cwd,
        timeoutMs: entry.timeoutMs,
        approval: entry.approval,
        restart: entry.restart,
      }
      if (ctx.mcp.get(id)) await ctx.mcp.reconnect(id)
      else await ctx.mcp.connect(definition)
      sendJson(res, 200, { server: view(ctx).find(server => server.id === id) })
      return true
    }

    if (parts.length === 4) {
      if (method === 'PATCH' || method === 'PUT') {
        await ctx.settings.upsertMcpServer(await readJson(req) as McpServerInput, id)
        sendJson(res, 200, { servers: view(ctx) })
        return true
      }
      if (method === 'DELETE') {
        await ctx.settings.removeMcpServer(id)
        sendJson(res, 200, { servers: view(ctx) })
        return true
      }
      throw new HttpError(405, 'method not allowed')
    }

    throw new HttpError(404, 'not found')
  } catch (error) {
    fail(ctx, res, error)
  }
  return true
}

function view(ctx: Context): McpServerView[] {
  const configured = ctx.settings.get().mcp?.servers ?? []
  return configured.map((entry) => {
    const status = ctx.mcp.get(entry.id)
    if (entry.disabled) {
      return { ...entry, status: 'disconnected', tools: [] }
    }
    return {
      ...entry,
      status: status?.status ?? 'disconnected',
      error: status?.error,
      tools: status?.tools ?? [],
      pid: status?.pid,
    }
  })
}

function fail(ctx: Context, res: ServerResponse, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : message.startsWith('unknown MCP') ? 404 : 500
  if (status >= 500) ctx.logger('mcp-web').error(error)
  if (!res.headersSent) sendJson(res, status, { error: message })
}

export const meta = {
  title: 'MCP 接口',
  description: '提供 MCP 服务器的管理接口。',
}

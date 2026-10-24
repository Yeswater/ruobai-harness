import type { Context } from '@ruobai/cordis'
import { WebSocketServer, WebSocket } from 'ws'

export const name = 'web-ws'
export const inject = ['web', 'chat']

/**
 * WebSocket downlink for live UI events.
 *
 * One JSON frame per message: `{ type: 'hello' | 'chat' | 'pong', ... }`.
 * The UI prefers this channel and falls back to SSE if the upgrade fails.
 */
export function apply(ctx: Context) {
  const wss = new WebSocketServer({ noServer: true })

  const broadcast = (payload: unknown) => {
    const frame = JSON.stringify(payload)
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame)
    }
  }

  ctx.effect(() => ctx.web.registerUpgrade('/api/ws', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      client.send(JSON.stringify({ type: 'hello', url: ctx.web.url }))
      client.on('message', (data) => {
        try {
          const message = JSON.parse(String(data))
          if (message?.type === 'ping') client.send(JSON.stringify({ type: 'pong' }))
        } catch {
          // ignore malformed client frames
        }
      })
    })
  }), 'web-ws.upgrade')

  ctx.effect(() => ctx.on('chat/event', event => broadcast({ type: 'chat', event })), 'web-ws.broadcast')

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping()
    }
  }, 20_000)
  heartbeat.unref?.()

  ctx.effect(() => () => {
    clearInterval(heartbeat)
    for (const client of wss.clients) client.terminate()
    wss.close()
  }, 'web-ws.close')
}

export default { name, inject, apply }

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Fan a server-side event out to every open SSE connection. */
export class SseHub {
  private readonly clients = new Set<ServerResponse>()

  attach(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    req.on('close', () => this.clients.delete(res))
  }

  broadcast(event: string, data: unknown) {
    if (!this.clients.size) return
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of this.clients) client.write(payload)
  }

  ping() {
    for (const client of this.clients) client.write(': ping\n\n')
  }

  closeAll() {
    for (const client of this.clients) client.end()
    this.clients.clear()
  }
}

import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { SessionEvent, SessionMeta } from '@ruobai/session'

export interface Config {
  /** Directory holding one `<id>.jsonl` per session. Relative to cwd. */
  root?: string
}

interface Header {
  type: 'session'
  version: 1
  id: string
  createdAt: number
}

declare module '@ruobai/cordis' {
  interface Context {
    sessionJsonl: SessionJsonl
  }
}

/**
 * One JSONL file per session: a header line, then one event per line.
 *
 * Writes are serialized per session so a slow disk cannot reorder events.
 * Loading tolerates a torn final line (crash during append) by skipping it.
 */
export class SessionJsonl extends Service {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().default('.sessions'),
  })

  private readonly root: string
  private readonly queues = new Map<string, Promise<void>>()
  private readonly logger

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionJsonl')
    this.root = resolve(config.root ?? '.sessions')
    this.logger = ctx.logger('session-jsonl')
  }

  async *[Service.init]() {
    await mkdir(this.root, { recursive: true })

    for (const file of await readdir(this.root)) {
      if (!file.endsWith('.jsonl')) continue
      try {
        await this.load(join(this.root, file))
      } catch (error) {
        this.logger.error(error)
      }
    }

    const offEvent = this.ctx.on('session/event', (id, event) => this.writeEvent(id, event))
    const offCreated = this.ctx.on('session/created', meta => this.writeHeader(meta))
    const offRemoved = this.ctx.on('session/removed', id => this.removeFile(id))

    yield async () => {
      offEvent()
      offCreated()
      offRemoved()
      await Promise.allSettled(this.queues.values())
    }
  }

  /** Wait for every queued write; used by tests and shutdown paths. */
  async flush() {
    await Promise.allSettled(this.queues.values())
  }

  private fileFor(id: string) {
    return join(this.root, `${encodeURIComponent(id)}.jsonl`)
  }

  private async load(file: string) {
    const text = await readFile(file, 'utf8')
    let header: Header | undefined
    const events: SessionEvent[] = []

    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row: any
      try {
        row = JSON.parse(line)
      } catch {
        continue // torn tail from an interrupted append
      }
      if (row?.type === 'session' && row.version === 1) header = row
      else if (typeof row?.seq === 'number' && typeof row?.type === 'string') events.push(row)
    }

    if (!header) return
    events.sort((a, b) => a.seq - b.seq)
    const meta: SessionMeta = {
      id: header.id,
      title: 'New session',
      createdAt: header.createdAt,
      updatedAt: events.at(-1)?.ts ?? header.createdAt,
    }
    this.ctx.sessions.restore(meta, events)
  }

  private enqueue(id: string, task: () => Promise<unknown>) {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(task).then(() => undefined).catch((error) => {
      this.logger.error(error)
    })
    this.queues.set(id, next)
    return next
  }

  private writeHeader(meta: SessionMeta) {
    const header: Header = { type: 'session', version: 1, id: meta.id, createdAt: meta.createdAt }
    void this.enqueue(meta.id, async () => {
      await mkdir(this.root, { recursive: true })
      await writeFile(this.fileFor(meta.id), JSON.stringify(header) + '\n')
    })
  }

  private writeEvent(id: string, event: SessionEvent) {
    void this.enqueue(id, () => appendFile(this.fileFor(id), JSON.stringify(event) + '\n'))
  }

  private removeFile(id: string) {
    void this.enqueue(id, () => unlink(this.fileFor(id)).catch(() => undefined))
  }
}

export default SessionJsonl

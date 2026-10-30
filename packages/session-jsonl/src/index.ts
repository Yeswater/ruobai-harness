import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import { inferVisibility } from '@ruobai/session'
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

    // Subscribe before scanning: a session created while the adapter is still
    // reading existing files must not lose its header and initial meta events.
    const offEvent = this.ctx.on('session/event', (id, event) => this.writeEvent(id, event))
    const offCreated = this.ctx.on('session/created', meta => this.writeHeader(meta))
    const offRemoved = this.ctx.on('session/removed', id => this.removeFile(id))

    for (const file of await readdir(this.root)) {
      if (!file.endsWith('.jsonl')) continue
      try {
        await this.load(join(this.root, file))
      } catch (error) {
        this.logger.error(error)
      }
    }

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
      else if (typeof row?.seq === 'number' && typeof row?.type === 'string') {
        events.push({
          seq: row.seq,
          ts: typeof row.ts === 'number' ? row.ts : Date.now(),
          type: row.type,
          data: row.data,
          // Rows written before the field existed are upgraded on load, so a
          // reloaded session and a live one agree on what may leave the harness.
          visibility: row.visibility === 'client' || row.visibility === 'internal' || row.visibility === 'secret'
            ? row.visibility
            : inferVisibility(row.type),
        })
      }
    }

    events.sort((a, b) => a.seq - b.seq)
    if (header) {
      const meta: SessionMeta = {
        id: header.id,
        title: 'New session',
        createdAt: header.createdAt,
        updatedAt: events.at(-1)?.ts ?? header.createdAt,
      }
      this.ctx.sessions.restore(meta, events)
      return
    }
    if (!events.length) return

    // A session created before this adapter subscribed has events but no
    // header. Recover it from the log instead of dropping the whole history.
    const id = decodeURIComponent(basename(file, '.jsonl'))
    const repaired = repair(events)
    this.ctx.sessions.restore(repaired.meta(id), repaired.events)
    try {
      await rewrite(file, id, repaired.events)
      this.logger.warn('repaired session file without a header: %s', file)
    } catch (error) {
      this.logger.error(error)
    }
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

interface Recovered {
  events: SessionEvent[]
  meta(id: string): SessionMeta
}

/**
 * Rebuild a missing header and the title/meta events that were never written.
 *
 * Original sequence numbers are preserved; gaps below the first event are
 * filled with inert `session/repair` events so `append` (which uses the event
 * count) cannot collide with an existing seq.
 */
export function repair(events: SessionEvent[]): Recovered {
  let title = 'New session'
  let firstUser = ''
  let meta: Partial<SessionMeta> = {}
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    if (event.type === 'session/meta') {
      meta = { ...meta, ...Object.fromEntries(Object.entries(event.data ?? {}).filter(([, v]) => v !== undefined)) }
    }
    if (event.type === 'context/snapshot') {
      const data = event.data ?? {}
      if (data.workspace) meta.workspace = data.workspace
      if (data.provider) meta.provider = data.provider
      if (data.model) meta.model = data.model
      if (data.mode) meta.mode = data.mode
      if (data.permission) meta.permission = data.permission
    }
    if (!firstUser && event.type === 'message/user' && !event.data?.source && typeof event.data?.text === 'string') {
      firstUser = event.data.text
    }
  }
  if (title === 'New session' && firstUser) title = firstUser.slice(0, 42)

  const maxSeq = events.at(-1)?.seq ?? 0
  const used = new Map(events.map(event => [event.seq, event]))
  // Missing slots (usually 0 and 1) are filled with title/meta, then inert
  // repairs, keeping every original seq stable.
  const missing: number[] = []
  for (let seq = 0; seq <= maxSeq; seq += 1) {
    if (!used.has(seq)) missing.push(seq)
  }
  const synthetic: SessionEvent[] = missing.map((seq, index) => {
    const ts = events[0]!.ts
    if (index === 0) return { seq, ts, type: 'session/title', data: { title } }
    if (index === 1) return { seq, ts, type: 'session/meta', data: meta }
    return { seq, ts, type: 'session/repair', data: { reason: 'missing header' } }
  })

  const merged = [...synthetic, ...events].sort((left, right) => left.seq - right.seq)
  const createdAt = events[0]!.ts
  return {
    events: merged,
    meta: (sessionId: string) => ({
      id: sessionId,
      title,
      createdAt,
      updatedAt: events.at(-1)?.ts ?? createdAt,
      ...meta,
    }),
  }
}

async function rewrite(file: string, id: string, events: SessionEvent[]) {
  const header: Header = { type: 'session', version: 1, id, createdAt: events[0]?.ts ?? Date.now() }
  const temp = `${file}.${process.pid}.repair`
  const body = [header, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(temp, body)
  await rename(temp, file)
}

export default SessionJsonl

export const meta = {
  title: '会话记录',
  description: '把会话事件持久化为 JSONL 文件。',
}

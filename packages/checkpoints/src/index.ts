import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { SessionEvent } from '@ruobai/session'

export interface Config {
  /** Workspace root that `path` values in events are relative to. */
  root?: string
  /** Content-addressed snapshot directory. */
  store?: string
  /** Largest snapshot to store; larger originals make the change non-revertible. */
  maxBytes?: number
}

export interface CaptureInput {
  sessionId?: string
  path: string
  tool: string
  callId?: string
  before?: Buffer
  beforeExisted: boolean
  beforeBytes?: number
  skipped?: 'too-large' | 'unreadable'
  after: Buffer
  diff?: string
}

export interface FileChange {
  seq: number
  path: string
  tool: string
  callId?: string
  beforeHash?: string
  afterHash?: string
  beforeBytes?: number
  afterBytes?: number
  beforeExisted: boolean
  skipped?: 'too-large' | 'unreadable'
  diff?: string
  at: number
}

export interface RevertResult {
  reverted: string[]
  skipped: Array<{ path: string; reason: string }>
}

declare module '@ruobai/cordis' {
  interface Context {
    checkpoints: CheckpointsService
  }
}

function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function resolveInside(root: string, path: string) {
  const target = resolve(root, path)
  if (!inside(root, target)) throw new Error(`path escapes the workspace: ${path}`)
  return target
}

function digest(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function writeAtomic(target: string, content: Buffer) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content)
  await rename(temp, target)
}

/**
 * Content-addressed snapshots of file writes plus a per-session projection of
 * the changes still in effect. Rollback restores bytes; it never replays events
 * onto disk.
 */
export class CheckpointsService extends Service {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().default('.'),
    store: z.string().default('.ruobai/checkpoints'),
    maxBytes: z.number().min(1).default(262_144),
  })

  private readonly root: string
  private readonly store: string
  private readonly maxBytes: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'checkpoints')
    this.root = resolve(config.root ?? '.')
    this.store = resolve(config.store ?? '.ruobai/checkpoints')
    this.maxBytes = config.maxBytes ?? 262_144

    ctx.effect(() => ctx.sessions.registerProjection('checkpoints', {
      init: () => [] as FileChange[],
      apply: (state: FileChange[], event: SessionEvent) => {
        if (event.type === 'file/change') return [...state, { ...event.data, seq: event.seq }]
        if (event.type === 'file/revert') {
          const upToSeq = typeof event.data?.upToSeq === 'number' ? event.data.upToSeq : -1
          return state.filter(change => change.seq <= upToSeq)
        }
        return state
      },
    }), 'checkpoints.projection')
  }

  /** Changes still in effect for a session, oldest first. */
  changes(sessionId: string): FileChange[] {
    const view = this.ctx.sessions.view<{ checkpoints?: FileChange[] }>(sessionId)
    return [...(view?.checkpoints ?? [])]
  }

  /** Store before/after bytes and append the durable `file/change` event. */
  async capture(input: CaptureInput): Promise<void> {
    if (!input.sessionId || !input.path || !this.ctx.sessions.has(input.sessionId)) return

    const beforeHash = input.before ? await this.put(input.before) : undefined
    const afterHash = await this.put(input.after)
    this.ctx.sessions.append(input.sessionId, 'file/change', {
      path: input.path,
      tool: input.tool,
      ...(input.callId ? { callId: input.callId } : {}),
      beforeExisted: input.beforeExisted,
      ...(beforeHash ? { beforeHash } : {}),
      afterHash,
      ...(input.beforeBytes !== undefined ? { beforeBytes: input.beforeBytes } : {}),
      afterBytes: input.after.byteLength,
      ...(input.skipped ? { skipped: input.skipped } : {}),
      ...(input.diff ? { diff: input.diff } : {}),
      at: Date.now(),
    })
  }

  /**
   * Undo every change after `upToSeq` (all changes by default). A path whose
   * current content no longer matches its last checkpoint is skipped rather
   * than overwriting an external edit.
   */
  async revert(sessionId: string, upToSeq = -1): Promise<RevertResult> {
    if (!this.ctx.sessions.has(sessionId)) throw new Error(`unknown session: ${sessionId}`)
    const active = this.changes(sessionId).filter(change => change.seq > upToSeq)
    if (!active.length) return { reverted: [], skipped: [] }

    const groups = new Map<string, FileChange[]>()
    for (const change of active) {
      const list = groups.get(change.path)
      if (list) list.push(change)
      else groups.set(change.path, [change])
    }

    const reverted: string[] = []
    const skipped: Array<{ path: string; reason: string }> = []

    for (const [path, changes] of groups) {
      changes.sort((a, b) => a.seq - b.seq)
      const first = changes[0]!
      const last = changes[changes.length - 1]!

      let target: string
      try {
        target = resolveInside(this.root, path)
      } catch {
        skipped.push({ path, reason: 'path escapes the workspace' })
        continue
      }

      const current = await readFile(target).catch(() => undefined)
      if (last.afterHash && (!current || digest(current) !== last.afterHash)) {
        skipped.push({ path, reason: 'file changed since the checkpoint' })
        continue
      }

      try {
        if (first.beforeExisted) {
          if (!first.beforeHash) {
            skipped.push({
              path,
              reason: first.skipped === 'too-large'
                ? 'original file was too large to snapshot'
                : 'original file could not be read',
            })
            continue
          }
          await writeAtomic(target, await this.blob(first.beforeHash))
        } else {
          await unlink(target).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
        }
      } catch (error) {
        skipped.push({
          path,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      reverted.push(path)
    }

    this.ctx.sessions.append(sessionId, 'file/revert', {
      upToSeq,
      reverted,
      skipped,
      at: Date.now(),
    })
    return { reverted, skipped }
  }

  private async put(buffer: Buffer) {
    if (buffer.byteLength > this.maxBytes) {
      throw new Error(`snapshot is larger than ${this.maxBytes} bytes`)
    }
    const id = digest(buffer)
    const path = resolve(this.store, 'blobs', id)
    const exists = await stat(path).then(() => true).catch(() => false)
    if (!exists) await writeAtomic(path, buffer)
    return id
  }

  private blob(id: string) {
    return readFile(resolve(this.store, 'blobs', id))
  }
}

export default CheckpointsService

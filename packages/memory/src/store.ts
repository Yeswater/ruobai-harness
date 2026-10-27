import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MemoryItem, MemoryOp } from './journal.ts'
import { compileSnapshot } from './compile.ts'

/**
 * One memory directory (`memory.jsonl` + `MEMORY.md`). Appends are serialized
 * so two tools in the same turn cannot interleave lines.
 */
export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string) {}

  get journalPath() {
    return join(this.dir, 'memory.jsonl')
  }

  get snapshotPath() {
    return join(this.dir, 'MEMORY.md')
  }

  async load(): Promise<MemoryOp[]> {
    const text = await readFile(this.journalPath, 'utf8').catch(() => '')
    const ops: MemoryOp[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const op = JSON.parse(line) as MemoryOp
        if (op && typeof op === 'object' && typeof op.op === 'string') ops.push(op)
      } catch {
        // A torn last line (crash mid-append) must not poison the journal.
      }
    }
    return ops
  }

  append(op: MemoryOp): Promise<void> {
    const run = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.journalPath, `${JSON.stringify(op)}\n`, 'utf8')
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  writeSnapshot(items: MemoryItem[]): Promise<void> {
    const run = this.queue.then(() => writeAtomic(this.snapshotPath, compileSnapshot(items)))
    this.queue = run.catch(() => undefined)
    return run
  }
}

async function writeAtomic(target: string, content: string) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, target)
}

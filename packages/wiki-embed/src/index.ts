import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import type { SemanticRetriever } from '@ruobai/wiki'
import type {} from '@ruobai/wiki'

export interface Config {
  /** Wire format of the embedding endpoint. */
  kind?: 'ollama' | 'openai'
  baseUrl?: string
  model?: string
  apiKey?: string
  timeoutMs?: number
  batchSize?: number
}

interface VectorFile {
  version: 1
  model: string
  entries: Record<string, { hash: string; vector: number[] }>
}

interface Chunk {
  page: string
  hash: string
  heading: string
  text: string
}

/**
 * Optional semantic half for the wiki.
 *
 * Not mounted by default: it needs a local embedding model (Ollama) or an
 * OpenAI-compatible endpoint. When it is absent or unreachable, wiki search
 * keeps working on BM25 alone; when present, both rankings are fused with RRF.
 */
export function apply(ctx: Context, config: Config = {}) {
  const kind = config.kind ?? 'ollama'
  const baseUrl = (config.baseUrl ?? (kind === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')).replace(/\/$/, '')
  const model = config.model ?? (kind === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small')
  const timeoutMs = config.timeoutMs ?? 10_000
  const batchSize = config.batchSize ?? 32
  const queues = new Map<string, Promise<unknown>>()

  async function embed(texts: string[]): Promise<number[][]> {
    const url = kind === 'ollama' ? `${baseUrl}/api/embed` : `${baseUrl}/embeddings`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`)
    const data = await response.json() as {
      embeddings?: number[][]
      data?: Array<{ embedding: number[] }>
    }
    const vectors = data.embeddings ?? data.data?.map(item => item.embedding)
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error('embeddings response did not match the input')
    }
    return vectors
  }

  function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(root) ?? Promise.resolve()
    const next = previous.then(work, work)
    queues.set(root, next.catch(() => undefined))
    return next
  }

  async function ensure(root: string, chunks: Chunk[]): Promise<VectorFile> {
    return serial(root, async () => {
      const path = join(root, '.index', 'vectors.json')
      const file = await loadVectors(path)
      if (file.model !== model) {
        file.model = model
        file.entries = {}
      }
      const pending = chunks
        .map(chunk => ({ chunk, key: chunkKey(chunk) }))
        .filter(entry => file.entries[entry.key]?.hash !== entry.chunk.hash)
      let changed = pending.length > 0
      for (let index = 0; index < pending.length; index += batchSize) {
        const batch = pending.slice(index, index + batchSize)
        const vectors = await embed(batch.map(entry => `${entry.chunk.heading}\n${entry.chunk.text}`))
        batch.forEach((entry, offset) => {
          file.entries[entry.key] = { hash: entry.chunk.hash, vector: vectors[offset]! }
        })
      }
      const live = new Set(chunks.map(chunkKey))
      for (const key of Object.keys(file.entries)) {
        if (live.has(key)) continue
        delete file.entries[key]
        changed = true
      }
      if (changed) await saveVectors(path, file)
      return file
    })
  }

  const retriever: SemanticRetriever = {
    id: `embed:${model}`,
    async search(query, limit, sessionId) {
      const chunks = await ctx.wiki.chunks(sessionId)
      if (!chunks.length) return []
      const root = ctx.wiki.root(sessionId)
      const file = await ensure(root, chunks)
      const [vector] = await embed([query])
      if (!vector) return []
      return chunks
        .map(chunk => {
          const entry = file.entries[chunkKey(chunk)]
          return entry ? { chunk, score: cosine(vector, entry.vector) } : undefined
        })
        .filter((item): item is { chunk: Chunk; score: number } => Boolean(item))
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, limit))
        .map(item => ({
          page: item.chunk.page,
          heading: item.chunk.heading,
          text: item.chunk.text,
          score: item.score,
        }))
    },
  }

  ctx.effect(() => ctx.wiki.registerRetriever(retriever), 'wiki-embed.retriever')
}

async function loadVectors(path: string): Promise<VectorFile> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as VectorFile
    if (data?.version === 1 && data.entries && typeof data.entries === 'object') return data
  } catch {
    // A missing or corrupt vector file is rebuilt from the pages.
  }
  return { version: 1, model: '', entries: {} }
}

async function saveVectors(path: string, file: VectorFile) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(file)}\n`, 'utf8')
  await rename(temp, path)
}

function chunkKey(chunk: Chunk) {
  return `${chunk.page}\u0000${chunk.heading}\u0000${chunk.text}`
}

function cosine(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! ** 2
    rightNorm += right[index]! ** 2
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

const plugin = {
  name: 'wiki-embed',
  inject: ['wiki'],
  Config: z.object({
    kind: z.union([z.const('ollama'), z.const('openai')]).default('ollama'),
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string(),
    timeoutMs: z.number().min(100).default(10_000),
    batchSize: z.number().min(1).max(256).default(32),
  }),
  apply,
}

export default plugin

export const meta = {
  title: 'Wiki 语义检索',
  description: '可选本地嵌入，与 BM25 用 RRF 融合；不装则行为不变。',
}

export interface WikiChunk {
  /** Heading path inside the page, e.g. `事实 > Seatbelt`. */
  heading: string
  text: string
}

export interface ChunkOptions {
  maxChars?: number
  overlap?: number
}

/**
 * Split a page by headings, then window each section. Chunks are the retrieval
 * unit; the heading path travels with them so a snippet is still readable.
 */
export function chunkPage(body: string, options: ChunkOptions = {}): WikiChunk[] {
  const maxChars = options.maxChars ?? 800
  const overlap = Math.min(options.overlap ?? 100, Math.floor(maxChars / 2))
  const chunks: WikiChunk[] = []
  const stack: string[] = []
  let heading = ''
  let buffer: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (!text) return
    for (const window of windows(text, maxChars, overlap)) {
      chunks.push({ heading: heading || '正文', text: window })
    }
  }

  for (const line of body.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) {
      buffer.push(line)
      continue
    }
    flush()
    const level = match[1]!.length
    stack.length = Math.max(0, level - 1)
    stack[level - 1] = match[2]!
    heading = stack.slice(0, level).filter(Boolean).join(' > ')
  }
  flush()
  return chunks
}

function windows(text: string, maxChars: number, overlap: number) {
  if (text.length <= maxChars) return [text]
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length) {
      const split = text.lastIndexOf('\n', end)
      if (split > start + maxChars / 2) end = split
    }
    out.push(text.slice(start, end).trim())
    if (end >= text.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return out.filter(Boolean)
}

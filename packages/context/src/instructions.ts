import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface InstructionFile {
  /** Absolute path on disk. */
  path: string
  /** Short path shown in the prompt and the protocols page. */
  display: string
  content: string
  bytes: number
}

export interface InstructionConfig {
  /** Directory whose files are appended last (most specific). */
  root: string
  /** User-global `.ruobai` directory. */
  globalRoot?: string
  fileCandidates?: string[]
  localCandidates?: string[]
  maxSourceBytes?: number
}

export interface InstructionsResult {
  text: string
  files: InstructionFile[]
  truncated: boolean
}

const FILE_CANDIDATES = ['AGENTS.md', 'agent.md', 'CLAUDE.md']
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'agent.local.md', 'CLAUDE.local.md']
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576

export function globalRuobaiDir() {
  return join(homedir(), '.ruobai')
}

/** Candidate paths in the order they are merged (global, project, workspace). */
export function instructionCandidates(config: InstructionConfig) {
  const files = config.fileCandidates ?? FILE_CANDIDATES
  const locals = config.localCandidates ?? LOCAL_CANDIDATES
  const scopes: Array<{ dir: string; display: string }> = []
  if (config.globalRoot) scopes.push({ dir: config.globalRoot, display: '~/.ruobai' })
  scopes.push({ dir: join(config.root, '.ruobai'), display: '.ruobai' })
  scopes.push({ dir: config.root, display: '' })
  return scopes.flatMap(scope => [...files, ...locals].map(name => ({
    path: join(scope.dir, name),
    display: scope.display ? `${scope.display}/${name}` : name,
  })))
}

/**
 * Reads AGENTS.md / agent.md / CLAUDE.md (plus `.local.md` overlays) from the
 * user-global directory and the workspace. Identical bodies collapse into the
 * most specific occurrence; missing or unsafe files are skipped.
 */
export async function discoverInstructionFiles(config: InstructionConfig): Promise<InstructionFile[]> {
  const maxBytes = config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const files: InstructionFile[] = []
  for (const candidate of instructionCandidates(config)) {
    const content = await readInstruction(candidate.path, maxBytes)
    if (!content) continue
    files.push({
      path: candidate.path,
      display: candidate.display,
      content: content.trim(),
      bytes: Buffer.byteLength(content),
    })
  }
  return dedupeByContent(files)
}

/**
 * Keeps the last occurrence of duplicated bodies so project-level copies win.
 */
function dedupeByContent(files: InstructionFile[]) {
  const seen = new Map<string, number>()
  const keep: boolean[] = files.map(() => true)
  files.forEach((file, index) => seen.set(file.content, index))
  files.forEach((file, index) => {
    if (seen.get(file.content) !== index) keep[index] = false
  })
  return files.filter((_, index) => keep[index])
}

async function readInstruction(path: string, maxBytes: number) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return undefined
    if (info.size === 0) return undefined
    const content = await readFile(path, 'utf8')
    return content.includes('\0') ? undefined : content
  } catch {
    return undefined
  }
}

/**
 * Renders the merged instruction blocks under a character budget. Project
 * files are retained first, then global ones, and the result is restored to
 * merge order.
 */
export function renderInstructions(
  files: InstructionFile[],
  maxChars: number,
): { text: string; truncated: boolean } {
  if (!files.length || maxChars <= 0) return { text: '', truncated: files.length > 0 && maxChars <= 0 }
  const blocks = files.map(file => ({ file, text: `# Instructions from ${file.display}\n${file.content}` }))
  const kept: string[] = []
  let used = 0
  let truncated = false
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    const cost = block.text.length + (kept.length ? 2 : 0)
    if (used + cost <= maxChars) {
      kept.unshift(block.text)
      used += cost
      continue
    }
    truncated = true
    const room = maxChars - used
    if (room > 80) {
      const cut = block.text.slice(0, room - 40).replace(/\s+\S*$/, '')
      kept.unshift(`${cut}\n… (instructions truncated)`)
      used = maxChars
    }
    break
  }
  return { text: kept.join('\n\n'), truncated }
}

/** Cheap signature of the candidate files so a cached render can be reused. */
export async function instructionsSignature(config: InstructionConfig) {
  const parts: string[] = []
  for (const candidate of instructionCandidates(config)) {
    try {
      const info = await lstat(candidate.path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      parts.push(`${candidate.path}:${info.mtimeMs}:${info.size}`)
    } catch {
      // missing candidate
    }
  }
  return parts.join('|')
}

export async function loadInstructions(
  config: InstructionConfig & { maxInstructions: number; ttlMs?: number },
): Promise<InstructionsResult> {
  const files = await discoverInstructionFiles(config)
  const { text, truncated } = renderInstructions(files, config.maxInstructions)
  return { text, files, truncated }
}

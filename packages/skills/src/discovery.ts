import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { parseSkillDocument, SKILL_NAME } from './frontmatter.ts'

export type SkillSource = 'project' | 'global'

export interface SkillSummary {
  name: string
  description: string
  source: SkillSource
  /** Absolute path of the skills root this entry came from. */
  root: string
  /** Absolute path of the SKILL.md (or flat markdown) file. */
  path: string
  bundle: boolean
  userInvocable: boolean
  modelInvocable: boolean
}

export interface SkillRecord extends SkillSummary {
  bodyPath: string
  bundleDir?: string
}

export interface SkillRoot {
  path: string
  source: SkillSource
}

export interface DiscoveryOptions {
  maxSkills?: number
  maxSkillBytes?: number
}

/**
 * Search order: project `.ruobai`, `.claude`, `.agents`, then the same three
 * under the user home. Earlier roots win name conflicts.
 */
export function skillRoots(workspaceRoot: string, globalRoot: string, homeDir = homedir()): SkillRoot[] {
  return [
    { path: join(workspaceRoot, '.ruobai', 'skills'), source: 'project' },
    { path: join(workspaceRoot, '.claude', 'skills'), source: 'project' },
    { path: join(workspaceRoot, '.agents', 'skills'), source: 'project' },
    { path: join(globalRoot, 'skills'), source: 'global' },
    { path: join(homeDir, '.claude', 'skills'), source: 'global' },
    { path: join(homeDir, '.agents', 'skills'), source: 'global' },
  ]
}

export async function discoverSkills(
  roots: SkillRoot[],
  options: DiscoveryOptions = {},
): Promise<SkillRecord[]> {
  const maxSkills = options.maxSkills ?? 200
  const maxBytes = options.maxSkillBytes ?? 262_144
  const found = new Map<string, SkillRecord>()

  for (const root of roots) {
    if (found.size >= maxSkills) break
    const entries = await readdir(root.path, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory())
      || left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (found.size >= maxSkills) break
      if (entry.isSymbolicLink()) continue
      const record = entry.isDirectory()
        ? await fromBundle(root, entry.name, maxBytes)
        : entry.isFile() && extname(entry.name).toLowerCase() === '.md'
          ? await fromFlatFile(root, entry.name, maxBytes)
          : undefined
      if (!record || found.has(record.name)) continue
      found.set(record.name, record)
    }
  }

  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function fromBundle(root: SkillRoot, dirName: string, maxBytes: number): Promise<SkillRecord | undefined> {
  const bundleDir = join(root.path, dirName)
  const bodyPath = join(bundleDir, 'SKILL.md')
  const body = await readSkillFile(bodyPath, maxBytes)
  if (body === undefined) return undefined
  return toRecord(root, body, bodyPath, dirName, true, bundleDir)
}

async function fromFlatFile(root: SkillRoot, fileName: string, maxBytes: number): Promise<SkillRecord | undefined> {
  if (fileName === 'SKILL.md') return undefined
  const bodyPath = join(root.path, fileName)
  const body = await readSkillFile(bodyPath, maxBytes)
  if (body === undefined) return undefined
  return toRecord(root, body, bodyPath, fileName.slice(0, -extname(fileName).length), false)
}

function toRecord(
  root: SkillRoot,
  raw: string,
  bodyPath: string,
  fallbackName: string,
  bundle: boolean,
  bundleDir?: string,
): SkillRecord | undefined {
  const { meta, body } = parseSkillDocument(raw)
  const name = (meta.name ?? fallbackName).toLowerCase()
  if (!SKILL_NAME.test(name)) return undefined
  if (!meta.description) return undefined
  return {
    name,
    description: meta.description,
    source: root.source,
    root: root.path,
    path: bodyPath,
    bodyPath,
    bundle,
    ...(bundleDir ? { bundleDir } : {}),
    userInvocable: meta.userInvocable,
    modelInvocable: !meta.disableModelInvocation,
  }
}

async function readSkillFile(path: string, maxBytes: number) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return undefined
    const raw = await readFile(path, 'utf8')
    return raw.includes('\0') ? undefined : raw
  } catch {
    return undefined
  }
}

export async function readSkillBody(record: SkillRecord, maxBytes: number) {
  const raw = await readSkillFile(record.bodyPath, maxBytes)
  if (raw === undefined) return undefined
  return parseSkillDocument(raw).body
}

/** Relative paths of the files shipped next to a bundled SKILL.md. */
export async function listResources(record: SkillRecord, limit = 50): Promise<string[]> {
  const bundleDir = record.bundleDir
  if (!bundleDir) return []
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= limit || depth > 3) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= limit || entry.isSymbolicLink()) continue
      const target = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(target, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = relative(bundleDir, target).split(sep).join('/')
      if (relativePath === 'SKILL.md') continue
      files.push(relativePath)
    }
  }
  await walk(bundleDir, 0)
  return files
}

/** Reads one bundled resource, confined to the skill's own directory. */
export async function readResource(record: SkillRecord, file: string, maxBytes: number) {
  const bundleDir = record.bundleDir
  if (!bundleDir) return undefined
  const normalized = file.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return undefined
  const target = resolve(bundleDir, normalized)
  const base = `${resolve(bundleDir)}${sep}`
  if (!target.startsWith(base)) return undefined
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return undefined
    const raw = await readFile(target, 'utf8')
    return raw.includes('\0') ? undefined : raw
  } catch {
    return undefined
  }
}

export function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

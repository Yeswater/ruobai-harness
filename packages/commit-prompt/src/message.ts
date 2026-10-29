/**
 * Composing the commit message the card offers.
 *
 * The point of the card is that the *user* does not have to compose anything:
 * the subject comes from what is already on hand — the session title the user
 * wrote and the paths git reports. No model call, so opening the card costs no
 * tokens and no waiting.
 */

export interface ChangeLike {
  path: string
  index?: string
  worktree?: string
  untracked?: boolean
}

/**
 * Paths the harness never commits.
 *
 * AGENTS.md forbids them for a person; a generated commit must not quietly do
 * what the rule forbids either. They are the harness's own runtime state
 * (`.sessions/`, `.ruobai/`), editor scratch and build output — all of which
 * live inside the workspace and therefore show up in `git status`.
 */
const IGNORED_PREFIXES = [
  '.ruobai/',
  '.sessions/',
  '.idea/',
  '.vscode/',
  '.claude/',
  'node_modules/',
  'dist/',
]

const IGNORED_FILES = new Set(['.env', '.env.local', '.env.production', '.DS_Store'])
const IGNORED_SUFFIXES = ['.key', '.pem']

/** True when the path must stay out of the commit the card proposes. */
export function ignoredPath(path: string) {
  if (!path) return true
  if (IGNORED_FILES.has(path)) return true
  if (IGNORED_SUFFIXES.some(suffix => path.endsWith(suffix))) return true
  // Directories can sit at any depth (`packages/x/dist/`).
  return IGNORED_PREFIXES.some(prefix =>
    path.startsWith(prefix) || path.includes(`/${prefix}`))
}

/** Split the dirty tree into what may be committed and what must not. */
export function partitionChanges<T extends ChangeLike>(changes: T[]) {
  const kept: T[] = []
  const skipped: T[] = []
  for (const change of changes) {
    if (ignoredPath(change.path)) skipped.push(change)
    else kept.push(change)
  }
  return { kept, skipped }
}

export type CommitType = 'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore'

/** Repo furniture: changing only these is housekeeping, not a behaviour change. */
const CONFIG_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.yml',
  'biome.json',
  'tsconfig.json',
  '.gitignore',
  '.editorconfig',
])

const CONFIG_PATTERN = /^(tsconfig(\..+)?\.json|\.github\/|\.vscode\/|\.idea\/)/

const DOC_PATTERN = /(^|\/)docs?\//i
const DOC_EXT = /\.(md|mdx)$/i
const TEST_PATTERN = /(^|\/)tests?\//
const TEST_FILE = /\.(spec|test)\.[a-z]+$/i

const REFACTOR = /重构|拆分|抽出|整理|重命名|迁移/
const FIX = /修复|修好|修正|修一|bug|问题|错误|失败|报错|不生效|不工作|无法|没有|缺|丢失|卡住|重复/
const FEAT = /新增|支持|实现|加上|增加|做一|做一版|引入|打通|接入/

const MAX_SUBJECT = 52

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path
}

function isConfig(path: string) {
  return CONFIG_FILES.has(path) || CONFIG_PATTERN.test(path)
}

function normalize(title: string | undefined) {
  const text = (title ?? '').replace(/\s+/g, ' ').trim()
  // `New session` is the placeholder; it names nothing about the change.
  return text === '' || text === 'New session' ? '' : text
}

function clip(text: string, limit = MAX_SUBJECT) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Which conventional type the change most likely is.
 *
 * Paths are the reliable signal: a README-only or tests-only diff says `docs`
 * or `test` regardless of what the title claims. Only when the paths are mixed
 * does the title's own wording decide.
 */
export function inferType(title: string | undefined, changes: ChangeLike[]): CommitType {
  const paths = changes.map(change => change.path).filter(Boolean)
  if (!paths.length) return 'chore'
  if (paths.every(path => DOC_PATTERN.test(path) || DOC_EXT.test(path))) return 'docs'
  if (paths.every(path => TEST_PATTERN.test(path) || TEST_FILE.test(path))) return 'test'
  if (paths.every(isConfig)) return 'chore'

  const text = normalize(title)
  if (REFACTOR.test(text)) return 'refactor'
  if (FIX.test(text)) return 'fix'
  if (FEAT.test(text)) return 'feat'
  // Nothing in the wording: new files mean something was added, otherwise the
  // honest default for edited code is a fix.
  const added = changes.some(change =>
    change.untracked || change.index === 'A' || change.worktree === 'A')
  return added ? 'feat' : 'fix'
}

/**
 * The two segments that identify where a change lives: `packages/ui-app`,
 * `apps/cli`, or the top-level directory for anything else.
 */
function areaOf(path: string) {
  const parts = path.split('/').filter(Boolean)
  if ((parts[0] === 'packages' || parts[0] === 'apps') && parts.length > 1) {
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0] ?? path
}

/** "packages/ui-app、docs": the widest areas, most-changed first. */
export function scopeOf(changes: ChangeLike[], limit = 2) {
  const counts = new Map<string, number>()
  for (const change of changes) {
    if (!change.path) continue
    const area = areaOf(change.path)
    counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([area]) => area)
    .join('、')
}

export interface ProposedMessage {
  /** The one the card starts with. */
  message: string
  /** Every phrasing worth offering as a one-click choice, best first. */
  candidates: string[]
}

/**
 * The message plus the alternatives the card shows as chips.
 *
 * The first candidate repeats the user's own words ("修复 输入框有两个输入按钮
 * 问题"), the second falls back to the shape of the diff. Both stay under the
 * subject limit so `git log --oneline` does not wrap.
 */
export function proposeMessage(input: { title?: string; changes: ChangeLike[] }): ProposedMessage {
  const changes = input.changes.filter(change => change.path)
  const type = inferType(input.title, changes)
  const title = normalize(input.title)
  const scope = scopeOf(changes)
  const count = changes.length

  const fromTitle = title ? `${type}: ${clip(title)}` : ''
  const fromScope = scope
    ? `${type}: 更新 ${scope}${count > 1 ? `（${count} 个文件）` : ''}`
    : `${type}: 更新 ${count} 个文件`
  const fromSingle = count === 1 && !title
    ? `${type}: 修改 ${basename(changes[0]!.path)}`
    : ''

  const candidates = [...new Set([fromTitle || fromScope, fromScope, fromSingle].filter(Boolean))]
  return { message: candidates[0]!, candidates }
}

/** One-line summary of the diff, e.g. `5 个文件 · +120 −34`. */
export function describeChanges(changes: ChangeLike[], stat?: { add: number; del: number }) {
  const parts = [`${changes.length} 个文件`]
  if (stat && (stat.add || stat.del)) parts.push(`+${stat.add} −${stat.del}`)
  return parts.join(' · ')
}

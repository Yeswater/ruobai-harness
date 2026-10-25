import type { GitChange, GitCommit } from '@ruobai/git/types'

export type ChangeSide = 'staged' | 'working'

export interface ChangeEntry {
  change: GitChange
  side: ChangeSide
}

export interface ChangeGroups {
  conflicted: ChangeEntry[]
  staged: ChangeEntry[]
  unstaged: ChangeEntry[]
}

export function groupChanges(changes: GitChange[]): ChangeGroups {
  return {
    conflicted: changes.filter(change => change.conflicted)
      .map(change => ({ change, side: 'working' as const })),
    staged: changes.filter(change => change.staged && !change.conflicted)
      .map(change => ({ change, side: 'staged' as const })),
    unstaged: changes.filter(change => change.unstaged && !change.conflicted)
      .map(change => ({ change, side: 'working' as const })),
  }
}

/** Single-letter status for one side of a change. */
export function statusOf(change: GitChange, side: ChangeSide) {
  if (change.untracked) return '?'
  const raw = side === 'staged' ? change.index : change.worktree
  return !raw || raw === '.' ? 'M' : raw
}

export function statOf(change: GitChange, side: ChangeSide) {
  return (side === 'staged' ? change.stagedStat : change.worktreeStat)
    ?? (change.untracked ? change.worktreeStat : undefined)
}

export function statusClass(letter: string) {
  if (letter === 'A' || letter === '?') return 'add'
  if (letter === 'D') return 'del'
  if (letter === 'R' || letter === 'C') return 'ren'
  return 'mod'
}

export function statusTitle(letter: string) {
  switch (letter) {
    case 'A': return '新增'
    case 'D': return '删除'
    case 'R': return '重命名'
    case 'C': return '复制'
    case 'U': return '冲突'
    case '?': return '未跟踪'
    case 'T': return '类型变更'
    default: return '修改'
  }
}

export interface PathTree<T> {
  name: string
  path: string
  children: PathTree<T>[]
  items: T[]
}

/** Group flat paths into a directory tree, sorted by name. */
export function buildPathTree<T>(items: T[], getPath: (item: T) => string): PathTree<T> {
  const root: PathTree<T> = { name: '', path: '', children: [], items: [] }
  for (const item of items) {
    const parts = getPath(item).split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let child = node.children.find(entry => entry.name === part)
      if (!child) {
        child = {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          children: [],
          items: [],
        }
        node.children.push(child)
      }
      node = child
    }
    node.items.push(item)
  }
  const sort = (node: PathTree<T>) => {
    node.children.sort((left, right) => left.name.localeCompare(right.name))
    node.children.forEach(sort)
  }
  sort(root)
  return root
}

export interface PathNode {
  name: string
  path: string
  children: PathNode[]
  entries: ChangeEntry[]
}

/** Directory tree for the change lists. */
export function buildTree(entries: ChangeEntry[]): PathNode {
  const convert = (node: PathTree<ChangeEntry>): PathNode => ({
    name: node.name,
    path: node.path,
    children: node.children.map(convert),
    entries: node.items,
  })
  return convert(buildPathTree(entries, entry => entry.change.path))
}

export function entryKey(entry: ChangeEntry) {
  return `${entry.side}:${entry.change.path}`
}

export function descendants(node: PathNode): ChangeEntry[] {
  return [...node.entries, ...node.children.flatMap(descendants)]
}

export function countDiff(diff?: string) {
  let added = 0
  let removed = 0
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta' | 'hunk'

export interface DiffLine {
  text: string
  kind: DiffLineKind
  oldLine?: number
  newLine?: number
}

/** Split a unified diff into rows that carry both sides' line numbers. */
export function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const text of diff.split('\n')) {
    if (text.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
      oldLine = match ? Number(match[1]) : 0
      newLine = match ? Number(match[2]) : 0
      lines.push({ text, kind: 'hunk' })
      continue
    }
    if (
      text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('--- ')
      || text.startsWith('+++ ') || text.startsWith('new file mode') || text.startsWith('deleted file mode')
      || text.startsWith('similarity index') || text.startsWith('rename from') || text.startsWith('rename to')
      || text.startsWith('old mode') || text.startsWith('new mode') || text.startsWith('\\ No newline')
    ) {
      lines.push({ text, kind: 'meta' })
      continue
    }
    if (text.startsWith('+')) {
      lines.push({ text, kind: 'add', newLine })
      newLine += 1
      continue
    }
    if (text.startsWith('-')) {
      lines.push({ text, kind: 'del', oldLine })
      oldLine += 1
      continue
    }
    lines.push({
      text,
      kind: 'context',
      oldLine: oldLine || undefined,
      newLine: newLine || undefined,
    })
    oldLine += 1
    newLine += 1
  }
  return lines
}

export function relativeTime(iso: string) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} 个月前`
  return new Date(at).toLocaleDateString()
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag' | 'other'

export function parseRef(ref: string, remotes: string[]) {
  if (ref.startsWith('HEAD -> ')) return { kind: 'head' as RefKind, label: ref.slice(8), head: true }
  if (ref === 'HEAD') return { kind: 'head' as RefKind, label: 'HEAD', head: true }
  if (ref.startsWith('tag: ')) return { kind: 'tag' as RefKind, label: ref.slice(5), head: false }
  if (remotes.some(remote => ref.startsWith(`${remote}/`))) {
    return { kind: 'remote' as RefKind, label: ref, head: false }
  }
  return { kind: 'local' as RefKind, label: ref, head: false }
}

export interface GraphSegment {
  /** Lane x positions, in lane units; renderers multiply by the lane width. */
  x1: number
  y1: number
  x2: number
  y2: number
  color: number
}

export interface GraphRow {
  width: number
  dot: number
  segments: GraphSegment[]
}

/**
 * Lane layout computed from `parents` alone: each commit claims the lane that
 * already expected it, and its first parent inherits that lane while merge
 * parents branch off to the right. Deterministic across pagination.
 */
export function computeGraph(commits: GitCommit[]): GraphRow[] {
  let lanes: Array<string | null> = []
  const rows: GraphRow[] = []

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = lanes.indexOf(null)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(commit.hash)
      } else {
        lanes[lane] = commit.hash
      }
    }

    const before = [...lanes]
    const next = [...lanes]
    next[lane] = commit.parents[0] ?? null

    const parentLanes: number[] = []
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        parentLanes.push(lane)
        return
      }
      let at = next.indexOf(parent)
      if (at === -1) {
        at = next.indexOf(null)
        if (at === -1) {
          at = next.length
          next.push(parent)
        } else {
          next[at] = parent
        }
      }
      parentLanes.push(at)
    })

    const width = Math.max(before.length, next.length, lane + 1, ...parentLanes.map(item => item + 1))
    const segments: GraphSegment[] = []
    for (let index = 0; index < width; index += 1) {
      if (index === lane) continue
      if (before[index] || next[index]) {
        segments.push({ x1: index, y1: 0, x2: index, y2: 1, color: index })
      }
    }
    // The commit's own lane runs through the dot to its first parent.
    segments.push({ x1: lane, y1: 0, x2: lane, y2: 1, color: lane })
    parentLanes.slice(1).forEach((parentLane) => {
      segments.push({
        x1: lane,
        y1: 0.5,
        x2: parentLane,
        y2: 1,
        color: parentLane,
      })
    })

    rows.push({ width, dot: lane, segments })
    lanes = next
  }
  return rows
}

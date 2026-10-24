import type { SessionSummary } from '@ruobai/chat-protocol'

export type GroupBy = 'workspace' | 'tree' | 'flat'
export type OrderBy = 'manual' | 'updated'
export type ArchiveFilter = 'active' | 'all' | 'archived'

export interface SidebarView {
  groupBy: GroupBy
  orderBy: OrderBy
  filter: ArchiveFilter
}

export const DEFAULT_VIEW: SidebarView = {
  groupBy: 'workspace',
  orderBy: 'updated',
  filter: 'active',
}

/** Group key for sessions created without a workspace folder. */
export const UNGROUPED_KEY = ''
export const UNGROUPED_LABEL = '未分组'
/** Group key for the flat "单列表" list's manual order. */
export const FLAT_KEY = '__flat__'

export interface SessionGroup {
  key: string
  label: string
  /** Absolute folder path; absent for the ungrouped bucket. */
  path?: string
  /** Nesting level in tree mode. */
  depth: number
  /** Sessions in this folder (already filtered and ordered). */
  sessions: SessionSummary[]
  /** The folder can host a new session. */
  canCreate: boolean
  /** Intermediate tree folders only fold; workspace folders also list sessions. */
  folder: boolean
}

export type ManualOrder = Record<string, string[]>

export function basename(path: string) {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path
}

function archiveVisible(session: SessionSummary, filter: ArchiveFilter) {
  if (filter === 'active') return !session.archived
  if (filter === 'archived') return Boolean(session.archived)
  return true
}

export function filterSessions(
  sessions: SessionSummary[],
  filter: ArchiveFilter,
  query: string,
): SessionSummary[] {
  const term = query.trim().toLowerCase()
  return sessions.filter((session) => {
    if (!archiveVisible(session, filter)) return false
    if (!term) return true
    return session.title.toLowerCase().includes(term)
      || (session.workspace?.toLowerCase().includes(term) ?? false)
  })
}

function byRecency(a: SessionSummary, b: SessionSummary) {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1)
}

/** Apply the stored manual order, then append new sessions newest-first. */
export function orderSessions(
  sessions: SessionSummary[],
  orderBy: OrderBy,
  stored?: readonly string[],
): SessionSummary[] {
  if (orderBy === 'updated' || !stored?.length) return [...sessions].sort(byRecency)
  const byId = new Map(sessions.map(session => [session.id, session]))
  const seen = new Set<string>()
  const ordered: SessionSummary[] = []
  for (const id of stored) {
    const session = byId.get(id)
    if (!session || seen.has(id)) continue
    seen.add(id)
    ordered.push(session)
  }
  const fresh = sessions.filter(session => !seen.has(session.id)).sort(byRecency)
  return [...fresh, ...ordered]
}

function group(path: string, label: string, sessions: SessionSummary[], depth = 0): SessionGroup {
  return { key: path, label, path: path || undefined, depth, sessions, canCreate: true, folder: true }
}

function groupByWorkspace(
  sessions: SessionSummary[],
  view: SidebarView,
  orders: ManualOrder,
): SessionGroup[] {
  const buckets = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const key = session.workspace ?? UNGROUPED_KEY
    const list = buckets.get(key) ?? []
    list.push(session)
    buckets.set(key, list)
  }
  const groups = [...buckets.entries()].map(([key, list]) => group(
    key,
    key ? basename(key) : UNGROUPED_LABEL,
    orderSessions(list, view.orderBy, orders[key]),
  ))
  const latest = (item: SessionGroup) => item.sessions[0]?.updatedAt ?? 0
  return groups.sort((a, b) => {
    if (a.key === UNGROUPED_KEY) return 1
    if (b.key === UNGROUPED_KEY) return -1
    return latest(b) - latest(a) || a.label.localeCompare(b.label)
  })
}

interface TreeNode {
  path: string
  label: string
  sessions: SessionSummary[]
  children: Map<string, TreeNode>
}

function splitPath(path: string) {
  return path.split(/[/\\]+/).filter(Boolean)
}

function longestCommon(prefixes: string[][]) {
  if (!prefixes.length) return []
  const first = prefixes[0]!
  const common: string[] = []
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index]!
    if (prefixes.every(parts => parts[index] === segment)) common.push(segment)
    else break
  }
  return common
}

function groupByTree(
  sessions: SessionSummary[],
  view: SidebarView,
  orders: ManualOrder,
): SessionGroup[] {
  const buckets = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const key = session.workspace ?? UNGROUPED_KEY
    const list = buckets.get(key) ?? []
    list.push(session)
    buckets.set(key, list)
  }

  const workspacePaths = [...buckets.keys()].filter(Boolean)
  const ungrouped = buckets.get(UNGROUPED_KEY) ?? []
  const groups: SessionGroup[] = []
  if (!workspacePaths.length) {
    if (ungrouped.length) {
      groups.push(group(UNGROUPED_KEY, UNGROUPED_LABEL, orderSessions(ungrouped, view.orderBy, orders[UNGROUPED_KEY])))
    }
    return groups
  }

  const absolute = workspacePaths.every(path => path.startsWith('/'))
  const parts = workspacePaths.map(splitPath)
  const common = longestCommon(parts)
  const rootPath = `${absolute ? '/' : ''}${common.join('/')}` || (absolute ? '/' : '.')

  const root: TreeNode = { path: rootPath, label: basename(rootPath) || rootPath, sessions: [], children: new Map() }
  for (const [index, path] of workspacePaths.entries()) {
    const rest = parts[index]!.slice(common.length)
    let node = root
    if (!rest.length) {
      node.sessions = buckets.get(path) ?? []
      continue
    }
    for (const segment of rest) {
      let child = node.children.get(segment)
      if (!child) {
        const childPath = node.path === '/' ? `/${segment}` : `${node.path}/${segment}`
        child = { path: childPath, label: segment, sessions: [], children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    node.sessions = buckets.get(path) ?? []
  }

  const emit = (node: TreeNode, depth: number) => {
    const ordered = orderSessions(node.sessions, view.orderBy, orders[node.path])
    const isWorkspace = Boolean(node.path) && workspacePaths.includes(node.path)
    if (isWorkspace || ordered.length || node.children.size) {
      groups.push({
        key: node.path,
        label: node.label,
        path: node.path,
        depth,
        sessions: ordered,
        canCreate: isWorkspace,
        folder: true,
      })
    }
    const children = [...node.children.values()].sort((a, b) => a.label.localeCompare(b.label))
    for (const child of children) emit(child, depth + 1)
  }

  // The common ancestor is an implied folder, not a workspace: render its
  // children at the top level instead of wasting a nesting level on it.
  if (root.sessions.length) emit(root, 0)
  else {
    const children = [...root.children.values()].sort((a, b) => a.label.localeCompare(b.label))
    for (const child of children) emit(child, 0)
  }

  if (ungrouped.length) {
    groups.push(group(UNGROUPED_KEY, UNGROUPED_LABEL, orderSessions(ungrouped, view.orderBy, orders[UNGROUPED_KEY])))
  }
  return groups
}

export function groupSessions(
  sessions: SessionSummary[],
  view: SidebarView,
  orders: ManualOrder = {},
): SessionGroup[] {
  if (view.groupBy === 'flat') {
    return [{
      key: FLAT_KEY,
      label: '',
      depth: 0,
      sessions: orderSessions(sessions, view.orderBy, orders[FLAT_KEY]),
      canCreate: false,
      folder: false,
    }]
  }
  if (view.groupBy === 'tree') return groupByTree(sessions, view, orders)
  return groupByWorkspace(sessions, view, orders)
}

/** Ancestor folder keys of a tree group, nearest first. */
export function ancestorKeys(path: string | undefined) {
  if (!path) return []
  const parts = splitPath(path)
  const keys: string[] = []
  for (let index = parts.length - 1; index > 0; index -= 1) {
    keys.push(`${path.startsWith('/') ? '/' : ''}${parts.slice(0, index).join('/')}`)
  }
  return keys
}

/** Move `source` next to `target`; a no-op when both are the same row. */
export function moveSession(
  ids: readonly string[],
  source: string,
  target: string,
  half: 'before' | 'after',
): string[] {
  if (source === target) return [...ids]
  const next = ids.filter(id => id !== source)
  const index = next.indexOf(target)
  if (index === -1) return [...ids]
  next.splice(half === 'before' ? index : index + 1, 0, source)
  return next
}

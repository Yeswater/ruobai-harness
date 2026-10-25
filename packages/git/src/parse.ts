import type {
  GitBranch, GitChange, GitCommit, GitCommitFile, GitFileStat,
} from './types.ts'

const FIELD = '\0'
const RECORD = '\u001e'

/** Trim a git failure down to the one line worth showing a user. */
export function errorLine(stderr: string, fallback: string) {
  const line = stderr
    .split('\n')
    .map(item => item.trim())
    .find(item => item && !item.startsWith('hint:'))
  return (line ?? fallback).replace(/^(fatal|error):\s*/i, '').slice(0, 300)
}

interface ChangeSides {
  path: string
  origPath?: string
  index: string
  worktree: string
  untracked?: boolean
  conflicted?: boolean
}

/**
 * `git status --porcelain=v2 -z -uall`: one NUL-terminated record per path.
 * Header fields are space-separated; the path is the remainder, so paths with
 * spaces survive intact. Renames append the original path as a second token.
 */
export function parseStatus(output: string): GitChange[] {
  const tokens = output.split(FIELD)
  const changes = new Map<string, ChangeSides>()

  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index]
    if (!record) continue
    const kind = record[0]

    if (kind === '1' || kind === '2') {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const path = (kind === '1' ? parts.slice(8) : parts.slice(9)).join(' ')
      if (!path) continue
      changes.set(path, {
        path,
        origPath: kind === '2' ? tokens[++index] : undefined,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
      })
      continue
    }
    if (kind === 'u') {
      const path = record.split(' ').slice(10).join(' ')
      if (path) changes.set(path, { path, index: 'U', worktree: 'U', conflicted: true })
      continue
    }
    if (kind === '?') {
      const path = record.slice(2)
      if (path) changes.set(path, { path, index: '?', worktree: '?', untracked: true })
    }
  }

  return [...changes.values()]
    .map(change => ({
      ...change,
      untracked: Boolean(change.untracked),
      conflicted: Boolean(change.conflicted),
      staged: !change.untracked && change.index !== '.',
      unstaged: change.untracked || change.worktree !== '.',
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** `--numstat -z`: `added\tremoved\tpath` per file; renames carry two paths. */
export function parseNumstat(output: string): Map<string, GitFileStat> {
  const stats = new Map<string, GitFileStat>()
  const tokens = output.split(FIELD)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    const [rawAdded, rawRemoved, path] = token.split('\t')
    if (rawAdded === undefined || rawRemoved === undefined) continue
    // A rename leaves the path empty; the next two tokens are old and new.
    const target = path || tokens[index + 2]
    if (!path) index += 2
    if (!target) continue
    const added = Number(rawAdded)
    const removed = Number(rawRemoved)
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue
    stats.set(target, { added, removed })
  }
  return stats
}

/** Merge parsed numstat maps into status changes, per side. */
export function attachStats(
  changes: GitChange[],
  staged: Map<string, GitFileStat>,
  worktree: Map<string, GitFileStat>,
) {
  for (const change of changes) {
    const stagedStat = staged.get(change.path)
    const worktreeStat = worktree.get(change.path)
    if (stagedStat) change.stagedStat = stagedStat
    if (worktreeStat) change.worktreeStat = worktreeStat
  }
  return changes
}

function parseRefs(decoration: string) {
  return decoration.split(', ').map(item => item.trim()).filter(Boolean)
}

/**
 * One commit per `\u001e`-terminated record, fields separated by NUL:
 * hash, short hash, parents, author, email, ISO date, refs, subject.
 */
export function parseLog(output: string): GitCommit[] {
  return output
    .split(RECORD)
    .map(record => record.trimStart())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, parents, author, email, date, refs, subject] = record.split(FIELD)
      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        author: author ?? '',
        email: email ?? '',
        date: date ?? '',
        subject: subject ?? '',
        refs: parseRefs(refs ?? ''),
      }
    })
    .filter(commit => commit.hash)
}

/** `%(upstream:track)` → `[ahead 1, behind 2]`, `[gone]` or empty. */
export function parseTrack(track: string) {
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.includes('gone'),
  }
}

/**
 * `for-each-ref` records, one per line, NUL-separated:
 * short name, full name, upstream, upstream track, HEAD marker, object hash.
 */
export function parseBranches(output: string, remotePrefixes: string[]): GitBranch[] {
  const branches: GitBranch[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const [name = '', , upstream = '', track = '', head = ''] = line.split(FIELD)
    if (!name || name === 'HEAD' || name.endsWith('/HEAD')) continue
    const { ahead, behind, gone } = parseTrack(track)
    branches.push({
      name,
      remote: remotePrefixes.some(prefix => name.startsWith(`${prefix}/`)),
      current: head.trim() === '*',
      upstream: upstream || undefined,
      ahead,
      behind,
      gone,
    })
  }
  return branches.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    if (left.remote !== right.remote) return left.remote ? 1 : -1
    return left.name.localeCompare(right.name)
  })
}

/** `diff-tree --name-status -z` tokens: status, then one or two paths. */
export function parseNameStatus(output: string): Array<{ path: string; origPath?: string; status: string }> {
  const tokens = output.split(FIELD).filter(Boolean)
  const files: Array<{ path: string; origPath?: string; status: string }> = []
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index]
    if (!/^[A-Z]\d*$/.test(status)) continue
    const letter = status[0]!
    if (letter === 'R' || letter === 'C') {
      const origPath = tokens[++index]
      const path = tokens[++index]
      if (path) files.push({ path, origPath, status: letter })
    } else {
      const path = tokens[++index]
      if (path) files.push({ path, status: letter })
    }
  }
  return files
}

export function parseCommitFiles(nameStatus: string, numstat: string): GitCommitFile[] {
  const stats = parseNumstat(numstat)
  return parseNameStatus(nameStatus)
    .map(file => ({
      ...file,
      added: stats.get(file.path)?.added ?? 0,
      removed: stats.get(file.path)?.removed ?? 0,
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

/** True when a patch only contains git's binary marker. */
export function isBinaryDiff(diff: string) {
  return /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff)
}

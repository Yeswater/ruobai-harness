import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Service, type Context } from '@ruobai/cordis'
import z from '@ruobai/schemastery'
import {
  attachStats, errorLine, isBinaryDiff, parseBranches, parseCommitFiles, parseLog,
  parseNumstat, parseStatus,
} from './parse.ts'
import type {
  GitBranch, GitChange, GitCommitDetail, GitCommitResult, GitDiffResult, GitFileStat,
  GitInfo, GitLogQuery, GitLogResult, GitOperation, GitSyncResult,
} from './types.ts'

export * from './types.ts'

const exec = promisify(execFile)
const MAX_DIFF_CHARS = 400_000
const MAX_PATHS = 500

const LOG_FORMAT = '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x1e'

export class GitError extends Error {
  constructor(message: string, public detail = '', public status = 400) {
    super(message)
  }
}

export interface Config {
  /** Timeout for local commands. */
  timeoutMs?: number
  /** Timeout for fetch, pull and push. */
  networkTimeoutMs?: number
  maxOutputBytes?: number
}

/** Git plumbing shared by the HTTP adapter; every method takes a work-tree root. */
export class GitService extends Service {
  static Config: z<Config> = z.object({
    timeoutMs: z.number().min(1_000).default(15_000),
    networkTimeoutMs: z.number().min(1_000).default(120_000),
    maxOutputBytes: z.number().min(65_536).default(8_000_000),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'git')
  }

  private async run(
    root: string,
    args: string[],
    options: { network?: boolean; keepStdoutOnError?: boolean } = {},
  ) {
    try {
      const { stdout } = await exec('git', ['--literal-pathspecs', '-C', root, ...args], {
        timeout: options.network ? this.config.networkTimeoutMs : this.config.timeoutMs,
        maxBuffer: this.config.maxOutputBytes,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
        windowsHide: true,
      })
      return stdout
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
      if (options.keepStdoutOnError && failure.stdout) return failure.stdout
      if (failure.killed) throw new GitError('git 命令超时', '', 504)
      const stderr = failure.stderr ?? ''
      throw new GitError(errorLine(stderr, failure.message ?? 'git 命令失败'), stderr)
    }
  }

  private async isRepo(root: string) {
    try {
      return (await this.run(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
    } catch {
      return false
    }
  }

  /** Current branch, or a detached marker, or null before the first commit. */
  async currentBranch(root: string) {
    try {
      return { branch: (await this.run(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), detached: false }
    } catch {
      try {
        const head = (await this.run(root, ['rev-parse', '--short', 'HEAD'])).trim()
        return { branch: head || null, detached: true }
      } catch {
        return { branch: null, detached: false }
      }
    }
  }

  private async upstreamOf(root: string) {
    try {
      return (await this.run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
    } catch {
      return ''
    }
  }

  private async divergence(root: string) {
    try {
      const output = (await this.run(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim()
      const [behind, ahead] = output.split(/\s+/).map(Number)
      if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { ahead: 0, behind: 0 }
      return { ahead: ahead!, behind: behind! }
    } catch {
      return { ahead: 0, behind: 0 }
    }
  }

  private async operation(root: string): Promise<GitOperation> {
    const probes: Array<[string, GitOperation]> = [
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['MERGE_HEAD', 'merge'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['BISECT_LOG', 'bisect'],
    ]
    for (const [name, operation] of probes) {
      try {
        const path = (await this.run(root, ['rev-parse', '--git-path', name])).trim()
        if (path && existsSync(resolve(root, path))) return operation
      } catch {
        // A probe that cannot resolve simply means the operation is absent.
      }
    }
    return 'clean'
  }

  /** Info and file list from one status scan, for the source-control panel. */
  async status(root: string): Promise<{ info: GitInfo; changes: GitChange[] }> {
    const changes = await this.changes(root).catch(() => [])
    return { info: await this.info(root, changes), changes }
  }

  async info(root: string, known?: GitChange[]): Promise<GitInfo> {
    const base: GitInfo = {
      available: false,
      workspace: root,
      home: homedir(),
      branch: null,
      detached: false,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: 0,
      added: 0,
      removed: 0,
      operation: 'clean',
    }
    if (!(await this.isRepo(root))) return base

    const { branch, detached } = await this.currentBranch(root)
    const [upstream, changes, operation] = await Promise.all([
      this.upstreamOf(root),
      known ? Promise.resolve(known) : this.changes(root).catch(() => []),
      this.operation(root),
    ])
    const { ahead, behind } = upstream ? await this.divergence(root) : { ahead: 0, behind: 0 }
    const head = await this.run(root, ['rev-parse', 'HEAD']).then(out => out.trim()).catch(() => '')
    const totals = await this.totals(root, changes)
    return {
      ...base,
      available: true,
      branch,
      detached,
      head: head || null,
      upstream: upstream || null,
      ahead,
      behind,
      files: changes.length,
      added: totals.added,
      removed: totals.removed,
      operation,
    }
  }

  private async totals(root: string, changes: GitChange[]) {
    let added = 0
    let removed = 0
    const collect = (stats: Map<string, GitFileStat>) => {
      for (const stat of stats.values()) {
        added += stat.added
        removed += stat.removed
      }
    }
    const combined = await this.run(root, ['diff', 'HEAD', '--numstat', '-z'])
      .then(output => output)
      .catch(() => '')
    if (combined.trim()) {
      collect(parseNumstat(combined))
    } else {
      const [staged, worktree] = await Promise.all([
        this.run(root, ['diff', '--cached', '--numstat', '-z']).catch(() => ''),
        this.run(root, ['diff', '--numstat', '-z']).catch(() => ''),
      ])
      collect(parseNumstat(staged))
      collect(parseNumstat(worktree))
    }
    for (const change of changes) {
      if (!change.untracked) continue
      const value = change.worktreeStat
      if (value) {
        added += value.added
        removed += value.removed
      }
    }
    return { added, removed }
  }

  /** Working-tree state split into its index and worktree sides. */
  async changes(root: string): Promise<GitChange[]> {
    const output = await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
    const changes = parseStatus(output)
    const [staged, worktree] = await Promise.all([
      this.run(root, ['diff', '--cached', '--numstat', '-z']).catch(() => ''),
      this.run(root, ['diff', '--numstat', '-z']).catch(() => ''),
    ])
    attachStats(changes, parseNumstat(staged), parseNumstat(worktree))
    if (changes.length <= 200) {
      await Promise.all(changes.filter(change => change.untracked).map(async (change) => {
        change.worktreeStat = await untrackedStat(resolve(root, change.path))
      }))
    }
    return changes
  }

  /**
   * One file's patch: the unstaged (index→worktree), staged (HEAD→index) or
   * a commit's own diff. Untracked files are diffed against /dev/null.
   */
  async diff(
    root: string,
    options: { path: string; staged?: boolean; hash?: string },
  ): Promise<GitDiffResult> {
    let output = ''
    if (options.hash) {
      const parent = await this.firstParent(root, options.hash)
      output = parent
        ? await this.run(
          root,
          ['diff', '--no-color', '--find-renames', parent, options.hash, '--', options.path],
        ).catch(() => '')
        : await this.run(
          root,
          ['show', '--format=', '--no-color', '--find-renames', options.hash, '--', options.path],
        ).catch(() => '')
    } else if (options.staged) {
      output = await this.run(root, ['diff', '--cached', '--no-color', '--', options.path]).catch(() => '')
    } else {
      output = await this.run(root, ['diff', '--no-color', '--', options.path]).catch(() => '')
      if (!output.trim()) {
        output = await this.run(
          root,
          ['diff', '--no-index', '--no-color', '--', '/dev/null', options.path],
          { keepStdoutOnError: true },
        ).catch(() => '')
      }
    }
    const binary = isBinaryDiff(output)
    const truncated = output.length > MAX_DIFF_CHARS
    return {
      path: options.path,
      diff: truncated ? `${output.slice(0, MAX_DIFF_CHARS)}\n… 已截断` : output,
      binary,
      truncated,
    }
  }

  async stage(root: string, paths: string[]) {
    await this.run(root, ['add', '-A', '--', ...await this.expandRenames(root, paths)])
  }

  async unstage(root: string, paths: string[]) {
    const list = await this.expandRenames(root, paths)
    try {
      await this.run(root, ['restore', '--staged', '--', ...list])
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      // A repository without commits has no HEAD for restore to read.
      await this.run(root, ['rm', '--cached', '-r', '--', ...list])
    }
  }

  /** A rename touches both names, so mutating only the new path leaves half of it. */
  private async expandRenames(root: string, paths: string[]) {
    const list = clipPaths(paths)
    const changes = await this.changes(root).catch(() => [])
    const originals = new Map<string, string | undefined>()
    for (const change of changes) originals.set(change.path, change.origPath)
    const expanded = new Set(list)
    for (const path of list) {
      const origPath = originals.get(path)
      if (origPath) expanded.add(origPath)
    }
    return [...expanded]
  }

  /** IDEA-style rollback: restore tracked files to HEAD, delete new ones. */
  async discard(root: string, paths: string[]) {
    const changes = new Map((await this.changes(root)).map(change => [change.path, change]))
    for (const path of clipPaths(paths)) {
      const change = changes.get(path)
      if (!change) continue
      if (change.untracked) {
        await rm(resolve(root, path), { force: true })
        continue
      }
      if (change.origPath) {
        await this.run(root, ['restore', '--staged', '--', path, change.origPath]).catch(() => '')
        await this.run(root, ['restore', '--source=HEAD', '--worktree', '--', change.origPath]).catch(() => '')
        await rm(resolve(root, path), { force: true })
        continue
      }
      if (change.index === 'A') {
        await this.run(root, ['restore', '--staged', '--', path]).catch(() => '')
        await rm(resolve(root, path), { force: true })
        continue
      }
      try {
        await this.run(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
      } catch (error) {
        // A conflicted path during a merge needs the checkout fallback.
        if (!(error instanceof GitError)) throw error
        await this.run(root, ['checkout', 'HEAD', '--', path])
      }
    }
  }

  async commit(
    root: string,
    options: { message: string; amend?: boolean; signoff?: boolean; paths?: string[] },
  ): Promise<GitCommitResult> {
    const message = options.message.trim()
    if (!message) throw new GitError('提交说明不能为空')
    const paths = clipPaths(options.paths ?? [])
    if (paths.length) await this.stage(root, paths)
    const args = ['commit', '-m', message]
    if (options.amend) args.push('--amend')
    if (options.signoff) args.push('--signoff')
    const output = await this.run(root, args)
    const hash = (await this.run(root, ['rev-parse', 'HEAD'])).trim()
    return { commit: output.split('\n')[0]?.trim() || `${hash.slice(0, 7)}`, hash }
  }

  async log(root: string, query: GitLogQuery = {}): Promise<GitLogResult> {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200)
    const skip = Math.max(Math.floor(query.skip ?? 0), 0)
    const args = ['log', '--topo-order', '--no-color', `--max-count=${limit + 1}`, `--skip=${skip}`, LOG_FORMAT]
    if (query.ref) {
      // Resolve first so a ref can never be mistaken for an option.
      args.push(await this.resolveRef(root, query.ref))
    } else if (query.all) {
      args.push('--all')
    }
    if (query.query) {
      const text = query.query.trim().slice(0, 200)
      if (/^[0-9a-f]{4,40}$/i.test(text)) args.push(text)
      else if (text) args.push('--regexp-ignore-case', `--grep=${text}`)
    }
    if (query.path) args.push('--', query.path)
    const output = await this.run(root, args).catch((error) => {
      // A repository with no commits has an empty history, not an error.
      if (error instanceof GitError && /does not have any commits/i.test(error.message)) return ''
      throw error
    })
    const commits = parseLog(output)
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
  }

  /** Commit hash for a branch, tag or revision; rejects unknown or unsafe refs. */
  private async resolveRef(root: string, ref: string) {
    const name = ref.trim()
    if (!name || name.length > 200 || name.startsWith('-')) throw new GitError('分支或提交不存在', '', 404)
    try {
      const output = (await this.run(root, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`]))
        .trim()
      if (!/^[0-9a-f]{40,64}$/i.test(output)) throw new GitError('分支或提交不存在', '', 404)
      return output
    } catch (error) {
      if (error instanceof GitError && error.status === 404) throw error
      throw new GitError(`分支或提交不存在：${name}`, '', 404)
    }
  }

  async commitDetail(root: string, hash: string): Promise<GitCommitDetail> {
    assertHash(hash)
    const meta = await this.run(root, ['show', '-s', '--no-color', `--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s`, hash])
    const commit = parseLog(meta.trimEnd())[0]
    if (!commit) throw new GitError('找不到该提交', '', 404)
    const parent = commit.parents[0]
    const [body, nameStatus, numstat] = await Promise.all([
      this.run(root, ['show', '-s', '--format=%B', hash]).then(output => output.trim()).catch(() => ''),
      parent
        ? this.run(root, ['diff', '--name-status', '-z', '--find-renames', parent, hash]).catch(() => '')
        : this.run(root, [
          'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--find-renames', hash,
        ]).catch(() => ''),
      parent
        ? this.run(root, ['diff', '--numstat', '-z', '--find-renames', parent, hash]).catch(() => '')
        : this.run(root, [
          'diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-z', '--find-renames', hash,
        ]).catch(() => ''),
    ])
    return { ...commit, body, files: parseCommitFiles(nameStatus, numstat) }
  }

  /** First parent of a commit; null for a root commit or an invalid hash. */
  private async firstParent(root: string, hash: string) {
    assertHash(hash)
    try {
      const output = (await this.run(root, ['rev-list', '--parents', '--max-count=1', hash])).trim()
      return output.split(' ')[1] ?? null
    } catch {
      return null
    }
  }

  async branches(root: string): Promise<GitBranch[]> {
    const remotes = (await this.run(root, ['remote']).catch(() => ''))
      .split('\n')
      .map(name => name.trim())
      .filter(Boolean)
    const output = await this.run(root, [
      'for-each-ref',
      '--format=%(refname:short)%00%(refname)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(objectname:short)',
      'refs/heads',
      'refs/remotes',
    ])
    return parseBranches(output, remotes)
  }

  async checkout(root: string, name: string): Promise<string> {
    const branches = await this.branches(root)
    const target = branches.find(branch => branch.name === name)
    if (!target) throw new GitError(`分支不存在：${name}`, '', 404)
    if (target.current) return target.name
    if (!target.remote) {
      await this.run(root, ['checkout', name])
      return name
    }
    const local = target.name.replace(/^[^/]+\//, '')
    if (branches.some(branch => !branch.remote && branch.name === local)) {
      await this.run(root, ['checkout', local])
      return local
    }
    await this.run(root, ['checkout', '-b', local, '--track', target.name])
    return local
  }

  async createBranch(root: string, name: string, checkout = true): Promise<string> {
    const branch = name.trim()
    if (!branch) throw new GitError('分支名不能为空')
    await this.run(root, ['check-ref-format', '--branch', branch])
    await this.run(root, ['branch', branch])
    if (checkout) await this.run(root, ['checkout', branch])
    return branch
  }

  async fetch(root: string): Promise<GitSyncResult> {
    const output = await this.run(root, ['fetch', '--all', '--prune'], { network: true })
    return { output: summarize(output, '已获取远程更新') }
  }

  async pull(root: string): Promise<GitSyncResult> {
    const upstream = await this.upstreamOf(root)
    if (!upstream) throw new GitError('当前分支没有上游分支，无法拉取')
    const output = await this.run(root, ['pull', '--no-edit'], { network: true })
    return { output: summarize(output, '已拉取远程更新') }
  }

  async push(root: string): Promise<GitSyncResult> {
    const { branch, detached } = await this.currentBranch(root)
    if (detached || !branch) throw new GitError('分离 HEAD 状态下无法推送')
    const upstream = await this.upstreamOf(root)
    const output = upstream
      ? await this.run(root, ['push'], { network: true })
      : await this.run(root, ['push', '-u', 'origin', branch], { network: true })
    return { output: summarize(output, '已推送') }
  }
}

function clipPaths(paths: string[]) {
  return [...new Set(paths.map(path => path.trim()).filter(Boolean))].slice(0, MAX_PATHS)
}

function assertHash(hash: string) {
  if (!/^([0-9a-f]{4,40}|HEAD)$/i.test(hash)) throw new GitError('提交哈希无效')
}

/** Last meaningful line of push/pull chatter, or a fallback. */
function summarize(output: string, fallback: string) {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.at(-1) ?? fallback
}

async function untrackedStat(target: string): Promise<GitFileStat | undefined> {
  try {
    const info = await stat(target)
    if (!info.isFile() || info.size > 1_048_576) return undefined
    const content = await readFile(target, 'utf8')
    if (content.includes('\0')) return undefined
    if (!content) return { added: 0, removed: 0 }
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
    return { added: lines, removed: 0 }
  } catch {
    return undefined
  }
}

declare module '@ruobai/cordis' {
  interface Context {
    git: GitService
  }
}

export default GitService

export const meta = {
  title: 'Git',
  description: 'Git 状态、差异、提交、日志、分支与远程同步。',
}

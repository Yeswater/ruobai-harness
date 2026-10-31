import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Service, type Context } from '@ruobai/cordis'
import type { NetService } from '@ruobai/net'
import type {} from '@ruobai/net'
import z from '@ruobai/schemastery'
import {
  attachStats, errorLine, isBinaryDiff, parseBranches, parseCommitFiles, parseLog,
  parseNumstat, parseStatus,
} from './parse.ts'
import type {
  CreatePullInput, GitBranch, GitChange, GitCommitDetail, GitCommitResult, GitDiffResult, GitFileStat,
  GitHostInfo, GitHostProvider, GitHostStatus, GitInfo, GitLogQuery, GitLogResult, GitOperation,
  GitPushOptions, GitRemote, GitSyncResult, PullResult,
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
    // GitHub is detected through the gh CLI, which is also what push/PR use.
    this.registerHost({
      id: 'github',
      label: 'GitHub',
      matches: url => /github\.com[/:]/i.test(url),
      status: async () => {
        try {
          const { stdout, stderr } = await exec('gh', ['auth', 'status'], {
            timeout: 5_000,
            windowsHide: true,
            env: { ...process.env, ...(await this.proxyEnv()) },
          })
          const account = /account\s+(\S+)/i.exec(`${stdout}\n${stderr}`)?.[1]
          return { configured: true, ...(account ? { account } : {}) }
        } catch {
          return { configured: false, detail: '未检测到 gh 登录' }
        }
      },
    })
  }

  private readonly hostProviders = new Map<string, GitHostProvider>()
  private readonly hostStatus = new Map<string, { at: number; status: GitHostStatus }>()

  /** Hosting services register here; unloading a plugin unregisters its host. */
  registerHost(provider: GitHostProvider): () => void {
    this.hostProviders.set(provider.id, provider)
    return () => {
      if (this.hostProviders.get(provider.id) === provider) this.hostProviders.delete(provider.id)
    }
  }

  hosts(): GitHostProvider[] {
    return [...this.hostProviders.values()]
  }

  /** Every registered host with its connection state and matching remotes. */
  async hostInfo(root: string): Promise<GitHostInfo[]> {
    const remotes = await this.remotes(root)
    return Promise.all(this.hosts().map(async (provider) => {
      const cached = this.hostStatus.get(provider.id)
      const usable = cached && Date.now() - cached.at < (cached.status.configured ? 60_000 : 5_000)
      const status = usable
        ? cached!.status
        : await withTimeout(
            provider.status(),
            4_000,
            error => ({ configured: false, error: error instanceof Error ? error.message : '状态检查失败' }),
          )
      if (!usable) {
        this.hostStatus.set(provider.id, { at: Date.now(), status })
      }
      return {
        id: provider.id,
        label: provider.label,
        ...status,
        remotes: remotes.filter(remote => provider.matches(remote.url)),
      }
    }))
  }

  /** git and gh follow the same proxy setting as the harness's own HTTP. */
  private async proxyEnv(): Promise<NodeJS.ProcessEnv> {
    const net = this.ctx.get('net', false) as NetService | undefined
    if (!net) return {}
    try {
      return await net.subprocessEnv()
    } catch {
      return {}
    }
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
          ...(await this.proxyEnv()),
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

  async remotes(root: string): Promise<GitRemote[]> {
    const output = await this.run(root, ['remote', '-v']).catch(() => '')
    const map = new Map<string, string>()
    for (const line of output.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim())
      if (match) map.set(match[1]!, match[2]!)
    }
    return [...map].map(([name, url]) => ({ name, url }))
  }

  async remoteUrl(root: string, name: string) {
    return (await this.remotes(root)).find(item => item.name === name)?.url
  }

  /** Adds a remote unless it already exists with the same URL. */
  async addRemote(root: string, name: string, url: string) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new GitError('remote 名称无效')
    assertRemoteUrl(url)
    const existing = await this.remoteUrl(root, name)
    if (existing) {
      if (existing === url) return { added: false, url }
      throw new GitError(`remote ${name} 已存在且地址不同`, existing, 409)
    }
    await this.run(root, ['remote', 'add', name, url])
    return { added: true, url }
  }

  async push(root: string, options: GitPushOptions = {}): Promise<GitSyncResult> {
    const { branch, detached } = await this.currentBranch(root)
    if (detached || !branch) throw new GitError('分离 HEAD 状态下无法推送')
    const remote = options.remote?.trim()
    const target = options.branch?.trim() || branch
    if (!/^[A-Za-z0-9._/-]+$/.test(target)) throw new GitError('分支名无效')
    let args: string[]
    if (remote) {
      if (!(await this.remoteUrl(root, remote))) throw new GitError(`remote ${remote} 不存在`)
      args = options.setUpstream ? ['push', '-u', remote, target] : ['push', remote, target]
    } else {
      const upstream = await this.upstreamOf(root)
      args = upstream ? ['push'] : ['push', '-u', 'origin', target]
    }
    const output = await this.run(root, args, { network: true })
    return { output: summarize(output, '已推送') }
  }

  async createTag(root: string, name: string, message?: string) {
    await this.run(root, ['check-ref-format', `refs/tags/${name}`])
    await this.run(root, message
      ? ['tag', '-a', name, '-m', message]
      : ['tag', name])
  }

  async pushTag(root: string, name: string, remote: string): Promise<GitSyncResult> {
    await this.run(root, ['check-ref-format', `refs/tags/${name}`])
    if (!(await this.remoteUrl(root, remote))) throw new GitError(`remote ${remote} 不存在`)
    const output = await this.run(root, ['push', remote, name], { network: true })
    return { output: summarize(output, '已推送标签') }
  }

  /**
   * Commit the selected paths on a fresh branch, push it, and open a PR.
   *
   * GitHub goes through `gh`, Gitee through the Gitee service's API. Paths are
   * committed with a pathspec so other staged work stays out of the commit.
   */
  async createPullRequest(root: string, input: CreatePullInput): Promise<PullResult> {
    const title = input.title.trim()
    if (!title) throw new GitError('PR 标题不能为空')
    const branch = assertBranch(input.branch, 'branch')
    const base = assertBranch(input.base, 'base')
    if (branch === base) throw new GitError('新分支不能与基础分支同名')
    if (!(await this.isRepo(root))) throw new GitError('当前工作区不是 Git 仓库')

    const current = (await this.run(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (!current || current === 'HEAD') throw new GitError('detached HEAD 下不能创建 PR')

    const files = [...new Set(input.files.map(file => file.trim()).filter(Boolean))]
    for (const file of files) assertWorkspacePath(root, file)

    let head = current
    let commit: string | undefined
    if (files.length) {
      const { changes } = await this.status(root)
      const changed = new Set(changes.map(change => change.path))
      const missing = files.filter(file => !changed.has(file))
      if (missing.length) {
        throw new GitError(`这些文件没有未提交改动: ${missing.slice(0, 5).join(', ')}`)
      }
      await this.run(root, ['checkout', '-b', branch])
      await this.run(root, ['add', '--', ...files])
      const message = input.body?.trim() ? `${title}\n\n${input.body.trim()}` : title
      await this.run(root, ['commit', '-m', message, '--', ...files])
      head = branch
      commit = (await this.run(root, ['rev-parse', '--short', 'HEAD'])).trim()
    } else if (current === base) {
      throw new GitError('没有选中的改动，且当前已在基础分支上')
    }

    const remote = await this.pullRemote(root)
    await this.run(root, ['push', '--set-upstream', remote.name, `HEAD:refs/heads/${head}`], { network: true })

    if (remote.provider === 'github') {
      const url = await this.ghCreate(root, { title, body: input.body?.trim() ?? '', base, head })
      return { url, provider: 'github', branch: head, base, ...(commit ? { commit } : {}) }
    }

    const gitee = this.ctx.get('gitee', false) as
      | { createPull?(owner: string, repo: string, value: { title: string; head: string; base: string; body?: string }): Promise<{ html_url?: string; url?: string }> }
      | undefined
    if (!gitee?.createPull) throw new GitError('Gitee PR 需要挂载 @ruobai/gitee 并配置令牌')
    const pull = await gitee.createPull(remote.owner, remote.repo, {
      title,
      head,
      base,
      ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    })
    const url = pull.html_url ?? pull.url
    if (!url) throw new GitError('Gitee 未返回 PR 链接')
    return { url, provider: 'gitee', branch: head, base, ...(commit ? { commit } : {}) }
  }

  private async pullRemote(root: string) {
    const names = (await this.run(root, ['remote'])).split('\n').map(name => name.trim()).filter(Boolean)
    const ordered = names.includes('origin') ? ['origin', ...names.filter(name => name !== 'origin')] : names
    for (const name of ordered) {
      const url = (await this.run(root, ['remote', 'get-url', name])).trim()
      const parsed = parseRemote(url)
      if (parsed) return { ...parsed, name }
    }
    throw new GitError('找不到 GitHub 或 Gitee 远程仓库')
  }

  private async ghCreate(root: string, input: { title: string; body: string; base: string; head: string }) {
    try {
      const { stdout } = await exec('gh', [
        'pr', 'create',
        '--base', input.base,
        '--head', input.head,
        '--title', input.title,
        '--body', input.body || input.title,
      ], {
        cwd: root,
        timeout: this.config.networkTimeoutMs,
        maxBuffer: 1_000_000,
        env: {
          ...process.env,
          ...(await this.proxyEnv()),
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
        },
      })
      const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(stdout)?.[0]
      if (!url) throw new GitError(`gh 未返回 PR 链接: ${stdout.slice(0, 200)}`)
      return url
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GitError('未找到 gh CLI，请安装后执行 gh auth login')
      }
      if (error instanceof GitError) throw error
      const stderr = (error as { stderr?: string }).stderr
      throw new GitError(`创建 PR 失败: ${(stderr || (error as Error).message).slice(0, 500)}`)
    }
  }
}

function assertRemoteUrl(url: string) {
  if (!url || /\s/.test(url) || url.startsWith('-')) throw new GitError('remote 地址无效')
  if (/^(https?|ssh|git|file):\/\//.test(url)) return
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$/.test(url)) return
  throw new GitError('不支持的 remote 地址')
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

/** A host probe must never hold the Changes panel hostage. */
function withTimeout<T>(task: Promise<T>, ms: number, fallback: (error?: unknown) => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms)
    timer.unref?.()
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        resolve(fallback(error))
      },
    )
  })
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

function assertBranch(value: string, label: string) {
  const name = value.trim()
  if (!name) throw new GitError(`${label} 不能为空`)
  if (name.length > 120) throw new GitError(`${label} 过长`)
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-') || name.includes('..') || name.endsWith('/')) {
    throw new GitError(`${label} 不是合法的分支名: ${name}`)
  }
  return name
}

function assertWorkspacePath(root: string, file: string) {
  if (!file || file.startsWith('/') || file.includes('..') || file.includes('\\')) {
    throw new GitError(`非法路径: ${file}`)
  }
  const target = resolve(root, file)
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (target !== root && !target.startsWith(prefix)) throw new GitError(`路径越界: ${file}`)
  return file
}

function parseRemote(url: string): { provider: 'github' | 'gitee'; owner: string; repo: string } | undefined {
  const normalized = url.trim().replace(/\.git$/, '')
  let match = /(?:^|@)github\.com[:/]([^/]+)\/([^/]+)$/.exec(normalized)
  if (match) return { provider: 'github', owner: match[1]!, repo: match[2]! }
  match = /(?:^|@)gitee\.com[:/]([^/]+)\/([^/]+)$/.exec(normalized)
  if (match) return { provider: 'gitee', owner: match[1]!, repo: match[2]! }
  return undefined
}

export interface GitFileStat {
  added: number
  removed: number
}

/**
 * One path from `git status --porcelain=v2`, keeping the index and worktree
 * sides apart so the UI can show staged and unstaged groups independently.
 */
export interface GitChange {
  path: string
  /** Previous path for a rename or copy. */
  origPath?: string
  /** Single-letter index status: `.` `M` `A` `D` `R` `C` `T` `U` or `?`. */
  index: string
  /** Single-letter worktree status. */
  worktree: string
  untracked: boolean
  conflicted: boolean
  staged: boolean
  unstaged: boolean
  stagedStat?: GitFileStat
  worktreeStat?: GitFileStat
}

export type GitOperation = 'clean' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface GitInfo {
  /** The workspace root resolves inside a Git work tree. */
  available: boolean
  workspace: string
  home: string
  /** Short branch name, or the short commit when HEAD is detached. */
  branch: string | null
  detached: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Number of distinct changed paths. */
  files: number
  added: number
  removed: number
  operation: GitOperation
}

export interface GitCommit {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  email: string
  /** Author date, ISO 8601. */
  date: string
  subject: string
  /** Decorations such as `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[]
}

export interface GitCommitFile {
  path: string
  origPath?: string
  /** Single-letter status: A M D R C T. */
  status: string
  added: number
  removed: number
}

export interface GitCommitDetail extends GitCommit {
  body: string
  files: GitCommitFile[]
}

export interface GitBranch {
  /** Short name, e.g. `main` or `origin/main`. */
  name: string
  remote: boolean
  current: boolean
  upstream?: string
  ahead: number
  behind: number
  /** The upstream branch was deleted on the remote. */
  gone: boolean
}

export interface GitLogQuery {
  limit?: number
  skip?: number
  /** Include every ref instead of only HEAD. */
  all?: boolean
  /** Start the walk at this branch, tag or commit instead of HEAD. */
  ref?: string
  /** Search commit messages or resolve a hash prefix. */
  query?: string
  /** Restrict history to a path inside the repository. */
  path?: string
}

export interface GitLogResult {
  commits: GitCommit[]
  hasMore: boolean
}

export interface GitDiffResult {
  path: string
  diff: string
  binary: boolean
  truncated: boolean
}

export interface GitCommitResult {
  commit: string
  hash: string
}

export interface GitSyncResult {
  output: string
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitPushOptions {
  remote?: string
  branch?: string
  setUpstream?: boolean
}

export interface CreatePullInput {
  title: string
  body?: string
  /** Branch that will carry the commit; created when files are included. */
  branch: string
  base: string
  /** Workspace-relative paths to commit; empty means the current branch. */
  files: string[]
}

export interface PullResult {
  url: string
  provider: 'github' | 'gitee'
  branch: string
  base: string
  commit?: string
}

/** Connection state of a hosting service, cheap enough to read per request. */
export interface GitHostStatus {
  /** Credentials/CLI are present; the host is usable. */
  configured: boolean
  /** Signed-in account, when the host can report one. */
  account?: string
  /** Why it is not configured, when that is a normal state. */
  detail?: string
  /** Why the probe failed even though credentials exist. */
  error?: string
}

/**
 * A hosting service (Gitee, GitHub, …) plugged into the workspace.
 *
 * The registry is open: a plugin registers its own provider and the Changes
 * panel lists it; plugins that are not loaded simply never appear.
 */
export interface GitHostProvider {
  id: string
  label: string
  /** Does this remote URL belong to the host? */
  matches(url: string): boolean
  status(): Promise<GitHostStatus>
}

export interface GitHostInfo extends GitHostStatus {
  id: string
  label: string
  /** Remotes in this repository that point at the host. */
  remotes: GitRemote[]
}

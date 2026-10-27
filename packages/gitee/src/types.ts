export interface GiteeAccount {
  login: string
  name?: string
  avatarUrl?: string
}

export interface GiteeRepoSummary {
  fullName: string
  name: string
  owner: string
  description?: string
  private: boolean
  htmlUrl?: string
  defaultBranch?: string
  updatedAt?: string
}

export interface GiteeBranch {
  name: string
  sha?: string
}

export interface GiteeCommitSummary {
  sha: string
  message: string
  author?: string
  date?: string
}

export interface GiteeContentEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'submodule' | string
  size?: number
}

export interface GiteeContent {
  path: string
  ref?: string
  /** Present for a directory: the entries inside it. */
  entries?: GiteeContentEntry[]
  /** Present for a file: decoded UTF-8 text. */
  content?: string
  truncated: boolean
  size?: number
}

export interface GiteeIssueSummary {
  number: number
  title: string
  state: string
  author?: string
  createdAt?: string
  updatedAt?: string
  labels?: string[]
}

export interface GiteeIssueDetail extends GiteeIssueSummary {
  body?: string
  comments?: number
}

export interface GiteePullSummary {
  number: number
  title: string
  state: string
  author?: string
  createdAt?: string
  updatedAt?: string
  head?: string
  base?: string
}

export interface GiteeRelease {
  id?: number
  tagName: string
  name?: string
  body?: string
  createdAt?: string
  htmlUrl?: string
}

export interface GiteePage<T> {
  items: T[]
  page: number
  hasMore: boolean
}

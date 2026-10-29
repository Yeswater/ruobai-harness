import { Service, type Context } from '@ruobai/cordis'
import type { GitService } from '@ruobai/git'
import z from '@ruobai/schemastery'
import { DEFAULT_API_BASE, GiteeClient } from './client.ts'
import {
  executePublish, planPublish, webBaseOf,
  type PublishDeps, type PublishInput, type PublishPlan, type PublishResult,
} from './publish.ts'
import { giteeTools } from './tools.ts'
import type {
  GiteeAccount, GiteeBranch, GiteeCommitSummary, GiteeContent, GiteeIssueDetail, GiteeIssueSummary,
  GiteePage, GiteePullSummary, GiteeRelease, GiteeRepoSummary,
} from './types.ts'

export { DEFAULT_API_BASE, GiteeClient, GiteeError } from './client.ts'
export type { GiteeClientConfig } from './client.ts'
export { PublishError } from './publish.ts'
export type { PublishInput, PublishPlan, PublishResult, PublishStep } from './publish.ts'

export interface Config {
  apiBase?: string
  timeoutMs?: number
  maxBytes?: number
  pageSize?: number
  /** Fixture-only: lets tests point the client at 127.0.0.1. */
  allowPrivateHost?: boolean
  /** Remote URL template; `{owner}` and `{repo}` are substituted. */
  remoteTemplate?: string
}

declare module '@ruobai/cordis' {
  interface Context {
    gitee: GiteeService
  }
}

/**
 * Gitee platform service.
 *
 * The token is resolved per call from settings (or `GITEE_TOKEN`), so a token
 * saved in Settings → Gitee applies without restarting the harness.
 */
export class GiteeService extends Service {
  static inject = ['settings', 'tools', 'git']

  static Config: z<Config> = z.object({
    apiBase: z.string().default(DEFAULT_API_BASE),
    timeoutMs: z.number().min(1_000).default(20_000),
    maxBytes: z.number().min(1_024).default(2_000_000),
    pageSize: z.number().min(1).max(100).default(30),
    allowPrivateHost: z.boolean().default(false),
    remoteTemplate: z.string().default('git@gitee.com:{owner}/{repo}.git'),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'gitee')
    ctx.effect(() => {
      const disposers = giteeTools(this).map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'gitee.tools')
    // The Changes panel lists hosts through the git registry; Gitee adds itself.
    ctx.effect(() => ctx.git.registerHost({
      id: 'gitee',
      label: 'Gitee',
      matches: url => /gitee\.com[/:]/i.test(url),
      status: async () => {
        if (!this.configured()) return { configured: false, detail: '未配置 Gitee 令牌' }
        try {
          const account = await this.account()
          return { configured: true, account: account.login }
        } catch (error) {
          return { configured: true, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }), 'gitee.host')
  }

  private clientWith(token?: string) {
    const settings = this.ctx.settings.publicGitee()
    return new GiteeClient({
      apiBase: settings.apiBase ?? this.config.apiBase,
      token: token ?? this.ctx.settings.giteeToken(),
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxBytes,
      pageSize: this.config.pageSize,
      allowPrivateHost: this.config.allowPrivateHost,
    })
  }

  configured() {
    return this.clientWith().authenticated
  }

  account(token?: string): Promise<GiteeAccount> {
    return this.clientWith(token).account()
  }

  listRepos(options: { query?: string; page?: number } = {}): Promise<GiteePage<GiteeRepoSummary>> {
    return this.clientWith().listRepos(options)
  }

  getRepo(owner: string, repo: string): Promise<GiteeRepoSummary> {
    return this.clientWith().getRepo(owner, repo)
  }

  branches(owner: string, repo: string, page?: number): Promise<GiteePage<GiteeBranch>> {
    return this.clientWith().branches(owner, repo, page)
  }

  commits(
    owner: string,
    repo: string,
    options: { ref?: string; path?: string; page?: number } = {},
  ): Promise<GiteePage<GiteeCommitSummary>> {
    return this.clientWith().commits(owner, repo, options)
  }

  contents(
    owner: string,
    repo: string,
    options: { path?: string; ref?: string } = {},
  ): Promise<GiteeContent> {
    return this.clientWith().contents(owner, repo, options)
  }

  releases(owner: string, repo: string, page?: number): Promise<GiteePage<GiteeRelease>> {
    return this.clientWith().releases(owner, repo, page)
  }

  issues(
    owner: string,
    repo: string,
    options: { state?: string; page?: number } = {},
  ): Promise<GiteePage<GiteeIssueSummary>> {
    return this.clientWith().issues(owner, repo, options)
  }

  issue(owner: string, repo: string, number: number): Promise<GiteeIssueDetail> {
    return this.clientWith().issue(owner, repo, number)
  }

  pulls(
    owner: string,
    repo: string,
    options: { state?: string; page?: number } = {},
  ): Promise<GiteePage<GiteePullSummary>> {
    return this.clientWith().pulls(owner, repo, options)
  }

  pull(owner: string, repo: string, number: number): Promise<GiteePullSummary & { body?: string }> {
    return this.clientWith().pull(owner, repo, number)
  }

  createIssue(
    owner: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[] },
  ): Promise<GiteeIssueDetail> {
    return this.clientWith().createIssue(owner, repo, input)
  }

  commentIssue(owner: string, repo: string, number: number, body: string): Promise<void> {
    return this.clientWith().commentIssue(owner, repo, number, body)
  }

  closeIssue(owner: string, repo: string, number: number): Promise<GiteeIssueDetail> {
    return this.clientWith().closeIssue(owner, repo, number)
  }

  createPull(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string },
  ): Promise<GiteePullSummary> {
    return this.clientWith().createPull(owner, repo, input)
  }

  commentPull(owner: string, repo: string, number: number, body: string): Promise<void> {
    return this.clientWith().commentPull(owner, repo, number, body)
  }

  private publishDeps(): PublishDeps {
    const settings = this.ctx.settings.publicGitee()
    return {
      client: this.clientWith(),
      git: this.ctx.git as GitService,
      remoteTemplate: this.config.remoteTemplate ?? 'git@gitee.com:{owner}/{repo}.git',
      defaultOwner: settings.owner,
      defaultPrivate: settings.visibility === 'private',
      webBase: webBaseOf(settings.apiBase ?? this.config.apiBase ?? DEFAULT_API_BASE),
    }
  }

  planPublish(input: PublishInput): Promise<PublishPlan> {
    return planPublish(this.publishDeps(), input)
  }

  publish(input: PublishInput): Promise<PublishResult> {
    return executePublish(this.publishDeps(), input)
  }

  createRelease(
    owner: string,
    repo: string,
    input: { tagName: string; name?: string; body?: string; target?: string },
  ): Promise<GiteeRelease> {
    return this.clientWith().createRelease(owner, repo, input)
  }
}

export default GiteeService

export const meta = {
  title: 'Gitee',
  description: '在 Gitee 上浏览仓库、Issue/PR，发布工作区。',
}

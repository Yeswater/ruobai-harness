import type { GitService } from '@ruobai/git'
import { GiteeError, type GiteeClient } from './client.ts'

export interface PublishInput {
  workspace: string
  owner?: string
  repo: string
  branch?: string
  private?: boolean
  description?: string
  tag?: string
  releaseTitle?: string
  releaseBody?: string
  remoteName?: string
  /** Host-only override (tests use a local bare remote). */
  remoteUrl?: string
}

export interface PublishPlan {
  owner: string
  repo: string
  fullName: string
  private: boolean
  branch: string
  head: string | null
  dirty: boolean
  repoExists: boolean
  tag?: string
  release: boolean
  remote: {
    name: string
    url: string
    exists: boolean
    conflict: boolean
    currentUrl?: string
  }
  steps: string[]
}

export interface PublishStep {
  name: string
  status: 'done' | 'skipped' | 'failed'
  output?: string
}

export interface PublishResult {
  plan: PublishPlan
  steps: PublishStep[]
  url: string
  releaseUrl?: string
}

export interface PublishDeps {
  client: GiteeClient
  git: GitService
  /** `{owner}`/`{repo}` placeholders; defaults to the Gitee SSH URL. */
  remoteTemplate: string
  defaultOwner?: string
  defaultPrivate: boolean
  /** Browser base for repository links, without `/api/v5`. */
  webBase: string
}

export class PublishError extends Error {
  constructor(message: string, public steps: PublishStep[] = []) {
    super(message)
    this.name = 'PublishError'
  }
}

export async function planPublish(deps: PublishDeps, input: PublishInput): Promise<PublishPlan> {
  const repo = input.repo?.trim()
  if (!repo) throw new GiteeError(400, '仓库名不能为空。')
  const account = await deps.client.account()
  const owner = input.owner?.trim() || deps.defaultOwner || account.login
  const info = await deps.git.info(input.workspace)
  if (!info.available) throw new GiteeError(400, '当前工作区不是 Git 仓库。')
  if (!info.head) throw new GiteeError(400, '当前分支还没有提交，无法发布。')
  const branch = input.branch?.trim() || info.branch || 'main'
  const remoteName = input.remoteName?.trim() || 'gitee'
  const remoteUrl = input.remoteUrl?.trim()
    || deps.remoteTemplate.replaceAll('{owner}', owner).replaceAll('{repo}', repo)
  const currentUrl = await deps.git.remoteUrl(input.workspace, remoteName)
  const conflict = Boolean(currentUrl && currentUrl !== remoteUrl)

  let repoExists = true
  try {
    await deps.client.getRepo(owner, repo)
  } catch (error) {
    if (error instanceof GiteeError && error.status === 404) repoExists = false
    else throw error
  }

  const tag = input.tag?.trim() || undefined
  const release = Boolean(tag && (input.releaseTitle !== undefined || input.releaseBody !== undefined))
  const steps = [
    repoExists ? '仓库已存在，跳过创建' : '创建空仓库',
    currentUrl
      ? conflict ? 'remote 地址冲突，需要先手动处理' : 'remote 已配置'
      : '添加 remote',
    `推送分支 ${branch} @ ${info.head.slice(0, 8)}`,
    ...(tag ? ['创建并推送 tag'] : []),
    ...(release ? ['创建 Release'] : []),
  ]

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    private: input.private ?? deps.defaultPrivate,
    branch,
    head: info.head,
    dirty: info.files > 0,
    repoExists,
    ...(tag ? { tag } : {}),
    release,
    remote: {
      name: remoteName,
      url: remoteUrl,
      exists: Boolean(currentUrl),
      conflict,
      ...(currentUrl ? { currentUrl } : {}),
    },
    steps,
  }
}

export async function executePublish(deps: PublishDeps, input: PublishInput): Promise<PublishResult> {
  const plan = await planPublish(deps, input)
  if (plan.remote.conflict) {
    throw new GiteeError(
      409,
      `remote ${plan.remote.name} 已指向 ${plan.remote.currentUrl}，与 ${plan.remote.url} 不同；` +
      '请先手动修改或删除这个 remote。',
    )
  }

  const steps: PublishStep[] = []
  let repoUrl = `${deps.webBase}/${plan.fullName}`
  try {
    if (!plan.repoExists) {
      const account = await deps.client.account()
      const org = await isOrg(deps.client, plan.owner, account.login)
      const created = await deps.client.createRepo({
        owner: plan.owner,
        name: plan.repo,
        description: input.description,
        private: plan.private,
        org,
      })
      if (created.htmlUrl) repoUrl = created.htmlUrl
      steps.push({ name: '创建仓库', status: 'done', output: repoUrl })
    } else {
      steps.push({ name: '创建仓库', status: 'skipped', output: '仓库已存在' })
    }

    const added = await deps.git.addRemote(input.workspace, plan.remote.name, plan.remote.url)
    steps.push({
      name: '配置 remote',
      status: added.added ? 'done' : 'skipped',
      output: plan.remote.url,
    })

    const pushed = await deps.git.push(input.workspace, {
      remote: plan.remote.name,
      branch: plan.branch,
      setUpstream: true,
    })
    steps.push({ name: '推送分支', status: 'done', output: pushed.output })

    if (plan.tag) {
      let created = false
      try {
        await deps.git.createTag(input.workspace, plan.tag)
        created = true
      } catch (error) {
        // Re-publishing an existing tag is idempotent; a foreign tag still fails on push.
        if (!/already exists|已存在/i.test(error instanceof Error ? error.message : String(error))) throw error
      }
      const tagPush = await deps.git.pushTag(input.workspace, plan.tag, plan.remote.name)
      steps.push({
        name: '创建并推送 tag',
        status: created ? 'done' : 'skipped',
        output: tagPush.output,
      })
    }

    let releaseUrl: string | undefined
    if (plan.release && plan.tag) {
      try {
        const release = await deps.client.createRelease(plan.owner, plan.repo, {
          tagName: plan.tag,
          name: input.releaseTitle,
          body: input.releaseBody,
          target: plan.branch,
        })
        releaseUrl = release.htmlUrl || `${repoUrl}/releases/tag/${encodeURIComponent(plan.tag)}`
        steps.push({ name: '创建 Release', status: 'done', output: releaseUrl })
      } catch (error) {
        // Re-publishing the same tag is idempotent when the Release is already there.
        if (!(error instanceof GiteeError) || (error.status !== 400 && error.status !== 409 && error.status !== 422)) {
          throw error
        }
        const existing = await deps.client.releaseByTag(plan.owner, plan.repo, plan.tag)
        if (!existing) throw error
        releaseUrl = existing.htmlUrl || `${repoUrl}/releases/tag/${encodeURIComponent(plan.tag)}`
        steps.push({ name: '创建 Release', status: 'skipped', output: releaseUrl })
      }
    }

    return { plan, steps, url: repoUrl, ...(releaseUrl ? { releaseUrl } : {}) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    steps.push({ name: '发布失败', status: 'failed', output: message })
    throw new PublishError(message, steps)
  }
}

async function isOrg(client: GiteeClient, owner: string, login: string) {
  if (owner.toLowerCase() === login.toLowerCase()) return false
  const orgs = await client.orgs()
  if (orgs.some(org => org.login.toLowerCase() === owner.toLowerCase())) return true
  throw new GiteeError(400, `owner ${owner} 既不是当前账号，也不是可访问的组织。`)
}

export function webBaseOf(apiBase: string) {
  try {
    const url = new URL(apiBase)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'https://gitee.com'
  }
}

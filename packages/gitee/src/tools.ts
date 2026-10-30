import type { ToolDefinition } from '@ruobai/tools'
import type { GiteeService } from './index.ts'
import { PublishError, type PublishInput, type PublishPlan } from './publish.ts'

const MAX_OUTPUT = 60_000

export function giteeTools(service: GiteeService): ToolDefinition[] {
  return [
    {
      name: 'gitee_repo',
      description: [
        'Read Gitee repositories with the configured personal token.',
        'action=list lists repositories of the authenticated user (query filters by name);',
        'get/branches/commits/file/releases take owner and repo. file takes an optional path',
        '(empty for the repository root) and ref; directories return their entries.',
      ].join(' '),
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'branches', 'commits', 'file', 'releases'],
            description: 'What to read.',
          },
          owner: { type: 'string', description: 'Repository owner or organization.' },
          repo: { type: 'string', description: 'Repository name.' },
          path: { type: 'string', description: 'File or directory path for action=file.' },
          ref: { type: 'string', description: 'Branch, tag or commit for action=file/commits.' },
          query: { type: 'string', description: 'Name filter for action=list.' },
          page: { type: 'number', description: 'Page number, starting at 1.' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = requireText(args?.action, 'action')
        if (action === 'list') {
          return render(await service.listRepos({ query: optionalText(args?.query), page: optionalPage(args?.page) }))
        }
        const owner = requireText(args?.owner, 'owner')
        const repo = requireText(args?.repo, 'repo')
        switch (action) {
          case 'get':
            return render(await service.getRepo(owner, repo))
          case 'branches':
            return render(await service.branches(owner, repo, optionalPage(args?.page)))
          case 'commits':
            return render(await service.commits(owner, repo, {
              ref: optionalText(args?.ref),
              path: optionalText(args?.path),
              page: optionalPage(args?.page),
            }))
          case 'file':
            return render(await service.contents(owner, repo, {
              path: optionalText(args?.path),
              ref: optionalText(args?.ref),
            }))
          case 'releases':
            return render(await service.releases(owner, repo, optionalPage(args?.page)))
          default:
            throw new Error(`unknown action: ${action}`)
        }
      },
    },
    {
      name: 'gitee_issue',
      description: [
        'Read Gitee issues. action=list takes owner, repo and state (open|closed|all);',
        'action=get additionally takes number.',
      ].join(' '),
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get'] },
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number', description: 'Issue number for action=get.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          page: { type: 'number' },
        },
        required: ['action', 'owner', 'repo'],
      },
      async execute(args) {
        const action = requireText(args?.action, 'action')
        const owner = requireText(args?.owner, 'owner')
        const repo = requireText(args?.repo, 'repo')
        if (action === 'list') {
          return render(await service.issues(owner, repo, {
            state: optionalText(args?.state),
            page: optionalPage(args?.page),
          }))
        }
        if (action === 'get') {
          return render(await service.issue(owner, repo, requireNumber(args?.number, 'number')))
        }
        throw new Error(`unknown action: ${action}`)
      },
    },
    {
      name: 'gitee_pr',
      description: [
        'Read Gitee pull requests. action=list takes owner, repo and state (open|closed|all);',
        'action=get additionally takes number.',
      ].join(' '),
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get'] },
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number', description: 'Pull request number for action=get.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          page: { type: 'number' },
        },
        required: ['action', 'owner', 'repo'],
      },
      async execute(args) {
        const action = requireText(args?.action, 'action')
        const owner = requireText(args?.owner, 'owner')
        const repo = requireText(args?.repo, 'repo')
        if (action === 'list') {
          return render(await service.pulls(owner, repo, {
            state: optionalText(args?.state),
            page: optionalPage(args?.page),
          }))
        }
        if (action === 'get') {
          return render(await service.pull(owner, repo, requireNumber(args?.number, 'number')))
        }
        throw new Error(`unknown action: ${action}`)
      },
    },
    {
      name: 'gitee_issue_write',
      description: [
        'Create, comment on, or close a Gitee issue.',
        'action=create takes title and optional body/labels; comment takes number and body;',
        'close takes number. Requires approval.',
      ].join(' '),
      requiresApproval: true,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'comment', 'close'] },
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number', description: 'Issue number for comment/close.' },
          title: { type: 'string', description: 'Issue title for action=create.' },
          body: { type: 'string', description: 'Issue body or comment text.' },
          labels: { type: 'string', description: 'Comma-separated labels for action=create.' },
        },
        required: ['action', 'owner', 'repo'],
      },
      preview(args) {
        const action = optionalText(args?.action) ?? '?'
        const owner = optionalText(args?.owner) ?? '?'
        const repo = optionalText(args?.repo) ?? '?'
        if (action === 'create') {
          return { summary: `在 ${owner}/${repo} 创建 Issue：${optionalText(args?.title) ?? '(无标题)'}` }
        }
        return { summary: `${action === 'close' ? '关闭' : '评论'} ${owner}/${repo} #${args?.number ?? '?'}` }
      },
      async execute(args) {
        const action = requireText(args?.action, 'action')
        const owner = requireText(args?.owner, 'owner')
        const repo = requireText(args?.repo, 'repo')
        if (action === 'create') {
          const labels = optionalText(args?.labels)
          return render(await service.createIssue(owner, repo, {
            title: requireText(args?.title, 'title'),
            body: optionalText(args?.body),
            ...(labels ? { labels: labels.split(',').map(label => label.trim()).filter(Boolean) } : {}),
          }))
        }
        if (action === 'comment') {
          await service.commentIssue(owner, repo, requireNumber(args?.number, 'number'), requireText(args?.body, 'body'))
          return 'Comment posted.'
        }
        if (action === 'close') {
          return render(await service.closeIssue(owner, repo, requireNumber(args?.number, 'number')))
        }
        throw new Error(`unknown action: ${action}`)
      },
    },
    {
      name: 'gitee_pull_write',
      description: [
        'Create or comment on a Gitee pull request.',
        'action=create takes title, head and base plus optional body; comment takes number and body.',
        'Requires approval.',
      ].join(' '),
      requiresApproval: true,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'comment'] },
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number', description: 'Pull request number for comment.' },
          title: { type: 'string', description: 'Pull request title.' },
          head: { type: 'string', description: 'Source branch.' },
          base: { type: 'string', description: 'Target branch.' },
          body: { type: 'string', description: 'Pull request body or comment text.' },
        },
        required: ['action', 'owner', 'repo'],
      },
      preview(args) {
        const action = optionalText(args?.action) ?? '?'
        const owner = optionalText(args?.owner) ?? '?'
        const repo = optionalText(args?.repo) ?? '?'
        if (action === 'create') {
          return {
            summary: `在 ${owner}/${repo} 创建 PR：${optionalText(args?.head) ?? '?'} → ${optionalText(args?.base) ?? '?'}`,
          }
        }
        return { summary: `评论 ${owner}/${repo} PR #${args?.number ?? '?'}` }
      },
      async execute(args) {
        const action = requireText(args?.action, 'action')
        const owner = requireText(args?.owner, 'owner')
        const repo = requireText(args?.repo, 'repo')
        if (action === 'create') {
          return render(await service.createPull(owner, repo, {
            title: requireText(args?.title, 'title'),
            head: requireText(args?.head, 'head'),
            base: requireText(args?.base, 'base'),
            body: optionalText(args?.body),
          }))
        }
        if (action === 'comment') {
          await service.commentPull(owner, repo, requireNumber(args?.number, 'number'), requireText(args?.body, 'body'))
          return 'Comment posted.'
        }
        throw new Error(`unknown action: ${action}`)
      },
    },
    {
      name: 'gitee_publish',
      description: [
        'Publish the current session workspace to Gitee.',
        'Creates the repository when missing, adds or verifies the `gitee` remote, pushes the',
        'branch, and optionally creates a tag and Release. Requires a configured token;',
        'the human sees a plan before it runs.',
      ].join(' '),
      requiresApproval: true,
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner or organization; defaults to the configured owner or current account.' },
          repo: { type: 'string', description: 'Repository name to create or publish to.' },
          branch: { type: 'string', description: 'Branch to push; defaults to the current branch.' },
          private: { type: 'boolean', description: 'Visibility for a newly created repository.' },
          description: { type: 'string', description: 'Description used when creating the repository.' },
          tag: { type: 'string', description: 'Optional tag to create and push.' },
          releaseTitle: { type: 'string', description: 'Create a Release for the tag with this title.' },
          releaseBody: { type: 'string', description: 'Release notes.' },
          remoteName: { type: 'string', description: 'Git remote name; defaults to gitee.' },
        },
        required: ['repo'],
      },
      async preview(args, run) {
        if (!run.workspace) return { summary: '发布需要会话工作区。' }
        try {
          const plan = await service.planPublish(publishInput(args, run.workspace))
          return { summary: formatPlan(plan) }
        } catch (error) {
          return { summary: `发布预检失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
      async execute(args, run) {
        if (!run.workspace) throw new Error('publish requires a session workspace')
        try {
          return render(await service.publish(publishInput(args, run.workspace)))
        } catch (error) {
          if (error instanceof PublishError && error.steps.length) {
            const trail = error.steps
              .map(step => `- ${step.name}: ${step.status}${step.output ? ` — ${step.output}` : ''}`)
              .join('\n')
            throw new Error(`${error.message}\n${trail}`)
          }
          throw error
        }
      },
    },
    {
      name: 'gitee_release',
      description: 'Create a Gitee release for an existing tag. Requires approval.',
      requiresApproval: true,
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          tag: { type: 'string', description: 'Existing tag name.' },
          name: { type: 'string', description: 'Release title; defaults to the tag.' },
          body: { type: 'string', description: 'Release notes.' },
          target: { type: 'string', description: 'Target branch or commit; defaults to the repository default branch.' },
        },
        required: ['owner', 'repo', 'tag'],
      },
      preview(args) {
        const owner = optionalText(args?.owner) || '?'
        const repo = optionalText(args?.repo) || '?'
        const tag = optionalText(args?.tag) || '?'
        return { summary: `在 ${owner}/${repo} 为 ${tag} 创建 Release` }
      },
      async execute(args) {
        const owner = requireText(args?.owner, 'owner')
        const repo = requireText(args?.repo, 'repo')
        const tag = requireText(args?.tag, 'tag')
        return render(await service.createRelease(owner, repo, {
          tagName: tag,
          name: optionalText(args?.name),
          body: optionalText(args?.body),
          target: optionalText(args?.target),
        }))
      },
    },
  ].map((tool): ToolDefinition => ({
    ...tool,
    defer: true,
    keywords: ['gitee', 'git', 'repo', 'repository', 'issue', 'pr', 'pull request', 'release', 'publish',
      '仓库', '代码托管', '问题', '发布', '合并请求'],
  }))
}

function publishInput(args: any, workspace: string): PublishInput {
  return {
    workspace,
    owner: optionalText(args?.owner),
    repo: requireText(args?.repo, 'repo'),
    branch: optionalText(args?.branch),
    private: typeof args?.private === 'boolean' ? args.private : undefined,
    description: optionalText(args?.description),
    tag: optionalText(args?.tag),
    releaseTitle: optionalText(args?.releaseTitle),
    releaseBody: optionalText(args?.releaseBody),
    remoteName: optionalText(args?.remoteName),
  }
}

function formatPlan(plan: PublishPlan) {
  return [
    `发布到 ${plan.fullName}（${plan.private ? '私有' : '公开'}）`,
    `分支 ${plan.branch} @ ${(plan.head ?? '').slice(0, 8)}`,
    ...plan.steps.map(step => `- ${step}`),
    ...(plan.dirty ? ['注意：工作区有未提交改动，只会推送已提交内容。'] : []),
  ].join('\n')
}

function render(value: unknown) {
  const text = JSON.stringify(value)
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n… [truncated ${text.length - MAX_OUTPUT} chars]`
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireText(value: unknown, field: string) {
  const text = optionalText(value)
  if (!text) throw new Error(`${field} is required`)
  return text
}

function optionalPage(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

function requireNumber(value: unknown, field: string) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${field} must be a positive integer`)
  return number
}

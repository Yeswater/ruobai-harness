import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ruobai/cordis'
import type { PathGuard } from '@ruobai/sandbox'
import { resolveGitPaths, type SandboxPolicyService } from '@ruobai/sandbox-policy'

export interface Config {
  /** Register the built-in set. Turning this off leaves only explicit guards. */
  includeDefaults?: boolean
  /** Guard ids to skip, e.g. `env-file` when a project intentionally ships one. */
  exclude?: string[]
  /** Additional guards (user level; project level lives in .ruobai/sandbox.json). */
  extra?: PathGuard[]
}

/**
 * The built-in guard set. Guarding `.ruobai` is not optional in production:
 * the settings file holds `bypassApprovals`, so a writable copy would let the
 * agent weaken its own approval plane (threat T5).
 */
export function defaultGuards(root: string, home = process.env.HOME || homedir()): PathGuard[] {
  const dotGit = join(root, '.git')
  const git = resolveGitPaths(root)
  // In a linked worktree the pointer file is `<root>/.git` and the metadata
  // lives in the common dir; guard the place that can actually execute.
  const gitRoot = git?.commonDir ?? dotGit
  const guards: PathGuard[] = [
    // Normal git data (index, objects, refs, logs, HEAD, message files) stays
    // writable: a blanket `.git` deny made `git add`/`commit` impossible, and
    // SBPL cannot carve an allow out of a deny. Only the paths that can persist
    // execution or redirect reads outside the workspace stay read-only.
    {
      id: 'git-hooks',
      path: join(gitRoot, 'hooks'),
      match: 'subpath',
      access: 'write',
      reason: 'git hooks 会在下次提交时执行，不得被写入',
    },
    {
      id: 'git-config',
      path: join(gitRoot, 'config'),
      match: 'exact',
      access: 'write',
      reason: 'core.hooksPath / alias / pager 可持久化执行任意命令',
    },
    {
      id: 'git-config-worktree',
      path: join(gitRoot, 'config.worktree'),
      match: 'exact',
      access: 'write',
      reason: 'worktree 级 config 同样可改 hooksPath',
    },
    {
      id: 'git-alternates',
      path: join(gitRoot, 'objects', 'info', 'alternates'),
      match: 'exact',
      access: 'write',
      reason: '对象库可被重定向到仓库外',
    },
    {
      id: 'git-http-alternates',
      path: join(gitRoot, 'objects', 'info', 'http-alternates'),
      match: 'exact',
      access: 'write',
      reason: '对象库可被重定向到仓库外',
    },
    {
      id: 'git-info-attributes',
      path: join(gitRoot, 'info', 'attributes'),
      match: 'exact',
      access: 'write',
      reason: 'filter 驱动可执行命令',
    },
    {
      id: 'git-module-hooks',
      path: join(gitRoot, 'modules', '**', 'hooks'),
      match: 'glob',
      access: 'write',
      reason: '子模块 hooks 同样可跨会话执行',
    },
    {
      id: 'git-module-config',
      path: join(gitRoot, 'modules', '**', 'config'),
      match: 'glob',
      access: 'write',
      reason: '子模块 config 可改 hooksPath',
    },
    {
      id: 'git-worktree-commondir',
      path: join(gitRoot, 'worktrees', '*', 'commondir'),
      match: 'glob',
      access: 'write',
      reason: 'worktree 指向的公共 git 目录不得被重定向',
    },
    {
      id: 'git-worktree-gitdir',
      path: join(gitRoot, 'worktrees', '*', 'gitdir'),
      match: 'glob',
      access: 'write',
      reason: 'worktree 的 gitdir 不得被重定向',
    },
    // A linked worktree keeps a pointer file at `<root>/.git`; rewriting it
    // redirects every git command to another repository.
    ...(git && git.gitDir !== dotGit
      ? [{
        id: 'git-worktree-pointer',
        path: dotGit,
        match: 'exact' as const,
        access: 'write' as const,
        reason: 'worktree 的 .git 指针不得被重写',
      }]
      : []),
    {
      id: 'harness-state',
      path: join(root, '.ruobai'),
      match: 'subpath',
      access: 'write',
      reason: 'harness 自身状态（含审批设置）不得被 agent 改写',
    },
    {
      id: 'env-file',
      path: join(root, '.env*'),
      match: 'glob',
      access: 'read',
      reason: '.env 通常含凭据',
    },
    {
      id: 'env-file-nested',
      path: join(root, '**', '.env*'),
      match: 'glob',
      access: 'read',
      reason: '.env 通常含凭据',
    },
  ]

  if (home) {
    guards.push(
      {
        id: 'ssh-keys',
        path: join(home, '.ssh'),
        match: 'subpath',
        access: 'read',
        reason: 'SSH 私钥不得被读取外传',
      },
      {
        id: 'aws-keys',
        path: join(home, '.aws'),
        match: 'subpath',
        access: 'read',
        reason: '云凭据不得被读取外传',
      },
      {
        id: 'gh-token',
        path: join(home, '.config', 'gh'),
        match: 'subpath',
        access: 'read',
        reason: 'GitHub token 不得被读取外传',
      },
      {
        id: 'docker-auth',
        path: join(home, '.docker'),
        match: 'subpath',
        access: 'read',
        reason: 'registry 凭据不得被读取外传',
      },
      {
        id: 'netrc',
        path: join(home, '.netrc'),
        match: 'exact',
        access: 'read',
        reason: '明文凭据文件',
      },
      {
        id: 'shell-rc',
        path: join(home, '.zshrc'),
        match: 'exact',
        access: 'write',
        reason: 'shell 启动脚本不得被写入，否则可持久化执行',
      },
      {
        id: 'shell-profile',
        path: join(home, '.bash_profile'),
        match: 'exact',
        access: 'write',
        reason: 'shell 启动脚本不得被写入，否则可持久化执行',
      },
      {
        id: 'shell-profile-alt',
        path: join(home, '.profile'),
        match: 'exact',
        access: 'write',
        reason: 'shell 启动脚本不得被写入，否则可持久化执行',
      },
      {
        id: 'launch-agents',
        path: join(home, 'Library', 'LaunchAgents'),
        match: 'subpath',
        access: 'write',
        reason: '启动项不得被写入，否则可跨会话持久化',
      },
      {
        id: 'harness-policy',
        path: join(home, 'Library', 'Application Support', 'Ruobai'),
        match: 'subpath',
        access: 'write',
        reason: '托管策略目录不得被 agent 改写',
      },
    )
  }

  return guards.map(guard => ({ ...guard, owner: 'sandbox-guards' }))
}

/** Registers the default guard set; every guard is an individually revocable effect. */
export default class SandboxGuards {
  static inject = ['sandboxPolicy']

  constructor(ctx: Context, config: Config = {}) {
    const policy = ctx.get('sandboxPolicy') as SandboxPolicyService
    const exclude = new Set(config.exclude ?? [])
    const guards = [
      ...(config.includeDefaults === false ? [] : defaultGuards(policy.root)),
      ...(config.extra ?? []).map(guard => ({ ...guard, owner: guard.owner ?? 'sandbox-guards' })),
    ].filter(guard => !exclude.has(guard.id))

    for (const guard of guards) {
      ctx.effect(() => policy.registerGuard(guard), `sandbox.guard.${guard.id}`)
    }
  }
}

export const meta = {
  title: '沙箱守卫集',
  description: '.git 持久化点 / .ssh / .env / .ruobai 等默认只读覆盖。',
}

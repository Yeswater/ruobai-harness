import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@ruobai/cordis'
import type { PathGuard } from '@ruobai/sandbox'
import type { SandboxPolicyService } from '@ruobai/sandbox-policy'

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
  const guards: PathGuard[] = [
    {
      id: 'git-dir',
      path: join(root, '.git'),
      match: 'subpath',
      access: 'write',
      reason: '仓库元数据（hooks、config、refs）不得被写入，否则可在下次会话继续执行',
    },
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
  description: '.git / .ssh / .env / .ruobai 等默认只读覆盖。',
}

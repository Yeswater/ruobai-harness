import { createHash } from 'node:crypto'
import type { Context } from '@ruobai/cordis'
import { contractOf, type TaskContract } from '@ruobai/contract'
import { evaluate, type DeliveryVerdict } from '@ruobai/delivery'
import type {} from '@ruobai/session'

export const name = 'handoff'
export const inject = ['web', 'sessions']

export const ARTIFACTS = ['README.md', 'ACCEPTANCE.md', 'CHANGES.md', 'RUNBOOK.md', 'evidence.json'] as const
export type ArtifactName = typeof ARTIFACTS[number]

interface CheckpointChange {
  seq: number
  path: string
  tool: string
  afterBytes?: number
  at: number
}

/**
 * Handoff bundle: the delivery's acceptance, evidence, changes and runbook.
 *
 * Read-only by construction: it folds existing projections into documents and
 * never writes an event, calls a model, or touches the workspace. That is the
 * same boundary as session export, one level up: export is "one session seen
 * two ways", handoff is "one delivery seen as five artifacts".
 */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.web.register({
    prefix: '/api/handoff',
    handler: (req, res, url) => handle(ctx, req, res, url),
  }), 'handoff.route')
}

export default { name, inject, apply }

export function renderArtifacts(ctx: Context, sessionId: string): Record<ArtifactName, string> {
  const contract = contractOf(ctx, sessionId).open
  const verdict = evaluate(ctx, sessionId)
  const changes = ctx.sessions.view<{ checkpoints?: CheckpointChange[] }>(sessionId)?.checkpoints ?? []
  return {
    'README.md': renderReadme(contract),
    'ACCEPTANCE.md': renderAcceptance(contract, verdict),
    'CHANGES.md': renderChanges(changes),
    'RUNBOOK.md': renderRunbook(contract),
    'evidence.json': JSON.stringify(verdict, null, 2),
  }
}

async function handle(ctx: Context, req: any, res: any, url: URL) {
  if ((req.method ?? 'GET') !== 'GET') return send(res, 405, 'text/plain', 'method not allowed')

  const match = /^\/api\/handoff\/([^/]+?)(?:\/([^/]+))?$/.exec(url.pathname)
  if (!match) return send(res, 404, 'text/plain', 'not found')

  const sessionId = decodeURIComponent(match[1]!)
  const record = ctx.sessions.get(sessionId)
  if (!record) return send(res, 404, 'text/plain', 'unknown session')

  const artifacts = renderArtifacts(ctx, sessionId)
  const wanted = match[2] ? decodeURIComponent(match[2]) : 'manifest'

  if (wanted === 'manifest') {
    return send(res, 200, 'application/json', JSON.stringify({
      generatedFrom: {
        sessionId,
        upToSeq: record.events.at(-1)?.seq ?? -1,
        eventCount: record.events.length,
        generatedAt: new Date().toISOString(),
      },
      artifacts: ARTIFACTS.map(name => ({
        name,
        bytes: Buffer.byteLength(artifacts[name]),
        sha256: createHash('sha256').update(artifacts[name]).digest('hex'),
      })),
    }, null, 2))
  }

  const artifact = ARTIFACTS.find(candidate => candidate === wanted)
  if (!artifact) return send(res, 404, 'text/plain', 'unknown artifact')
  const type = artifact.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8'
  return send(res, 200, type, artifacts[artifact])
}

function send(res: any, status: number, type: string, body: string) {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function renderReadme(contract: TaskContract | null): string {
  if (!contract) {
    return [
      '# 交接包',
      '',
      '本会话没有契约（contract_open 未调用），因此这份交接包只有变更与证据索引。',
      '客户侧的验收条款缺失，不能作为交付凭证。',
    ].join('\n') + '\n'
  }
  return [
    `# ${contract.title}`,
    '',
    contract.customer ? `客户：${contract.customer}` : '',
    '',
    '## 交付目标',
    ...contract.goals.map(goal => `- ${goal}`),
    '',
    '## 包内文件',
    '- `ACCEPTANCE.md`：验收条款与判定',
    '- `CHANGES.md`：本会话写入的文件',
    '- `RUNBOOK.md`：启动、验证、回滚与已知限制',
    '- `evidence.json`：机器可读的证据索引',
  ].filter(Boolean).join('\n') + '\n'
}

function renderAcceptance(contract: TaskContract | null, verdict: DeliveryVerdict): string {
  if (!contract) return '# 验收\n\n未开契约：本会话没有 contract_open 记录。\n'
  const rows = verdict.checks.map((check) => {
    const item = contract.acceptance.find(candidate => candidate.id === check.acceptanceId)
    return `| ${check.acceptanceId} | ${item?.kind ?? '-'} | ${check.status} | ${check.reason} |`
  })
  return [
    `# ${contract.title} · 验收`,
    '',
    ...(contract.customer ? [`客户：${contract.customer}`, ''] : []),
    '## 验收条款',
    '| 条款 | 类型 | 判定 | 说明 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `结论：**${verdict.verdict}**`,
    '',
    '> 判定由会话日志里的证据重新计算，不是模型自述；证据指向的 tool/result 若失败，判定不会是通过。',
  ].join('\n') + '\n'
}

function renderChanges(changes: CheckpointChange[]): string {
  if (!changes.length) return '# 变更\n\n本会话没有记录到文件写入。\n'
  const latest = new Map<string, CheckpointChange>()
  for (const change of changes) latest.set(change.path, change)
  return [
    '# 变更',
    '',
    '| 文件 | 工具 | 字节 | 最后写入 |',
    '| --- | --- | --- | --- |',
    ...[...latest.values()].map(change =>
      `| ${change.path} | ${change.tool} | ${change.afterBytes ?? '-'} | ${new Date(change.at).toISOString()} |`),
  ].join('\n') + '\n'
}

function renderRunbook(contract: TaskContract | null): string {
  const checks = contract?.acceptance.filter(item => item.check?.command) ?? []
  return [
    '# 运行手册',
    '',
    '## 启动',
    '- `pnpm install --offline --no-frozen-lockfile`',
    '- `pnpm dev`（默认 http://localhost:4310）',
    '',
    '## 验证',
    ...(checks.length ? checks.map(item => `- ${item.id}: \`${item.check!.command}\``) : ['- 无自动检查项']),
    '',
    '## 回滚',
    '- 会话内：按检查点 seq 回退文件写入（`checkpoints` 投影）。',
    '- 仓库级：`git revert <commit>`；本工具不做 force push。',
    '',
    '## 已知限制',
    ...(contract?.nonGoals.length ? contract.nonGoals.map(goal => `- ${goal}`) : ['- 未声明非目标']),
  ].join('\n') + '\n'
}

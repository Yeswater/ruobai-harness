# Hook + Linter 门禁设计

> 目标：把软件工程纪律外化为不可跳过的确定性门禁，让 Agent 在编辑、停止、提交等生命周期节点自动接受检查并自愈。
>
> 选型：CI 用 GitHub Actions；Linter 用 Biome；L2 审计的提供方/模型/提示词可配置；Agent 框架即本仓库（Cordis 插件树）。

## 0. 结论

门禁的成败不在"接了多少检查"，而在三件事：

1. **分层**：编辑时给秒级反馈，停止时做全量阻塞，行为层守住配置与危险操作。三层共用一套诊断协议。
2. **增量**：只对"新增或恶化"的问题失败，历史债务进基线。否则老项目第一天就开不起来。
3. **反馈**：全绿静默、只回传新问题、每条都能落到"改哪一行、怎么改"。否则 Agent 只会反复猜。

实现上是加两个包（`lint`、`hooks`）、一个设置页、一条 CI 工作流；阻断型检查必须走 Service 调用——AGENTS.md 已约定「事件是通知，不是 RPC」，监听 `tool/before` 拿不到返回值。

## 1. 架构与包边界

| 包 | 职责 | 对外 |
| --- | --- | --- |
| `@ruobai/lint` | 诊断类型、规则注册表、Biome 适配、增量与基线 | Service `ctx.lint` |
| `@ruobai/hooks` | 生命周期调度、guard、Stop 闸门、熔断、事件与指标 | Service `ctx.hooks` |
| `@ruobai/hooks-web` | REST + SSE、运行记录环形缓冲、设置页 Slot | `/api/hooks/*`、`hooks` 通道、`settings.hooks` |
| `ui-app` | 设置页 `settings.hooks` Slot 的客户端实现 | `HooksSettings` 面板 |

三个接入点：

- **编辑时**：监听 `tool/after`，匹配 `write_file` / `edit_file`；formatter 经 checkpoints 落盘，增量 Linter 只读；结果追加 `hooks/run` 事件。
- **停止时**：`AgentService` 在 `!calls.length` 分支（`packages/agent/src/index.ts:368`）调用 `ctx.hooks.beforeStop(sessionId)`；返回 `{ blocked, message }` 时回填并继续循环，最多 `maxRounds` 轮。
- **行为层**：`ToolRegistry.invoke()` 在 `tool/before`（`packages/tools/src/index.ts:169`）之前调用 `ctx.hooks.guard(call)`，与 permissions 并列；deny 直接作为该次工具结果返回。

服务契约（示意）：

```ts
interface HookResult {
  blocked: boolean
  diagnostics: Diagnostic[]
  durationMs: number
}

interface HooksService {
  guard(call: { name: string; args: unknown; sessionId?: string }): { deny: true; reason: string } | undefined
  afterTool(call: { name: string; args: unknown; sessionId?: string }, result: ToolResult): Promise<HookResult>
  beforeStop(sessionId: string): Promise<HookResult>
  run(layer: 'edit' | 'stop' | 'audit', opts?: { files?: string[]; dryRun?: boolean }): Promise<HookResult>
}
```

所有外部命令经 `ctx.shell` 执行，复用超时、输出截断与 `scrubbedEnv()`；formatter 写文件必须走 checkpoints。

## 2. Hook 矩阵

| 触发时机 | Hook 类型 | 检查内容 | 执行失败 | 发现问题的处理 | 回传 Agent | 工具 |
| --- | --- | --- | --- | --- | --- | --- |
| `tool/after`（写/改文件） | PostToolUse | Biome format + `biome check`（改动文件） | fail-open | 不阻塞工具，只回填 | 是，仅新问题 | `biome` |
| `tool/after`（bash / git） | 审计 | `--no-verify`、写保护路径、跳过门禁 | fail-close | 记 `hooks/violation`，拒绝并回填 | 是 | 命令解析、路径匹配 |
| `tool/before` 之前 | PreToolUse guard | 保护 hook/lint 配置、敏感路径、危险命令、架构边界 | fail-close（guard 自身异常也拒绝） | deny 作为工具结果 | 是 | 路径/命令规则、依赖图 |
| 回合将结束 | Stop | `biome check` + `tsc --noEmit` + 结构测试（改动范围优先） | fail-close | 阻断结束，回填并继续，最多 2 轮 | 是 | Biome、tsc、vitest |
| `git commit` | pre-commit | 同 Stop，面向人类提交 | fail-close | 阻止提交 | 否 | lefthook |
| 异步 / 手动 | L2 | 语义审计：设计一致性、安全、测试质量 | fail-open | 只产出报告 | 汇总时可选 | `ctx.llm` |

失败策略只有一条判断标准：**失败时放行会不会造成不可逆后果**。安全守卫与 Stop 放行会留下未验证的代码，所以 fail-close；编辑时 lint 崩溃只影响体验，fail-open。

## 3. Linter 分级与增量门禁

| 级别 | 规则 | 延迟预算 | 是否阻断 |
| --- | --- | --- | --- |
| L1 | Biome 格式化、Biome lint、`tsc --noEmit`、架构边界（受限 import、循环依赖、文件体积） | 编辑 <2s；Stop <120s | Stop / pre-commit 阻断 |
| L2 | LLM 审计：设计一致性、安全、测试有效性 | 分钟级 | 不阻断，只报告 |

**Biome 配置**（新增 `biome.json`，schema 跟随安装版本；当前为 2.6.3）：

```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.3/schema.json",
  "files": { "includes": ["packages/**", "apps/**", "tests/**"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "useConst": "error" },
      "suspicious": { "noExplicitAny": "warn" }
    }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`vendor/` 不纳入 Biome 的格式化与 lint（避免与上游代码产生无意义 diff），但仍参与 `tsc` 类型检查；编辑时层只传改动的业务文件，天然排除 vendor。

当前 `files.includes` 只覆盖 `packages/lint`、`packages/hooks`、`packages/hooks-web`——这是**分阶段纳入**：先用新代码把门禁跑通，再逐包扩大；类型检查仍是全仓。

**增量与基线**：

- 编辑时：`biome check --reporter=json <changed files>`，文件列表来自工具调用参数。
- Stop：`biome check --changed --since=<base>` + 全量 `tsc --noEmit`；`tsc` 必须全量，但按指纹与基线比对。
- 指纹：`hash(rule | path | 归一化 message)`；基线存 `.ruobai/lint-baseline.json`（可提交，供团队共享）。
- 失败条件：`new` 或 `worsened`（同指纹从 warn 升 error）。历史债务用**债务预算**管理：总量不得增加，目标每月下降 5%。
- 架构边界用 Biome 的受限 import 规则表达；跨包规则（如 `ui-app` 只能从 `@ruobai/*/types` 取类型）用自定义脚本生成规则，避免手写漂移。

## 4. 反馈协议

```ts
export interface Diagnostic {
  path: string
  line?: number
  column?: number
  rule: string
  level: 'error' | 'warn'
  message: string
  suggestion?: string
  docs?: string
  fingerprint: string
  baseline?: boolean
}
```

回填格式（全绿不发消息，只给新问题）：

```
<hook-diagnostics layer="stop" round="1" new="1">
packages/context/src/cache.ts:42 [noRestrictedImports]
  不能从 ui-app 引入实现，只允许 /types
  修复：import type { ChatSession } from '@ruobai/chat-protocol'
</hook-diagnostics>
```

约定：

- **formatter 可写文件；linter 只报告**，不自动修复语义问题。
- 单次最多 20 条，按 error → warn、文件聚合排序；同指纹只出现一次。
- 注入位置：沿用技能注入的做法，追加一条 `message/user` 并标 `source.kind = 'hook'`——它进入模型上下文与会话日志，但 `chat` 投影按 `source.kind` 过滤，不出现在对话流；guard 的 deny 例外，直接作为该次工具结果。
- 第 2 轮仍失败时，把同一规则的诊断合并成一条"先修这一类"的汇总，避免分析瘫痪。

## 5. 性能、熔断与可观测

| 项 | 策略 |
| --- | --- |
| 超时 | 编辑 2s、Stop 120s、L2 无硬超时但有预算；超时按该层失败策略处理 |
| 并行 | Biome 与 tsc 并行；同文件多检查串行，避免格式与 lint 互相覆盖 |
| 常驻 | 优先 `node_modules/.bin`；Biome 单二进制启动快，无需 daemon；tsc 可选用 `--watch`，失败回退一次性 |
| 缓存 | 以文件内容哈希为键，跳过未变化文件 |
| 熔断 | 连续 2 轮 Stop 未通过，或诊断指纹集合与上一轮完全相同 → 停止阻断，写 `hooks/escalated` 与 `turn/notice`，交给人 |
| 指标 | 通过率、阻断原因 Top N、阻断到通过的中位耗时、绕过尝试次数 |

检查器本身不可用（二进制缺失、启动失败、超时）默认**放行并记录**，不阻断回合；只有把该层 `failure` 设为 `close` 时，基础设施失败才进入阻断路径。这样本地没装工具链时门禁是"哑"的而不是"死"的，运行记录里能看到原因。

检查命令是 harness 自己的固定命令，不在 agent 的沙箱里跑：`lint` 的 checker 配 `executor: direct`，走 `shell-direct` 注册的宿主执行器；agent 的 `bash` 仍走默认的沙箱执行器，工具层不会选择执行器。这样 Biome/tsc 不会因为 `.git`、网络或凭据守卫失败，也不会看到 agent 的沙箱边界。

事件：`hooks/run-start`、`hooks/run-end`、`hooks/blocked`、`hooks/escalated`、`hooks/violation`。全部进会话日志，由 trajectory 投影展示，并提供 `GET /api/hooks/metrics`。

## 6. 安全

- **配置对 Agent 只读**：guard 拒绝写 `.claude/settings*.json`、`.ruobai/hooks.json`、`biome.json`、`tsconfig*.json`、`.github/workflows/*`；同时在 `sandbox-policy` 的写守卫里加同样的路径，形成第二道边界。
- **命令防绕过**：guard 解析 bash，拒绝 `git commit --no-verify`、`git push --no-verify`、重定向写 lint 配置；命中记 `hooks/violation`，可升级为审批。
- **UI 权限**：设置页只能改开关、超时、失败策略、L2 提供方；**检查命令与规则只读**，因为它们来自 git 管理的配置。想改规则就改代码并走审查——这是门禁可信的前提。
- 所有 hook 子进程用清洗过的环境变量，不继承 `process.env`。

## 7. L2 审计（可配置）

L2 是一个独立的 `LintAuditor`，配置全部落在 settings，便于不同部署切换提供方：

```ts
export interface AuditSettings {
  enabled?: boolean
  /** 复用 settings 中已配置的 provider id。 */
  provider?: string
  model?: string
  /** stop：确定性检查通过后异步跑；manual：设置页按钮；off：关闭。 */
  trigger?: 'stop' | 'manual' | 'off'
  prompt?: string
  /** 单次最多送审的文件数与 token 预算。 */
  maxFiles?: number
  dailyBudget?: number
}
```

- 提供方解析：`ctx.settings.findProvider(provider)` 找模型，`ctx.llm.get(provider)` 确认适配器存在；任一步失败则**跳过审计并记日志**（fail-open），设置页显示"提供方不可用"。
- 触发为 `stop` 时只在确定性检查全绿后运行，避免对注定要重写的代码做昂贵审计。
- 审计发现只进入报告与 `hooks/audit` 事件，不进入阻断路径；设置项 `feedback` 打开时，才在下一轮以摘要形式回填。
- 预算：单次文件数、token 上限、每日次数；超限即停止并记指标。

## 8. Hook 设置页设计

设置页新增 **「门禁」** tab，与 providers / mcp / permissions / behavior / runtime / sandbox / protocols 并列。

### 8.1 信息架构

```
门禁
├─ 状态条：编辑时 / Stop / L2 的开关、最近一次运行、通过率
├─ 编辑时层：启用、超时、失败策略、只读步骤列表
├─ Stop 层：启用、超时、最大轮次、只读命令列表、熔断状态
├─ 行为守卫：保护配置、拦截绕过命令、保护路径（仓库项只读）
├─ L2 审计：启用、提供方、模型、触发方式、提示词、预算
└─ 最近运行：时间线（通过/阻断/升级），可展开诊断、导出 JSON
```

线框：

```
┌ 门禁 ─────────────────────────────────────────────┐
│ ● 编辑时 开  ● Stop 开  ○ L2 关    上次运行 12s 前 │
│ [全部启用] [全部暂停]                   通过率 86% │
├ 编辑时 ──────────────────────────────────────────┤
│ ☑ 启用   超时 [2]s   失败策略 (放行 ▾)            │
│ biome format --write       改写     仓库配置·只读  │
│ biome check --reporter=json 只读    仓库配置·只读  │
├ Stop ────────────────────────────────────────────┤
│ ☑ 启用   超时 [120]s   最大轮次 [2]               │
│ biome check --changed / tsc --noEmit / vitest     │
│ 熔断：连续 2 轮未通过 → 停止阻断并升级             │
├ 行为守卫 ─────────────────────────────────────────┤
│ ☑ 保护配置文件   ☑ 拦截 --no-verify                │
│ 保护路径：.claude/settings*.json ×  (仓库)         │
│           .ruobai/hooks.json ×      (仓库)         │
├ L2 审计 ──────────────────────────────────────────┤
│ ☐ 启用  提供方 [DeepSeek ▾]  模型 [deepseek-chat ▾]│
│ 触发 (停止后 ▾)   单次文件 [20]   每日预算 [50]    │
│ 提示词 [展开编辑]                                  │
├ 最近运行 ─────────────────────────────────────────┤
│ 12:04 Stop 通过 · 3 项 · 1.8s            [详情]    │
│ 12:01 编辑 2 条新诊断 · 已回填           [详情]    │
└───────────────────────────────────────────────────┘
```

### 8.2 交互规则

- **保存即生效**：开关与数值走 `PATCH /api/hooks/settings`，乐观更新，失败回滚并就地提示。
- **只读项**：命令、规则、保护路径来自 git 管理的配置，UI 展示来源路径与锁图标，不提供编辑框。
- **试运行**：每层一个「试运行」按钮（`POST /api/hooks/run`，`dryRun: true`），只返回诊断，不阻断、不回填。
- **L2 提供方**：下拉框复用 settings 里的 provider/model 列表；未配置时禁用并提示"先在供应商页添加模型"。
- **立即审计**：L2 区块提供手动按钮，调用 `POST /api/hooks/audit`，结果就地展示，不写回模型上下文。
- **实时**：订阅 SSE `hooks` 通道，运行开始/结束/阻断时更新状态条与时间线；断线重连后以 `GET /api/hooks/runs` 对账。
- **可访问性**：状态不只靠颜色，同时给文字（通过/阻断/关闭）；所有开关有 label；键盘可达。

### 8.3 数据与接口

设置模型（`packages/settings`）：

```ts
export interface HookSettings {
  enabled?: boolean
  edit?: { enabled?: boolean; timeoutMs?: number; failure?: 'open' | 'close'; maxDiagnostics?: number }
  stop?: { enabled?: boolean; timeoutMs?: number; failure?: 'open' | 'close'; maxRounds?: number }
  guard?: { enabled?: boolean; denyWrite?: string[]; denyCommand?: string[] }
  audit?: AuditSettings
}
```

`SettingsData` / `PublicSettings` 增加 `hooks?: HookSettings`；`SettingsService` 增加 `updateHooks(patch)`，沿用现有原子写与校验。

`packages/hooks-web` 注册：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/hooks/status` | 开关、最近运行、通过率、熔断状态 |
| GET | `/api/hooks/runs?limit=20` | 运行时间线（含诊断摘要） |
| GET | `/api/hooks/settings` | 设置的公开视图（不含命令正文之外的秘密） |
| PATCH | `/api/hooks/settings` | 更新开关/预算/失败策略/L2 |
| POST | `/api/hooks/run` | 试运行一层（`dryRun` 默认 true） |
| POST | `/api/hooks/audit` | 对当前会话手动跑一次 L2 审计 |
| GET | `/api/hooks/metrics` | 通过率、阻断原因、修复耗时 |
| SSE | `hooks` | 运行事件推送 |

客户端：`ui-app` 的 `SettingsDialog` 增加 tab `'hooks'`，正文渲染 `<Slot name="settings.hooks" props={{ sessionId }} />`（与 sandbox 面板一致），由 `hooks-web` 的客户端模块（`packages/hooks-web/client/index.jsx`，`package.json` 的 `rbu.client` 字段）注册。这样移除 hooks 插件时，设置页只剩一个空状态，不会带到核心。

## 9. GitHub Actions CI

新增 `.github/workflows/ci.yml`，与本地门禁同源（同一组命令），保证"本地过了 CI 就过"：

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  checks:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome ci .
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build:ui
```

- `main` 上开启分支保护，要求 `checks` 通过；只保留 `main` 一条长期分支，版本仍用 tag/release。
- 平台相关的测试（Seatbelt）用运行时探测跳过；CI 只验证 Linux 可执行的部分，macOS 沙箱仍以本地实测为准。
- 后续可加 `audit` job 跑 L2（需要仓库 secret 配置提供方 key），但默认不阻塞合并。

## 10. 实施清单

| 阶段 | 内容 | 文件 |
| --- | --- | --- |
| 1 | 诊断协议 + 指纹 + 基线格式 | `packages/lint` |
| 2 | Biome 适配（format/check/JSON 解析）+ `biome.json` | `packages/lint`、根目录 |
| 3 | `hooks` Service：guard、afterTool、beforeStop、熔断 | `packages/hooks`、`packages/tools`、`packages/agent` |
| 4 | 反馈注入：下一步请求的 `<hook-diagnostics>` | `packages/context`（合成消息） |
| 5 | `hooks-web`：status/runs/settings/run/metrics + SSE | `packages/hooks-web` |
| 6 | 设置页「门禁」tab 与 `HooksSettings` 面板 | `packages/ui-app`、`packages/hooks-web/client` |
| 7 | GitHub Actions 与分支保护 | `.github/workflows/ci.yml` |
| 8 | L2 审计（可配置提供方）+ 报告 | `packages/lint`、`packages/hooks` |

场景启用建议：

| 场景 | 开启 |
| --- | --- |
| 原型 | 编辑时 L1（fail-open）；Stop 关 |
| 团队协作 | 编辑时 L1 + Stop（改动范围）+ 基线 + pre-commit + CI |
| 生产交付 | 全开 + guard + 架构规则 + L2 + 指标看板；Stop 与 commit 均 fail-close |

## 11. 风险与未决

- **Biome 版本**：命令与 `$schema` 需与安装版本一致；升级时同步改 `biome.json` 与 CI，避免 `--write`/`--apply` 之类的参数差异。
- **tsc 全量耗时**：大仓需要 `--incremental` 与 `tsBuildInfo` 缓存；如果超过 Stop 预算，改为"只阻塞改动包 + 依赖方"。
- **L2 成本**：默认关闭；开启后严格按每日预算与文件数限额，避免审计本身成为开销。
- **分支保护**：需要在 GitHub 仓库设置里开启（或个人仓库的规则集），这属于仓库外部配置，代码里只能提示。

## 12. 实施结果

已落地：

| 部分 | 位置 |
| --- | --- |
| 诊断协议、指纹、基线、解析 | `packages/lint` |
| guard / 编辑层 / Stop 闸门 / 熔断 / L2 | `packages/hooks` |
| REST + SSE + 设置页客户端 | `packages/hooks-web`（`settings.hooks` Slot） |
| 工具执行前守卫 | `ToolRegistry.invoke()` |
| 回合结束前闸门与回填 | `AgentService`（`!calls.length` 分支） |
| 设置模型 | `SettingsData.hooks` + `updateHooks()` |
| CI | `.github/workflows/ci.yml` + `biome.json` |

行为细节：

- guard 在 permissions 之前执行；拒绝原因作为该次工具结果返回，并记 `hooks/violation`。
- 编辑层反馈是**临时消息**（下一步请求带上，不落盘）；Stop 层反馈落成 `message/user` 且 `source.kind = 'hook'`，对话流隐藏、模型与日志可见。
- 检查命令走宿主执行器（`executor: direct`），不经过 agent 的沙箱；agent 的 `bash` 仍走沙箱。
- 连续 2 轮未通过，或诊断指纹集合与上一轮完全相同 → 升级（`hooks/escalated`），不再阻断。
- L2 审计只在 `trigger: stop` 且确定性检查全绿后自动运行；`manual` 由设置页按钮触发；结果为 `hooks/audit` 事件，永不阻断。

验证：

- 全量 466 个测试通过；新增 16 项（lint 8、hooks 7、settings 1）。
- `pnpm typecheck` 两套通过；`biome ci .` 退出码 0；`pnpm build:ui` 通过。
- 运行时实测：`GET /api/hooks/status` 返回 5 个检查器与守卫基线；`POST /api/hooks/run {"layer":"stop"}` 约 5.4s，Biome 与 typecheck 均执行，返回 6 条 warning、0 条阻断；设置页「门禁」正常渲染并显示带行号的诊断。

尚未做：

- Biome 的 `files.includes` 仍只覆盖三个新包，其余包按批次扩大。
- 基线文件的生成命令（写入 `.ruobai/lint-baseline.json`）还没有 CLI，当前只能手工放置。
- GitHub 分支保护需在仓库设置里开启。

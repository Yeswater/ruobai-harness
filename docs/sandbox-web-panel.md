
---

## 7. 沙箱是否该有 web 配置页面

### 7.1 结论

**该做，但定位是可观测面板（M3a）加会话级开关（M3b），不是策略编辑器。**

直觉答案"配置集中到 UI 更好"在这里是错的，因为沙箱的**配置面**与**可观测面**安全性质完全不同。

### 7.2 最高价值的功能不是配置，是"沙箱到底生效了吗"

本次回归最贵的教训是**沙箱会静默降级**：

| 静默降级 | 症状 |
|---|---|
| 缺 `(allow process-fork)` | 只有管道/`&&` 失败，`echo hi` 看着正常（A18） |
| exec 白名单漏了 nvm 目录 | `npx` 不可用，但 `echo` 正常（A20） |
| 误判"有 denial 就升级" | 每条命令都弹窗，用户开始无脑点允许（A19） |
| self-check 失败 | provider `available:false`，`shell-sandboxed` 直接拒绝执行 |

前三种用户**根本看不出是"沙箱配错了"还是"命令写错了"**。所以一行状态比一屏配置更有价值：

```
Seatbelt  ● 生效中   darwin-seatbelt   profile 1bb9edd9…   网络 deny   12 条守卫   拒绝 3
```

### 7.3 三类配置必须分开，安全性差两个数量级

| 层 | 内容 | 决策 | 理由 |
|---|---|---|---|
| **只读可观测** | 状态行、guard 列表、denial 时间线（kind/target/guard/evidence/confidence）、策略 IR | **做（M3a，已实现）** | 不可观测的安全机制会被当噪音忽略，然后被整体关掉。这是"保留审批"能成立的前提 |
| **会话级开关** | 本会话 `escalate: auto/never`、撤销会话授权 | **做（M3b，已实现），不持久化** | 便利性设置，与 `bypassApprovals` 同级；**绝不能持久化**，否则等于永久关沙箱 |
| **策略级编辑** | 增删 guard、改网络模式、加 write 根 | **不做 UI，走文件** | 见 7.4 |

### 7.4 为什么策略编辑不该进 UI

**(a) 配置漂移。** 沙箱策略必须随仓库走（`.ruobai/sandbox.json`）。UI 点出来的改动落在 `~/.ruobai/settings.json`，同一仓库在两台机器行为不同——破坏"策略可审计"这个立身之本。

**(b) 团队评审缺失。** 加一条 `write-root: ~/Shared` 是安全决策，应出现在 code review 里，而不是某人下午点了一下。

**(c) UI 自己扩大攻击面。** 现有 `web-auth` 在 `RBU_TOKEN` 为空时放行（loopback 开发模式）。给这个入口加上"编辑沙箱策略"，等于把 T5（控制平面降级）的入口从文件系统搬到 HTTP。

**唯一例外**：网络白名单（`net.mode='allowlist'` 的域名列表）是**运维操作**，变更频繁、需即时生效、且不改变遏制姿态（默认仍是 deny）。这个值得做 UI，且必须区分"仅本会话"与"写入项目配置"两个按钮。**尚未实现**。

### 7.5 实现（M3a + M3b）

插件 `@ruobai/sandbox-web`，`inject = ['web','sandbox','sandboxPolicy','denial']`：

| 端点 | 方法 | 内容 |
|---|---|---|
| `/api/sandbox/status` | GET | 状态、provider、profile digest、IR、guards、denials、escalation |
| `/api/sandbox/session` | GET/PATCH | 会话级 `auto` / `never` |
| `/api/sandbox/grants` | GET/DELETE | 查看/撤销本会话放宽授权 |

客户端 `packages/sandbox-web/client/index.jsx`（`rbu.client`）挂到 `header.actions`：一个状态 chip，点开是抽屉面板。

**三条实现约束**：

1. **只暴露 IR，不暴露 SBPL。** `status.policy` 是平台无关的意图；SBPL 是机制，泄漏它等于告诉 agent 守卫边界的精确形状（测试 `exposes the policy as intent, never as SBPL` 断言不含 `subpath` / `(deny`）。
2. **会话开关的权威在 `EscalationService`，不在 web 插件。** 否则面板与执行器可能不一致。`sandbox-web` 只是 HTTP 门面，`shell-sandboxed` 通过 `escalation.modeFor(sessionId)` 读取。
3. **状态存在插件 effect 作用域内。** 模块级 `Map` 会跨热重载存活，静默保留上一次会话的弱化设置（§5.4 的漂移）。`EscalationService` 的 disposer 里 `modes.clear()`。

**"只报告"是什么语义**：`never` 仍然把 denial 返回给模型并附"请勿重试"，只是**不弹审批**。没有第三种模式能关掉沙箱本身——那是删插件的行为，必须显式改 `cordis.yml`。

### 7.6 一条反直觉的建议：denial 时间线比策略编辑更重要

这套系统里最难的不是编译 profile，是**归因**（日志探针 → pid 过滤 → guard 最长匹配 → 置信度）。用户看到

> 读守卫文件 · `ssh-keys` · `/Users/x/.ssh/id_rsa` · 证据 `native-log`(high)

比看到"编辑 guard 列表"有用得多——90% 的情况下用户要的是**知道发生了什么**，不是改配置。而归因一旦降级（无日志探针 → `confidence: low`），面板上一眼可见，比翻统一日志快得多。

### 7.7 落地顺序

1. **M3a（已实现）**：只读状态 + guard 列表 + denial 时间线。
2. **M3b（已实现）**：会话级开关 + 撤销授权。
3. **暂缓**：策略编辑器。等真的出现"频繁需要改 guard"的证据再做，且做也只能写 `.ruobai/sandbox.json` 供 review。

### 7.8 顺带暴露的真实缺口：开发期需要联网

实现 M3b 期间 `pnpm install` 因网络被拒而失败（`network-outbound`），导致 `node_modules` 被清空后无法重建。这不是 bug，是**设计按预期工作**：

- 网络豁免被硬编码为不可放宽（§3.3），所以沙箱拒绝 → 升级审批 → 审批说"网络永不放宽" → 失败。
- 正确出路是**改策略**（`net.mode: allowlist` + 显式域名），而不是"点一下放宽"。

因此 `cordis.yml` 当前的 `sandbox-policy.network` 是 `allowlist` + `registry.npmmirror.com:443`，注释里写明这是**依赖安装**用途、生产应改回 `deny`。这正好实证了 7.4 的结论：网络白名单该有 UI（区分会话级与项目级），而 guard 编辑不该有。

---

## 8. 实施结果（M3a + M3b）

### 8.1 验证

`node_modules` 在本轮被 `pnpm install` 清空（网络被沙箱拒绝，符合设计），因此借助工作区内一个已有依赖的 worktree 完成验证：

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.json`（映射到 worktree 依赖） | ✅ 0 错误 |
| 沙箱簇测试（12 个包） | ✅ **147 passed / 22 skipped / 0 failed** |
| `sandbox-macos/tests/compile.spec.ts` | ✅ 24 例（含 A28 网络用例） |
| `sandbox-web/tests/api.spec.ts` | ✅ 13 例 |
| `tool-fs/tests/guards.spec.ts` | ✅ 8 例（进程内守卫） |

### 8.2 让"沙箱能自测自己"的两处改造

本轮最重要的工程收获：**测试本身要能在沙箱里跑**，否则一旦沙箱接管 shell，自测通道就断了。

| 问题 | 改造 |
|---|---|
| `sandbox-web` 的测试要 `listen`，沙箱拒绝 | 抽出 `createHandler(ctx)`，测试直接调用 handler + 假的 `StatusResponse`，**不开 socket**。HTTP 只剩一行 `web.register` 包装 |
| `seatbelt.spec.ts` 要嵌套 `sandbox-exec`，A21 拒绝 | 顶层 `canNestSandboxExec()` 探测（`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`），不可嵌套则整组 `skipIf`，并在文件名/描述里写明原因 |
| `tool-bash` 超时用例在沙箱内 `kill EPERM` | 测试内 `canSignalOwnGroup()` 运行时探测：进程组信号是"沙箱外才有"的能力；沙箱内断言放宽为 `timed out | kill EPERM`，沙箱外保持严格 |

`shell-sandboxed` 同时给子进程注入 `RBU_SANDBOX_ACTIVE=1`：这是**有用的元信息**（沙箱内的程序可以知道自己是受限的），但测试不依赖它——因为它要重启才生效，测试用运行时探测更诚实。

### 8.3 仍然需要一次重启才能完成的事

`pnpm install` 需要外网。`cordis.yml` 已配 `allowlist` + `host: '*'` / `port: 443`（A28：这是可执行的最窄授权），但**运行中的进程仍是旧配置**。重启后：

1. 网络规则只接受 `*` / `localhost`（域名与 IP 都会让 profile 应用失败，见 appendix F A28），`cordis.yml` 已改为 `host: '*'` + `port: 443`；
2. `pnpm install --no-frozen-lockfile`（`package.json` 新增了 `sandbox-web`，lockfile 需更新）；
3. 再跑一次全仓测试，此时 `listen` 类用例（web-*、settings-web、git-web、ui-server、permissions、llm-openai）应当恢复；
4. `curl /api/sandbox/status` 确认面板数据；UI 里 `header.actions` 应出现沙箱 chip。

按 A28 的结论，`host: '*'` + `port: 443` 是这台 macOS 上能表达的最窄网络授权；域名/IP 规则一律不被接受。

### 8.4 主仓库复核（依赖恢复后）

依赖恢复后在主仓库直接跑完整验证，M3a 暴露了三个必须修的问题：

| 现象 | 根因 | 修复 |
|---|---|---|
| `escalate: never` 失效：受守卫的写入变成 exit 0，并批准了 `guard-write:git-dir` | `EscalationService.modeFor()` 把默认模式写死成 `auto`，覆盖了 `shell-sandboxed` 配置的 `never` | 默认值移到 `EscalationService`（`defaultMode`，默认 `auto`）；会话开关只做覆盖，执行器配置仅在无 escalation 服务时兜底 |
| `PATCH /api/sandbox/session` 一律 400 `mode must be "auto" 或 "never"` | `bodyOf()` 只认测试形态 `{ body }` / `{ stream }`，真实路由传的是 `IncomingMessage` 本身 | 回退到请求流本身再 `readJson`；新增「真实请求流」回归用例 |
| 网络白名单让**所有命令** exit 65：`host must be * or localhost in network address` | `remote ip` 只接受 `*` / `localhost`；域名与 IP 都会让 profile 无法应用（比“永不匹配”更糟）。沙箱内 DNS 还需放行 mDNSResponder unix socket（A28） | 删除 `resolveNetRules()`；无法执行的条目告警并跳过（fail-closed 且 profile 可运行）；生成 TCP 规则时一并放行 `/private/var/run/mDNSResponder`；`cordis.yml` 改 `host: '*'` + 443 |

复核结果：

- `pnpm typecheck` 与 UI tsconfig：0 错误；`pnpm build:ui` 构建通过
- 全量 `vitest run`：**71 文件 / 426 用例全绿**（连续 3 次；seatbelt 22 例在主仓库真实嵌套环境下全部执行，0 跳过）
- 临时实例（独立配置 + 独立会话目录）实测：
  - `GET /api/sandbox/status` → 200，provider `darwin-seatbelt` 就绪、guards/policy/denial 数据完整
  - `PATCH /api/sandbox/session` → `auto` ⇄ `never` 生效并可读回
  - `DELETE /api/sandbox/grants` → 200
  - 真实 Seatbelt 内 `curl https://example.com/` → `200`；`curl http://example.com/` → exit 7（`:80` 未授权）；`echo clean` 0 denial
  - `compileProfile` 跳过域名/IP 条目并告警；`*` / `localhost` 生效，且自动带 mDNSResponder 授权（A28）
- `packages/sandbox-web/client/index.jsx` 用 esbuild 经典 JSX runtime 打包通过（7.9 KB）

运行中的 4400 进程仍是旧代码（`/api/sandbox/status` 返回 404），重启后即可看到面板。

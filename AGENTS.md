# AGENTS.md — ruobai-harness 开发规范

本文件写给在本仓库工作的 agent（以及人类贡献者）。它不是入门教程，而是**做改动时必须遵守的约束**。设计细节见 `docs/`，实测记录见 `docs/sandbox-macos-appendix-f.md`。

## 0. 一句话架构

`cordis.yml` 定义应用；每个能力是一个 Cordis 插件包；会话是只追加的事件日志；Web 层只做传输；浏览器通过 Slot 组合 UI。**没有"核心里的 if"，只有插件组合。**

## 1. 目录与包约定

```
vendor/        vendored 框架（cordis / loader / schemastery / cosmokit ...）
packages/      一个能力一个包（@ruobai/<name>）
apps/cli/      读配置、建 Context、挂 Loader
apps/desktop/  Electron 桌面壳（窗口、菜单、harness 子进程）
tests/         全栈测试 harness
docs/          设计文档、实测记录、blog
cordis.yml     插件的组合方式（唯一应用定义）
```

- **一个包只做一件事**。服务端能力与它的 Web 适配器分开（`git` / `git-web`，`sandbox` / `sandbox-web`）。
- 包导出 `./src/index.ts`；需要给浏览器共享的纯类型放 `src/types.ts`，通过 `exports["./types"]` 暴露（见 `@ruobai/trajectory/types`）。
- 客户端半边在 `package.json` 声明 `"rbu": { "client": "./client/index.jsx" }`，不要放进 `src` 让宿主打包。
- 新包必须同时更新：根 `package.json` 的 devDependencies、`cordis.yml`（若默认启用）、`pnpm-lock.yaml`（`pnpm install --offline --no-frozen-lockfile`）。

## 2. Cordis 插件规范

- **一切注册都是可逆副作用**。所有监听、定时器、子进程、路由、投影、slot 都必须通过 `ctx.effect(() => …)` 交出 disposer；卸载时按逆序回收。
- **`inject` 声明硬性依赖**。依赖未就绪时 fiber 停在 PENDING，这是正确行为，不要用 `ctx.get(..., false)` 绕过必需依赖。可选依赖才用 `false`。
- 插件形态：
  - **Service 子类**：对外提供 `ctx.<name>` API（`session`、`chat`、`sandboxPolicy`）。
  - **对象插件**：`apply` 需要 await（自检、异步初始化）时用；`sandbox-macos` 是范例。
  - **函数插件**：只做注册、没有对外 API（`sandbox-guards`、`sandbox-native-log`）。
- **异步初始化不能写在 class constructor 的 effect 里**：Cordis 不会 await 它，会出现"fiber ACTIVE 但能力未就绪"。需要时改用 async `apply`。
- 事件名用 `<domain>/<action>`（`session/event`、`sandbox/denied`、`trajectory/frame`）。事件是通知，不是 RPC；需要返回值就提供 Service 方法。
- 插件之间不要直接 import 对方的实现；依赖 Service 或事件。唯一例外是纯类型。

## 3. 会话、日志与投影

- **Append-only 日志是唯一事实来源**。任何持久状态都必须先成为 `SessionEvent`；"模型可见 ⟺ 已落日志"。
- 不要在 append 之外直接改会话状态；`SessionService` 负责 meta、view 与 projection 的折叠。
- 派生状态用 `ctx.sessions.registerProjection(key, { init, apply })`，在 `ctx.effect` 中注册；读取用 `ctx.sessions.view(id)[key]`。
- **客户端不重放原始事件日志**。需要逐会话派生数据时，Host 提供分页快照（`/api/trajectory/...`）与增量帧；浏览器只合并、不 fold 全量事件。
- 投影单元必须是纯函数、单事件成本有界；状态里带 `rev` / `lastSeq` 以便客户端对账。
- 新事件类型要同时考虑：chat 投影是否忽略、UI 是否需要、压缩是否应跳过、旧会话回放是否兼容。

## 4. 工具与副作用

- 工具实现 `ToolDefinition`（`packages/tools/src/index.ts`）：`name/description/parameters/execute`，按需加：
  - `requiresApproval`：会改变外部状态（写文件、跑命令、发请求）。
  - `readOnly`：只读工具，read-only 权限模式下仍可用。
  - `approvalSubject`：持久审批规则匹配的键（命令或路径）。
  - `preview`：审批卡片里给人看的摘要/diff。
  - `defer`：默认不进工具的可见集合，由 `tool_search` 按会话按需加载；模式在 `allowTools` / `extraTools` 里显式列出的仍直接可见。领域集成（gitee、wiki、memory、contract、delivery）用它，避免每个编码步骤都携带整套 schema。
  - `keywords`：`tool_search` 的检索词（含中文），不发给模型。
- 新增默认工具前先问：它是否每个任务都需要。只在特定领域用的工具标 `defer`，否则每次请求都在为它付上下文和选择成本。
- 文件写入必须经过检查点（`checkpoints`），否则会话无法回退。
- `tool-fs` 的读写必须查 `ctx.sandboxPolicy.check()`（进程内第二道守卫）；新增文件类工具同样要接。
- 命令执行走 `ctx.shell`，不要在工具里直接 `child_process.spawn`；沙箱、超时、输出截断、环境清洗都在执行器里。
- 子进程环境必须清洗：不要继承 `process.env`，使用 `scrubbedEnv()` / `minimalEnv()`。Seatbelt 不限制 `env`。

## 5. 沙箱与审批

- 沙箱与审批是两条正交防线：沙箱插件不 `inject` 审批，审批也不 `inject` 沙箱；中间用 `denial` / `escalation` 解耦。
- **fail-closed**：provider 不可用、profile 编译失败、审批超时都必须拒绝，不允许"静默放行"。
- 审批只在**硬边界实际触发**时介入；成功命令里的启动探测属于噪音，必须在分类层过滤。
- 豁免必须与拒绝同粒度（`write-file` 单文件，不是 `dirname`）；网络、进程控制、mach、AppleEvent 永不放宽。
- 修改 macOS 沙箱前先读 `docs/sandbox-macos.md` 与附录 F；**任何"Seatbelt 支持 X"的判断都要在本机实测**，语法有效 ≠ 能应用 ≠ 会匹配。
- 保留 `shell-direct` 作为逃生舱；沙箱出问题时它必须还能跑（`cordis.yml` 一行切换）。
- harness 自己的检查（lint/typecheck）走 `shell-direct` 注册的非默认 `direct` 执行器，不经过 agent 沙箱；agent 的 bash 仍走默认沙箱执行器，工具层不得选择执行器。
- 热卸载：先摘 provider 表，再 abort 全部 run，最后 `destroyAll()`；不得留下孤儿 `sandbox-exec` / `log stream`。

## 6. Web 与客户端

- 服务端插件不直接 `createServer`；通过 `ctx.web.register({ prefix, handler })` 挂路由，`@ruobai/web-server` 负责解析与静态资源。
- 推送通道：`ctx.ui.broadcast(channel, data)`；SSE 事件名即 channel。新增通道要同时处理客户端 `EventSource` 与首帧对账。
- REST 返回**面向前端的窄类型**，不要把内部 record / Map / Service 直接序列化。
- 浏览器侧：
  - presentation 组件不接收 Cordis `ctx`、transport 或 observable；只接收 plain props + callbacks。
  - 客户端插件通过 `register(window.__RBU__)` 注册 Slot；返回 disposer，宿主在卸载时调用。
  - `ui-app` 的 tsconfig 不包含 `vendor/`；浏览器侧不要 import 会带出 Cordis 的入口，类型走 `@ruobai/<pkg>/types`。
  - 客户端插件自带样式时注入 `<style id="...">`，不要依赖宿主 CSS 类名。

### UI 规范（渐进式发现）

- **入口**：`.claude/skills/ui-design/SKILL.md`。Claude Code 与 RuoBai 的 skills 插件都会从项目 `.claude/skills` 发现它：会话开始时只读取 description，做 UI 改动时才加载正文，需要细则再打开文档。
- **细则**：`docs/ui-design-system.md`（token、皮肤契约、基础组件、设置页布局、保存策略、检查清单）。
- **硬规则**：只用 token 与 `components/ui` 的基础组件；皮肤只覆盖 CSS 变量，不在组件里写死颜色；设置页只有一个滚动容器；偏好自动保存、实体表单显式保存；瞬态提示（保存状态等）用浮层、不占布局、数秒后自动移除；CC / DeepSeek × 明 / 暗四组都要检查。
- **优先级**：本仓库的 UI 以 `ui-design` 技能与 `docs/ui-design-system.md` 为准。`.ruobai/skills` 下若存在通用 UI 技能（例如 Material/Pinterest 风格的生成器），不得覆盖这里的 token、组件与皮肤契约。

## 7. 测试

- `pnpm test`（vitest）；全栈测试用 `tests/harness.ts`，新宿主插件记得挂进去。
- **测试要能失败**：不要为了跑绿而放宽断言或全部跳过。系统能力（Seatbelt 嵌套、进程组信号）用运行时探测决定 skip，并在测试名/注释里说明原因。
- 纯逻辑写单测（投影、分组、格式化）；涉及 OS 的行为写真实集成测试（Seatbelt、approval、子进程回收）。
- 不加网络依赖；测试默认离线、可重复。
- 提交前至少跑：`pnpm typecheck` + `pnpm test`；UI 改动再加 `pnpm build:ui`。

## 8. 类型与构建

- 双 tsconfig：根 `tsconfig.json` 覆盖 host/共享包（对 vendor 关闭 `noImplicitAny` 等）；`packages/ui-app/tsconfig.json` 是浏览器严格检查。
- `pnpm typecheck` 会跑两者；任何一个报错都视为未完成。
- 给浏览器共享的类型必须是纯类型文件（不 import cordis / node），否则 UI 侧会把 vendor 拉进严格检查。
- 新增 workspace 包后先 `pnpm install --offline --no-frozen-lockfile`，确认 `node_modules/@ruobai/<name>` 链接存在。
- 不引入新依赖除非确有必要；能用标准库或现有包解决的，不新增。

## 9. 文档与提交

- 非平凡机制要有设计文档（`docs/*.md`）：问题、约束、方案、失败模式、验证结果。实测数据进附录，不要只写结论。插件生态的阶段演进见 `docs/plugin-ecosystem-timeline.md`。
- 行为改变时同步更新文档与博客；博客讲判断与取舍，不记流水账。
- 提交信息：`type: 中文摘要`（feat / fix / refactor / docs / chore），正文写"为什么"而不是逐文件罗列。
- **提交交给卡片，不要用文字问**：本仓库的 harness 挂了 `commit-prompt`，回合正常结束时会自动弹出提交卡片；模型不要再输出「是否提交？」或把拟好的 message 放进代码块。需要手动唤起时用 `/commit`。只有不支持卡片的客户端，才用一句话问「是否提交」并**直接给出拟好的 message**。message 精简到一行标题（正文只在确有必要时补一句"为什么"），且**不要为了写它再思考一轮**——复用本次工作已有的结论，不再重新读 diff、重新梳理改动清单。提示本身也要短，不列文件、不复述过程。
- 不提交：`.env`、密钥、`.sessions/`、`.ruobai/`、`.idea/`、生成物（`dist/`、`node_modules/`）。
- 只暂存本次相关文件；不要 `git add -A` 把别人的在途改动带进来。

## 10. 常见禁区

- 不要嵌套 `sandbox-exec`（Seatbelt 不支持；会 exit 71）。
- 不要 monkey-patch `fs` 做守卫；副作用不可逆，且会污染 checkpoints / session 写入。
- 不要在 session 运行中直接 `prompt()`（会抛 "session is already running"）；测试里等 idle，UI 里用排队/禁用。
- 不要用 `setInterval` / `spawn` 而不在 `ctx.effect` 里清理。
- 不要用"配置看起来对"代替验证：先跑一条真实命令，再声称沙箱生效。

## 11. 常用命令

```bash
pnpm dev                    # 启动 harness（默认端口见 cordis.yml）
pnpm dev --port 4400        # 指定端口
pnpm dev --workspace ~/x    # 插件从本检出加载，状态写入 ~/x
pnpm desktop                # Electron 桌面端（先 pnpm build:ui 走静态产物）
pnpm typecheck              # host + ui 两套 tsconfig
pnpm test                   # 全量 vitest
pnpm build:ui               # 构建浏览器产物
curl localhost:4400/api/sandbox/status
```

---

维护方式：规范随代码演进。新增一条约束时，最好同时指出**它防止的事故**；没有事故背书的规则，不要写进来。

# 从一个空目录到可用的 Harness：Cordis 插件化开发手记

> 2026-10-24 · ruobai-harness
>
> 这篇记录从零搭建、到能接真实模型、再到写文件/审批/模式/上下文管理的完整过程。重点不是“用了什么库”，而是**每个插件被拆出来是为了解决什么问题**，以及那些踩过的坑。

## 0. 起点：为什么是 Cordis

目标很明确：做一个自己的、可以长期维护的 coding harness。它需要：

- 能接不同的模型提供方，而不是绑死一家；
- 会话可恢复、可回放，而不是内存里聊完就没了；
- 模型能读、能写、能跑工具，但危险动作要能拦住；
- 前端能持续加功能，而不是每加一个面板就改一次主应用；
- 所有能力都能单独替换、单独卸载。

dsh 的实现给了最直接的参考：**应用不是一堆 import，而是一棵插件树**。Cordis 的 `Context` 是服务容器，`Fiber` 是插件实例，`inject` 声明依赖，所有注册都是可撤销的 effect。于是第一版骨架只做一件事：让 `cordis.yml` 成为应用的唯一定义。

```
ruobai-harness/
├── cordis.yml
├── vendor/              # cordis / loader / include / timer / logger-console ...
├── packages/            # 每个能力一个包
├── apps/cli/            # 读配置、起 Context、挂 Loader
├── tests/               # 全栈测试的公共 harness
└── docs/
```

启动器只有十几行：建根 Context、挂 `Loader`、用 `Include` 读 `cordis.yml`。之后每加一个能力，都是“写一个插件、在配置里加一行”。

提交历史也基本对应三个阶段：

| 提交 | 内容 |
|---|---|
| `35b4e48` | 骨架：vendor 框架层、pnpm workspace、CLI、配置驱动启动 |
| `74e1b4c` | Web UI、LLM/会话/工具/agent、Web 适配器、供应商管理 |
| `d3e3bc0` | 写文件与审批、四种模式、上下文压缩 |

## 1. 骨架：把“应用”变成插件树

**要解决的问题**：应用入口不应该知道任何业务。启动顺序、依赖关系、热重载、卸载清理，这些都不该由人肉编排。

**做法**：

- 把 Cordis 及其 loader/include/group/timer/logger-console 以源码形式 vendor 进来（改名到 `@ruobai` scope），框架层完全自有、可改、可审计。
- pnpm workspace 把 vendor、packages、apps 串起来，开发期直接用源码运行（`tsx`），没有“先构建再启动”的负担。
- `cordis.yml` 是唯一的组装清单；插件顺序无关，`inject` 决定激活时机。

**得到的性质**：

- 插件只有在依赖的服务就绪后才 `apply`，不需要手写启动顺序。
- 每个注册都挂在 fiber 的 effect 上，卸载时逆序回卷；子插件随父插件一起销毁。
- 移除一个插件，不会在别处留下半截注册。

## 2. 第一个 UI 插件：让 harness 可被观察

**要解决的问题**：终端日志只能证明“它活着”，不能证明“它好用”。需要一个稳定的 Web 入口，而且这个入口本身也应该是插件。

**拆分**：

- `web-server`：通用 HTTP 宿主，只负责 guards → routes → fallback → upgrade，不认识任何业务。
- `ui-server`：聊天 API + SSE，注册 `/api`，是浏览器唯一认识的接口面。
- `web-static`：dev 下挂 Vite middleware，prod 下服务 `dist`，带 SPA fallback 与路径穿越防护。
- `ui-app`：React + Vite，桌面式三栏布局。
- `chat-protocol`：前后端共享的 wire types（纯类型，无运行时），避免前端把后端框架源码拖进类型检查。

**为什么拆这么细**：后面加鉴权、WebSocket、文件面板时，只需要新增插件或往 `web-server` 注册，而不是改一个越来越大的 `ui-server`。

## 3. LLM 层：接口稳定，提供方可换

**要解决的问题**：模型调用是最容易被某一家 SDK 绑死的地方。UI 不该知道用的是 DeepSeek 还是 OpenAI，会话也不该关心。

**插件分工**：

- `llm`：`ctx.llm`，统一 `text-delta / tool-call / done` 流协议，按 provider 注册适配器。
- `llm-mock`：离线、确定性的提供方，测试和没配 key 时的默认选择。
- `llm-openai`：OpenAI 兼容的 `/chat/completions` 适配器，覆盖 DeepSeek、OpenAI、Ollama、vLLM。
- `llm-catalog`：把设置里的供应商动态注册成适配器，增删改实时同步。

这里踩过一个很有代表性的坑：一开始 `llm-openai` 是一个按环境变量决定是否加载的静态配置项。用户在设置里选了 `openai`，但这个条目在启动时因为条件不满足没有加载，于是会话报 `unknown llm provider "openai"`。

**教训**：提供方不应该由“启动时的环境”决定，而应该由“运行时的配置”决定。于是把静态条目删掉，改成 `llm-catalog` 监听 `settings/updated`，按供应商列表注册/注销。设置里的改动立即生效，不需要重启。

供应商管理也顺势做成了类 CC Switch 的形态：名称、备注、官网、只写 API Key、请求地址、模型列表（可在线拉取 `/models`）、设为当前。密钥只存在服务端，浏览器永远只看到 `hasApiKey`。

## 4. 会话：事件日志是唯一事实

**要解决的问题**：内存会话重启即失；而且“消息列表”不足以支撑回放、审计、压缩、分支。

**做法**：

- `session`：追加式事件日志。`session/title`、`session/meta`、`message/user`、`message/assistant`、`tool/result`、`context/summary` 都是事件；标题、模型、模式、投影视图全部从日志推导。
- `session-jsonl`：每个会话一个 `.jsonl`，写操作按会话串行化，启动时重放恢复。坏掉的尾行会被跳过。

**收益**：对话历史、工具结果、压缩摘要共享同一条时间线；UI 只是对日志的一种投影。后面加“删除/重命名/fork”时，也不需要另建一套存储。

## 5. 工具与审批：能力与策略分开

**要解决的问题**：模型能读代码还不够，它需要能改代码；但“能改”不能等于“随便改”。

**拆分**：

- `tools`：工具注册表 + 执行管线。工具定义包含 schema、preview、execute；执行失败以 `isError` 结果返回给模型，而不是抛异常打断回合。
- `tool-fs`：`read_file`、`list_dir`、`write_file`、`edit_file`，全部限定工作区，写入原子化，`edit_file` 要求被替换文本唯一。
- `tool-bash`：`bash` 命令执行。cwd 限制在工作区、超时杀掉整个进程组、stdout/stderr 分别截断、清洗掉 Harness 自己的密钥环境变量；同样走审批，审批卡里直接展示要执行的命令。
- `approval`：写操作挂起等待决定；`approval/requested` / `approval/resolved` 事件推给 UI；支持允许一次、始终允许（会话 + 工具维度）、拒绝、回合取消自动拒绝；设置里可以整体绕过。

关键设计是**能力与策略解耦**：工具只声明 `requiresApproval: true` 和一份 `preview`（摘要 + diff），审批服务决定怎么问、问谁、能不能不问。这样以后加 `bash`、加 MCP 工具，不需要改审批逻辑。

MCP 也按同一原则拆开：`mcp` 只负责连接与工具代理（stdio JSON-RPC、超时取消、断线重连、`tools/list_changed` 后刷新），`mcp-catalog` 把设置里的服务列表同步成运行时连接，`mcp-web` 提供配置与状态接口。工具统一命名为 `mcp__<server>__<tool>`，审批策略按服务配置：默认自动（带 `readOnlyHint` 的工具免审批），也可以强制逐次审批或完全免审批。服务端的环境变量只写不读，HTTP 响应里只出现变量名；服务配置改动会热加载，不需要重启。

## 6. Agent：把一次对话变成一次任务

**要解决的问题**：模型返回工具调用后，谁负责执行、把结果写回、再继续问模型？这段编排不应该塞进 UI 或聊天服务。

`agent` 的每一轮：

1. 解析会话的 provider/model/mode；
2. 触发上下文压缩（如果超阈值）；
3. 组装请求（system + 历史 + 模式提示 + 临时消息）；
4. 流式收模型输出，文本增量只发事件、不落盘；
5. 把组装后的 assistant 消息和工具结果写入事件日志；
6. 执行工具（按模式过滤、按需审批），循环直到模型不再调用工具。

此外还有取消（AbortController 贯穿模型流、工具、审批）、错误落成 `turn/error`、以及 Goal 模式的自主循环。

## 7. Web 边界：把安全与传输也做成插件

**要解决的问题**：一个 `ui-server` 同时干 HTTP、静态资源、鉴权、WebSocket，最后一定会变成最难改的文件。

拆成：

- `web-server`：路由表、guards、fallback、upgrade 注册；
- `ui-server`：聊天 API、SSE、审批与模式接口；
- `web-static`：Vite/静态资源；
- `web-auth`：可选 token（Bearer / Cookie / `?token=`）、Origin 校验；
- `web-ws`：`/api/ws` 下行，UI 优先 WS、失败回落 SSE。

这一层踩坑最多，也都记录在这里：

1. **启动竞态**：服务先 listen，Vite 还没就绪，首页返回 `not found`。修复是静态插件先注册 fallback，内部 `await ready`，早期请求等待而不是 404。
2. **HMR 升级冲突**：通用 upgrade 监听器会销毁所有不在自己表里的路径，连 Vite 的 HMR socket 一起杀掉。改成“只处理已注册路径，其余放行”。
3. **localhost 与 ::1**：服务绑 `127.0.0.1`，浏览器把 `localhost` 解析到 `::1`，HTTP 会回退但 WebSocket 不会。前端把 WS 的 host 固定为 `127.0.0.1`，同时给 Vite 设置正确的 HMR host/端口。
4. **依赖缓存**：新装前端依赖后，已经运行的 Vite 解析缓存不会自动更新，`react-markdown` 报找不到模块。重启 dev server 即可。

## 8. 工作区与设置：给 UI 提供“可看可改”的边界

- `workspace` + `workspace-web`：只读文件树与文件内容 API，带路径穿越防护和大小限制，支撑右栏 Files 面板。
- `settings` + `settings-web`：JSON 设置，供应商密钥只写不读；新增的 `agent` 段承载默认模式、审批绕过、压缩阈值。

## 9. 模式：行为差异不该写成 if/else

**要解决的问题**：Ask（只读问答）、Plan（只读出方案）、Agent（执行任务）、Goal（多轮自主推进）的行为差异，如果写在 agent 里，会变成一堆条件分支，而且新增模式要改核心代码。

**做法**：

- `modes` 只做注册表；每个模式是一个独立包。
- Ask / Plan 声明只读工具白名单；Agent 不限制；Goal 额外提供 `goal_complete` 工具、提高步数上限、开启自主推进（文本停顿时 nudge，最多两次，完成后由工具收尾）。
- 模式按会话保存，请求时按模式过滤工具；模型越权调用会被拒绝并回给模型。
- 移除某个模式包，它就从 UI 和运行时一起消失。

**收益**：模式是“策略插件”，不是核心里的枚举。

## 10. 上下文管理：长会话必须能自己腾地方

**要解决的问题**：工具输出很容易把上下文撑爆；同时工作区约定（`AGENTS.md` / `CLAUDE.md`）需要自动进入系统提示。

`context` 服务负责：

- 组装 system：基础提示 + 模式提示 + 工作区说明；
- 维护 `context/summary` 事件：最新摘要之前的消息不再进入请求；
- 估算 token（中英混合按字符/3），超过设置阈值时调用当前模型总结较早消息，保留最近消息；
- 给 UI 提供 `~tokens / 阈值 / 摘要数`。

原始日志不删，摘要只是请求侧的一个投影，所以回放和审计仍然完整。

## 11. 前端可扩展：slot 与动态客户端插件

**要解决的问题**：UI 功能以后会不断加，但不应该每加一个面板就改 `App.tsx`。

- `ui-slots`：与框架无关的 slot 注册表，UI 在侧栏底部、顶栏、详情面板预留挂载点。
- `client-api`：客户端插件拿到的运行时类型（React、createElement、slots）。
- `client-modules`：扫描 loader 条目里 `package.json` 的 `rbu.client`，用 esbuild 打成 ESM，注入 host React shim，通过 `/plugins/<id>/client.js` 下发；UI 在运行时加载并执行。
- `plugin-welcome`：示例双端插件，往两个 slot 注册卡片和徽标。

这样“插件”不只属于后端：一个包可以同时有服务端 half 和浏览器 half。

## 12. 交互细节：从“能看”到“好用”

UI 第一版之后集中修了一轮体验问题，也都值得记录：

- **聊天区不滚动、输入框消失**：grid 子项没有 `min-height: 0`，主区被内容撑到 5 万像素，输入框被推到视口外。修复后消息区内部滚动、输入框吸底。
- **工具卡片太占空间**：默认折叠，只留一行“工具名 + 格式化参数”，点击展开。
- **Assistant 标签多余**：去掉头像和名字，直接呈现内容。
- **Markdown 不渲染**：接入 `react-markdown` + `remark-gfm`，补齐标题、列表、代码块、表格、引用样式。
- **StrictMode 双执行**：首次加载创建了两个会话。用模块级共享的 bootstrap Promise 解决。
- **点击当前会话会清空**：`activeId` 没变化导致加载 effect 不触发。改为同会话点击 no-op。
- **工具行间距过大**：连续的工具消息收紧间距，接近 Claude Code Desktop 的密度。

## 13. 复盘：拆插件的判断标准

| 插件 | 解决的问题 | 如果不拆 |
|---|---|---|
| `web-server` / `ui-server` / `web-static` / `web-auth` / `web-ws` | 传输、静态资源、鉴权、推送各自独立 | 一个巨型 server，改一处牵全身 |
| `llm` / `llm-mock` / `llm-openai` / `llm-catalog` | 统一流协议、离线开发、提供方可换 | 业务代码散落各家 SDK |
| `settings` / `settings-web` | 运行时配置与密钥边界 | 每次改配置都要重启、密钥进前端 |
| `session` / `session-jsonl` | 持久化、回放、投影 | 内存会话、无法审计与压缩 |
| `tools` / `tool-fs` / `approval` | 能力与策略分离 | 写操作要么全放开，要么写死在核心 |
| `tool-bash` | 受控的命令执行 | 模型能读能写却无法验证，或者在核心里塞一个 shell |
| `mcp` / `mcp-catalog` / `mcp-web` | 外部工具接入与运行时配置 | 每接一个工具就改一次核心，或把协议塞进 agent |
| `session` 的搜索/重命名/fork/删除 | 会话生命周期与运行中状态 | 测试会话越堆越多，无法分叉试错 |
| `agent` | 回合编排与取消 | UI/聊天服务承担循环逻辑 |
| `modes` / `mode-*` | 行为差异插件化 | 核心里的 if/else 越堆越多 |
| `context` | 提示组装与压缩 | 长会话失控、工作区约定靠人贴 |
| `workspace` / `workspace-web` | 只读文件边界 | UI 直接读盘，路径与大小失控 |
| `chat-protocol` / `chat` | 稳定的前端契约 | 前端直接依赖后端实现 |
| `ui-app` / `ui-slots` / `client-modules` | UI 外壳与扩展点 | 每加面板都改主应用 |

几条我认为最重要的原则：

1. **一个服务只承担一种能力**，策略（审批、模式、压缩阈值）放在独立插件里。
2. **wire 协议单独成包**，前后端只共享类型，不共享实现。
3. **所有注册都必须是 effect**，否则“可插拔”只是口号。
4. **运行时配置驱动注册**（供应商、模式），不要在启动时写死。
5. **错误要进入上下文**（工具失败、审批拒绝、模型错误），让模型能自己纠正。

## 14. 当前边界与下一步

已经可用：真实 DeepSeek 对话、供应商管理、事件日志与恢复、读写文件与 Bash、逐次审批与 diff、四种模式、上下文压缩、会话搜索/重命名/fork/删除、MCP 客户端（设置内热加载）、文件面板、设置、客户端插件。

还没做或只做了基础：

- 没有子 agent；
- Goal 模式的真实模型长目标只做了单测（脚本化提供方），没有浏览器长跑；
- 单进程、无多用户，鉴权默认只适合本机；
- 审批粒度到工具级，还没有“目录级/命令级”策略；
- Bash 的“沙箱”只是进程级约束（工作区 cwd、超时、输出上限、环境清洗），不是内核级隔离。

下一步做子 agent；再往后是更细的审批策略和真正的沙箱。会话侧栏已经能区分“运行中”的会话，并支持搜索、重命名、fork 与删除。

## 15. 运行

```bash
pnpm install
pnpm dev        # http://127.0.0.1:4310
pnpm test       # 62 个测试
pnpm typecheck
pnpm build:ui
```

真实模型建议在 UI 的“设置 → 供应商”里配置。环境变量可以作为首次启动的回退（密钥不会写盘）：

```bash
DEEPSEEK_API_KEY=sk-... \
RBU_BASE_URL=https://api.deepseek.com/v1 \
pnpm dev
```

首次启动会在缺少供应商配置时生成一个 DeepSeek 条目；如果环境里有 `DEEPSEEK_API_KEY`，它会成为当前供应商并直接可用，否则当前仍是离线 `mock`，等你填密钥。从环境读取的密钥不落盘；在设置里主动填写的密钥会保存在 `.ruobai/settings.json`（已在 `.gitignore` 中）。上下文压缩阈值可以用 `RBU_COMPACT_AT` 覆盖。写操作默认逐次审批，可在“设置 → 行为与权限”里绕过。

MCP 服务在“设置 → MCP”里添加，例如 `command: npx`、参数逐行填写 `-y`、`@modelcontextprotocol/server-filesystem`、`.`。保存即连接，工具会以 `mcp__服务名__工具名` 出现在 Agent / Goal 模式中。

---

写完这篇回头看，最有价值的不是某一层实现，而是那条约束：**任何东西都必须能被单独拿掉**。只要坚持这一点，插件边界就会自己浮出来。

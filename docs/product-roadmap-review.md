# 产品 Roadmap 评审：哪些采纳、哪些不采纳

评审对象：`docs/豆包站在产品经理角度给出了如下意见.md`（下称"Roadmap"）。

评审基线：当前 `main`（2026-10-28），`packages/` 下 74 个插件包、`cordis.yml` 的实际装配。判断以代码与实测为准，不以 Roadmap 的描述为准。

## 0. 结论

1. **Roadmap 约三分之二的内容已经存在**，只是名字不同：知识库= `wiki*`，MCP= `mcp*`，轨迹= `trajectory*`，命令面板= `⌘K`，步骤校验= `hooks` + `lint`，插件管理= 设置里的热开关。按 Roadmap 重做会造出第二套重复实现。
2. **采纳 4 项**，都是真实的空白：密钥离开明文、任务清单与目标保护、会话导出、供应商预设与连通性校验。
3. **不采纳 4 类**：与本地单用户定位冲突的（RBAC、多租户、云端同步、插件市场）、与既有架构冲突的（任务 DAG 第二状态机、沙箱自动升降级、逐行拒绝写入）、与模型行为重复的（reflection-loop、intent-clarifier、debug-loop）、成本远大于收益的（TreeSitter 索引、Linux 容器沙箱、多智能体框架）。
4. **Roadmap 的版本划分方式不适用**：它按"PM 的全部想象"排优先级，而本仓库的真实短板在 `docs/plugin-ecosystem-timeline.md` 的 `next` 行：可移植的沙箱 provider、轨迹性能、密钥边界。评审后采纳的四项都落在这条线上。

## 1. 判断标准

一条建议只有同时满足下面四条才进入本轮实现：

| 标准 | 含义 | 反例 |
| --- | --- | --- |
| 真实空白 | 当前代码里没有，且没有等价能力 | "会话列表/搜索/重命名"已有 |
| 架构一致 | 能做成插件，状态先落事件日志，不引入第二事实源 | 任务 DAG 直接改内存状态 |
| 边界不放宽 | 不新增绕过沙箱/审批/fail-closed 的路径 | "自动升降级沙箱严格度" |
| 成本可回收 | 不引入原生依赖或不可逆迁移；单项可在一轮内验证 | TreeSitter、容器沙箱 |

## 2. 逐条评审

判定：✅ 已有（代码为准）｜🟢 采纳（本轮实现）｜🟡 缓做（方向对，时机不对）｜🔴 不采纳（并给出理由）

### 2.1 v0.1 原有模块

| Roadmap 条目 | 判定 | 依据 / 理由 |
| --- | --- | --- |
| 知识库：本地轻量检索 + 默认分片 | ✅ | `packages/wiki`：BM25 + CJK bigram + 标题/标签加权；`wiki-embed` 可选向量并按 RRF 融合 |
| 知识库：上传 / 索引状态 / 结果可视化 | ✅ | `ui-app` 的 `KnowledgeWorkspace` 三视图；`/api/wiki` 窄快照 |
| 知识库：沙箱默认开放 docs | ✅ | `sandbox-policy` 的 root 是 `process.cwd()`，工作区内读写本来就可读；需要放宽的是 root 之外，那不该默认开放 |
| 知识库：检索失败指引 | 🟡 | 错误已显示在文档栏；"关联常见解决方案"是文案工作，优先级低于下面四项 |
| 编排：统一任务面板 | 🟢 | 确实没有。但不该做 DAG 调度器；做**会话级任务清单**（见 3.2） |
| 编排：默认编排插件组合 | ✅ | `cordis.yml` 本身就是组合；`mode-goal` 负责自主推进 |
| 编排：任务暂停 / 终止 | ✅ | `agent.stop` 已支持回合中断；排队消息与中断在最近两个提交里刚补齐 |
| 编排：核心目标避免压缩丢失 | 🟢 | 压缩摘要已保留 `Primary Request` 与用户消息，但**没有结构化、跨压缩稳定的目标载体**；任务清单同时解决这件事（注入系统提示、不参与裁剪） |
| 沙箱：可视化权限面板（目录/网络/命令白名单勾选） | 🔴 | 面板已有（`sandbox-web`：开关、provider、网络模式、守卫、拒绝记录、升级策略），但**不能编辑白名单**是有意为之：策略是 `cordis.yml` 里的代码，可在 UI 改就等于让 agent 能写开自己的边界。拒绝记录 + 升级审批已经覆盖"看懂为什么被拦" |
| 沙箱：编码场景默认规则集 | ✅ | `sandbox-policy` + `sandbox-guards` + `sandbox-macos` 的实测配置 |
| 沙箱：拦截提示分层（沙箱 vs 审批） | ✅ | `sandbox-denial` / `sandbox-escalation` / `approval` 是三条独立事件与三个 UI 呈现，不会混淆 |
| 沙箱：统一适配层 | ✅ | `ctx.sandbox` Service；`shell-sandboxed` 只认它 |
| 模型：主流模型模板一键接入 | 🟢 | 只预置了 DeepSeek；补常见 OpenAI 兼容供应商预设（见 3.4） |
| 模型：离线 mock 支持工具调用 | ✅ | `llm-mock` 已按输入产出 `tool-call`，并消费 `tool-result` |
| 模型：配置校验与报错引导 | 🟢 | 已有"拉取模型"接口；缺**保存前的连通性校验**与可行动的错误文案（见 3.4） |
| UI：统一布局 / 加载错误态 | ✅ | 设置重构、功能轨道、错误条已完成 |
| UI：命令面板 | ✅ | `command-palette-model.ts`：14 条命令 + 会话检索 |
| UI：项目工作区隔离 | ✅ | `workspace` + 每会话 `workspace` 字段 + 工作区选择器 |
| 会话：列表 / 搜索 / 重命名 | ✅ | `Sidebar.tsx`、`session.rename`、`PATCH /api/sessions/:id` |
| 会话：Token 消耗按步骤 | ✅ | `trajectory.usage` 投影按轮/步聚合；`TrajectoryView` 与 `StatsLine` 展示 |
| 会话：统一入口 / 状态同步 | ✅ | WebSocket + SSE 双通道，首帧对账 |

### 2.2 v0.1 新增能力

| Roadmap 条目 | 判定 | 依据 / 理由 |
| --- | --- | --- |
| `secret-manager`：系统密钥链 | 🟢 | **真实空白**。现在 `provider.apiKey`、Gitee token、MCP `env` 明文写在 `.ruobai/settings.json`（0644）。见 3.1 |
| Diff 预览（原文件/修改后/统一 diff、逐行确认、单处拒绝） | 🔴 | 三种视图已有：工具卡内逐行 diff、审批卡 diff、Git 面板 unified diff。缺的是**逐行/单块拒绝**——它与"整文件写入 + 内容寻址检查点"模型冲突：部分接受会留下模型没见过的半文件状态，下一次编辑基于错误前提；模型也无法从"你拒绝第 37 行"里恢复。整单拒绝 + 说明理由，模型能重写；逐行接受不能 |
| `step-validator`：工具后置校验并阻断 | 🔴 | 已有两道更可靠的机制：`hooks.guard`（危险命令/路径，权限之前）与 `hooks.afterTool`（写文件后跑 edit 层，只回传新增/恶化诊断）。exit code 与 stderr 本来就会回给模型。"独立校验插件"只会重复模型自己的纠错，并把环境问题误判成步骤失败 |

### 2.3 v0.2 原有模块

| Roadmap 条目 | 判定 | 依据 / 理由 |
| --- | --- | --- |
| 知识库：多路召回 / 增量 / 快照 / 元数据 / Obsidian | ✅（前四项） | BM25+RRF、mtime+size 增量、`wiki/recalled` 事件、置信度与来源；Obsidian 仅支持 `[[id]]` 与 Markdown，不承诺完整 vault 语义 |
| 编排：拓扑视图 / 重试 / 回滚 / 中途干预 / 失败归因 | 🟡🔴 | 拓扑与 DAG 重试需要第二套状态机，会和 append-only 日志打架；回滚已有 `checkpoints.revert`；中途干预已有排队与权限热切换。失败归因有价值，但应作为轨迹的只读派生，不进入本轮 |
| 沙箱：Linux 容器 | 🟡 | 与仓库 `next` 行的 "Linux/Windows provider" 同向，但工作量是另一个数量级；本轮不做 |
| 沙箱：自动映射本地依赖 | 🔴 | "映射"边界不可定义；工作区就是映射。放宽 PATH/挂载等于绕过 fail-closed |
| 沙箱：审计面板 / 导出 | 🟡 | 拒绝记录已有；导出是低成本的后续项 |
| 沙箱：三级权限预设 | ✅ | `permissions` 已有四档（read-only / workspace-write / full-access / auto-review） |
| 模型：场景化绑定 / 测速 / 成本 / 多模型切换 / 限流 | ✅🟡 | 同一会话可换模型已有；场景化绑定与测速需要产品定义（谁来决定编码用哪个模型？），缓做；限流属于成本护栏，见 2.6 |
| UI：轨迹面板 / 响应式 / 错误中心 / 拖拽布局 | ✅✅🔴🔴 | 轨迹已有；错误中心可用现有错误条 + 轨迹失败标记，聚合面板收益低；拖拽布局是 YAGNI |
| 会话：回放 / 标签归档 / 导出 / 压缩可视化 | 🟡✅🟢✅ | 回放受限于"事件可重放但副作用不可重放"，只做只读轨迹；归档已有；导出见 3.3；压缩可视化已有 |
| 插件生态：管理器 / 教程 / 依赖可视化 | ✅✅🔴 | 热开关与插件页已有；依赖可视化对一个 74 包的本地仓库是装饰 |

### 2.4 v0.2 新增能力

| Roadmap 条目 | 判定 | 理由 |
| --- | --- | --- |
| `reflection-loop` 双循环 | 🔴 | 与 agent 原生循环重复：模型看到工具结果后本就会修正。外循环没有新信息，只会增加一次模型调用与延迟；"超限升级人工"已有审批超时 fail-closed |
| `intent-clarifier` 前置澄清 | 🔴 | 用轻量模型判断"指令是否完整"不可靠，误判会让用户多答一轮；Ask/Plan 模式已把"先问清楚"交给模型自己决定。对 coding agent，先声明假设再干通常优于先追问 |
| `code-index`（TreeSitter） | 🟡 | 需要原生解析器（违反"不引入新依赖"），且会形成第二份代码真相；`workspace` 的 grep 与 `context_search` 已覆盖大部分检索。真要做得先证明 grep 不够 |
| `debug-loop` | 🔴 | 就是 agent 的日常行为；"自动捕获运行报错"需要绑定具体运行器，边界不清 |
| 任务断点续跑 | 🟡 | 会话日志已经在磁盘，重启后会话可继续；"自动扫描并恢复任务"需要有任务实体，而任务 DAG 本身不采纳 |
| `cost-control` 预算 / 限流 / 熔断 | 🟢（部分） | 真实空白：`llm` 层没有预算与成本表。本轮只做**会话级 token 预算**（软提示 + 硬停止点），不做 QPS/多级熔断——见"后续" |
| `mcp-bridge` | ✅ | `mcp` 已实现 stdio JSON-RPC、工具发现、`readOnlyHint`、审批策略；差的是远程 SSE/HTTP，缓做 |
| 标准化插件 SDK | 🟡 | 生态尚不存在，SDK 会把未稳定的接口固化。`AGENTS.md` 已经是最好的规范 |

### 2.5 v0.3

| 条目组 | 判定 | 理由 |
| --- | --- | --- |
| 知识协作 / 多人权限 / 审核发布 | 🔴 | 单用户本地应用，没有用户体系；`web-auth` 只有一个共享 token。这是另一个产品 |
| 编码卡点 / Git 绑定 / 场景模板 | ✅🟡 | lint/typecheck 门禁与检查点已有；场景模板是提示词资产，不是能力 |
| 服务端部署 / 动态权限 / 合规报告 | 🔴 | 动态升降级直接破坏 fail-closed；合规报告没有合规对象 |
| 私有模型 / 成本看板 / 缓存收益 / 多租户 | ✅🟡🟡🔴 | OpenAI 兼容 baseUrl 已支持私有部署；缓存收益已有 `docs/prompt-cache.md` 与统计；多租户不适用 |
| 调试断点 / 终端面板 / 多工作区 / 主题 | 🔴🟡🟡✅ | LLM 没有传统断点语义；终端与多工作区是编辑器的事；暗色模式已有 |
| 分享 / 模板 / 全量检索 / 云同步 | 🔴🟡🟡🔴 | 云同步与本地优先冲突；全量事件检索可做，但不是当前瓶颈 |
| 插件市场 / 审核 / 监控 / 熔断 | 🔴 | 没有第三方插件，市场是空转 |
| `multi-agent` | 🔴 | `tool-task` 已有本地子代理，`a2a` 已有远程 agent 协议。角色框架是包装，不产生新能力；按角色分级沙箱权限会制造更多边界 |
| `devops-integration` | ✅（大部分） | Git 状态/提交/分支/远端、Gitee 仓库/Issue/PR 已有；CI 监听属于外部轮询，缓做 |
| `language-adapter` | 🔴 | agent 本身与语言无关；"适配层"没有可执行的具体收益 |
| `observability` | 🟡 | 轨迹已覆盖 token/耗时/失败；聚合大盘等有真实多会话数据再说 |
| `code-compliance` | 🟡 | 写前密钥扫描有真实价值，但误报会直接打断编码；应做成可配置的软告警，不是"自动拦截写入" |
| `rbac-audit` | 🔴 | 同 2.5 第一行 |
| 全离线私有化 | ✅（大体） | 已是本地优先：mock provider、本地 BM25、本地文件；差的是打包与本地模型说明，不是架构改动 |

## 3. 采纳清单（本轮实现）

### 3.1 `@ruobai/secrets`：密钥离开 settings.json

**问题**：`settings.persist()` 把 `apiKey` / Gitee token / MCP env 原样写入 `.ruobai/settings.json`，文件权限 0644。任何能读用户目录的进程都能拿到。

**方案**：
- 新插件 `@ruobai/secrets`，提供 `ctx.secrets` Service；后端按平台选择：
  - macOS：系统钥匙串（`security` CLI，密码经 stdin 传入，不出现在 argv）；
  - 其他平台或钥匙串不可用：`.ruobai/secrets.json` 独立文件，权限 0600，原子写入。
- `settings` 在读取时优先问 `ctx.secrets`，写入时把密钥交给它并从 JSON 中删除；插件未挂载时保持旧行为（明文），保证可卸载。
- 启动时一次性迁移已有明文密钥，迁移成功才改写 settings.json。
- 暴露后端名称与迁移结果，便于设置页显示"由系统钥匙串保管"。

**边界**：MCP 的 `env` 是任意键值（可能包含非密钥配置），本轮只迁移 provider key 与 Gitee token；MCP env 的拆分需要单独的模型，留作后续。

**状态**：已实现。`packages/secrets`、`settings` 的 `adoptSecrets`/`apiKeyFor`、`cordis.yml` 的 `secrets` 行；设计与失败模式见 [`docs/secrets.md`](secrets.md)。

### 3.2 `@ruobai/todo`：会话级任务清单

**问题**：长任务里，模型没有稳定的地方记录"做到哪一步"，压缩之后更容易漂移；用户也看不到进度。

**方案**：
- 工具 `todo_write`：整表替换（不是增量），字段 `{id, text, status: pending|in_progress|completed}`，校验最多一个 `in_progress`。
- 事件 `todo/updated` 落日志；投影 `todo` 提供 `{items, updatedAt, rev}`。
- 系统提示注入当前清单（通过 `context` 的 section 接口），且该 section 不参与工具结果裁剪——目标不会因压缩丢失。
- UI：输入框上方一条可折叠清单；只在有任务时出现。
- 与 `mode-goal` 的关系：goal 决定"继续跑"，todo 决定"跑到哪"，两者独立。

**不做**：依赖图、并行调度、自动重试。这些需要第二套状态机，和 append-only 会话模型冲突。

**状态**：已实现。`packages/todo`（工具/事件/投影/提示）、`packages/todo-web`（快照与推送）、`ui-app` 的 `TodoPanel`；见 [`docs/todo.md`](todo.md)。

### 3.3 会话导出

- 新插件 `@ruobai/session-export`，`GET /api/export/session/:id.md` 输出 Markdown（用户/助手正文、工具调用与结果的折叠摘要、token 小计），`?format=jsonl` 输出原始事件。
- 命令面板加一条"导出当前会话"，在新标签打开下载地址。
- 只读，不触发模型，不改变会话。

**状态**：已实现。`packages/session-export`，命令面板新增“导出当前会话”；见 [`docs/session-export.md`](session-export.md)。

### 3.4 供应商预设与连通性校验

- `settings-web` 暴露 `GET /api/settings/provider-presets`：DeepSeek、OpenAI、OpenRouter、Moonshot、智谱、通义、Ollama、LM Studio 的 baseUrl / 默认模型 / 备注。
- 供应商编辑页加"从预设填入"，不改变后端存储模型。
- 保存前用现有"拉取模型"接口做一次连通性探测，失败时给出可行动文案（401=key 错、404=baseUrl 路径错、超时=网络/代理），但不阻止保存（离线配置合法）。

**状态**：已实现。`settings-web` 的 `/api/providers/presets` 与错误文案，供应商表单的“从预设填入”。

## 4. 本轮明确不做

| 项 | 理由 |
| --- | --- |
| 逐行/单块拒绝 diff | 与整文件写入 + 检查点模型冲突，模型无法从部分拒绝中恢复 |
| 任务 DAG / 拓扑 / 断点续跑 | 第二状态机；会话与检查点已提供可恢复性 |
| 沙箱权限在线编辑 | 策略即可执行边界，必须在代码里可审；UI 编辑等于给 agent 开洞 |
| RBAC / 多租户 / 云同步 / 插件市场 | 与本地单用户定位冲突，且没有用户体系 |
| reflection / intent / debug 三个循环 | 与模型原生行为重复，增加延迟与误判 |
| TreeSitter 索引 / 语言适配层 / 多智能体框架 | 成本不可回收或无具体收益 |
| QPS 限流与多级熔断 | 单用户本地调用没有并发压力；预算护栏足够 |

## 5. 后续（按真实短板排序）

1. 沙箱 provider 的 Linux/Windows 实现（仓库既定的 `next`）。
2. MCP 远程 SSE / Streamable HTTP 传输。
3. 轨迹行级虚拟化与时间概览（长会话性能）。
4. MCP env 的 "密钥 / 普通配置" 分离。
5. 会话级 token 预算的 UI 配置与按模型价格表估算。

# Prompt Cache 交互设计

本文记录 ruobai-harness 与提供方 KV cache（prompt cache）的交互设计：现状审计、Claude Code / Codex 的做法、目标方案、失败模式与实施顺序。上下文压缩本身见 `docs/compaction.md`；两者共用同一条装配路径，但预算与代价模型不同。

## 1. 缓存的基本规则

所有主流提供方都是**前缀缓存**：请求按渲染顺序拼成 `tools → system → messages`，缓存键是某个断点之前的**精确字节**。位置 N 处有任何一个字节不同，N 之后全部失效。

由此推出三条硬约束：

1. **只追加**。历史可以往后长，不能回头改；任何"投影"（裁剪、折叠、重写）都是一次前缀失效。
2. **稳定性排序**。从不变化的放最前，每会话变化的放中间，每次请求变化的放最后（最好没有）。
3. **缓存按模型隔离**，且通常按会话/前缀桶路由。换模型、换工具集即换缓存。

各家的规格差异（写入与本仓库 provider 目录，不写死在逻辑里）：

| 提供方 | 前缀粒度 | 最小可缓存 | 读取价 | 写入价 | 默认 TTL | 显式断点 |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic | 精确字节 | 512–4096（按模型，非单调） | 0.1×（部分新模型 0.025–0.05×） | 1.25×（5m）/ 2×（1h） | 5m，可 1h | 是，≤4 个 |
| OpenAI | 1024 token 起，128 递增 | 1024 | 按模型的读取折扣 | 2026 起写入计费，长保留档更高 | 分钟级，另有更长档 | 否（自动），`prompt_cache_key` 只影响路由 |
| DeepSeek | 64 token 块 | 64 | 约 0.1× | 未命中按原价 | 小时级 | 否（自动） |

Anthropic 还有一条对本设计很关键的分层：**工具定义、system、messages 是三段独立的缓存层**。改 messages 不动 system/tools；改 system 不动 tools。这决定了"动态内容放哪里"的收益上限。

## 2. 改造前的现状

一次模型请求的装配路径：

```
ContextService.build()                          packages/context/src/index.ts:263
  system = basePrompt + modePrompt + AGENTS.md + skills + summary + restored   :271
  visible = events[seq > summary.upToSeq]                                      :280
  pruned  = pruneToolResults(visible, config)                                  :281
  messages = visible 逐事件映射 + extraMessages                                :292
AgentService.request()                          packages/agent/src/index.ts:500
  tools = ctx.tools.list() 过滤 mode 与 permissions                            :604
  messages = [system, ...built]                                                :517
OpenAiProvider.stream()                         packages/llm-openai/src/index.ts:122
  payload = { model, messages, tools, ... }                                    :141
```

有利的一面：

- 模型视图从事件日志重建，**正常情况下严格只追加**；UI 折叠、轨迹、错误通知都不进请求。
- `Usage` 已经按"互斥计数"归一（`inputTokens` 不含缓存），`cachedInputTokens / (input + cached + write)` 就是命中率，UI 的 `cacheHitRate()` 已经在用。
- 压缩是显式的 epoch：`context/summary` 落日志，之后从头重建，语义干净。

**基线**（默认配置；字符数为实测，工具 schema 按源码估算）：system 的静态部分约 3.5k tokens——`AGENTS.md` 9,268 字符（≈3.1k tokens）、基础提示约 70 tokens、skills 目录若干；工具 schema 是 6 个内置工具（`read_file` / `list_dir` / `write_file` / `edit_file` / `bash` / `task`）加 skills 工具，未配 MCP 时约 1k tokens。这个体量在所有提供方的最小可缓存长度之上，值得缓存。一次 40k 上下文的会话，命中意味着这 39k 按读取价计费，不命中则按原价（Anthropic 还要再付 1.25× 的写入）——每一步。

不利的一面：装配路径上有五处会改写已经发送过的字节。按影响排序：

### 2.1 工具结果裁剪不是单调的（最严重）

`pruneToolResults()` 每次从**尾部**数最近 8 条工具结果，其余超过 8k 字符的保留头尾。于是每条新的大结果进来，都会有**一条更早的结果从"完整"变成"头 3k + 尾 2k"**：

```
step N    : [r1 完整][r2 完整] ... [r8 完整]
step N+1  : [r1 裁剪][r2 完整] ... [r8 完整][r9 完整]
             ↑ 前缀在这里断掉
```

用本仓库的 `pruneToolResults()` 实测（8 条 9k 字符结果，`keepRecent: 8`）：

```
step N    : pruned = []        seq1 = 9,002 字符
step N+1  : pruned = [1]       seq1 = 5,020 字符
释放 3,980 字符，作废 72,016 字符 —— 比值 0.055
```

`r1` 的正文变了，从它往后的整段历史都要重新计费；而省下的只是 4k 字符。后面 §4.2 的成本公式会给出这条比值要多少才划算。

同一原因还让 Context 页的 `pruned` 列表每步漂移，无法用来解释"上一步到底发的是什么"。

### 2.2 工具数组会变

`tools` 在请求里排第一，工具集变了整条缓存全废。当前它同时受两个因素过滤（`packages/agent/src/index.ts:604`）：

- **模式**：`mode-ask` / `mode-plan` 的 `allowTools` 只列了只读工具（其中 `grep` / `glob` 尚未注册，实际生效的是 `read_file` / `list_dir`），`mode-agent` 全给；切换模式即换工具集。
- **权限**：`read-only` 会隐藏所有非只读工具（`packages/permissions/src/index.ts:57`）；中途收紧权限即换工具集。

而拒绝执行其实已经有两道硬边界：`ToolRegistry.invoke()` 会直接返回"not available in X mode"（`packages/tools/src/index.ts:113`），审批层也按权限决策。**隐藏工具是体验优化，不是安全边界**——所以它可以为缓存让路。

### 2.3 工具顺序未定义

`ToolRegistry.list()` 返回 `Map` 的插入序（`packages/tools/src/index.ts:89`），即插件加载顺序。同一进程内稳定，但同一组工具在不同加载顺序下字节不同。缓存键是字节，这里必须显式排序。

### 2.4 其余输入

- `basePrompt`、`modePrompt`、`AGENTS.md`、skills 目录都在 system 里，均为会话级稳定；`AGENTS.md` 被编辑或 skills 增删时会变（5s TTL 后生效）。这是合法变化，但目前没有留下"前缀因何中断"的记录。
- `summary`、`restoredFiles` 随压缩变化。**把摘要从 system 移到 messages 并不省缓存**：压缩时 messages 本来就会失效，Anthropic 的分层里 system 变化也只是多废掉 system 这一层；收益不足以改动布局。
- 侧调用（摘要、后台记忆）与会话主请求共用 provider，但没有区分"这条前缀不会被再次读取"。给它们写缓存是纯支出。

以上五处在本次实施中已按 §4 处理；本节保留为问题记录，§11 记录落地结果。

## 3. Claude Code 与 Codex 的做法

### 3.1 Claude Code：把请求切成稳定区与动态区

- system prompt 在装配时按 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分成两段：静态段（基础指令、工具、组织上下文）打 `cache_control`；动态段（cwd、CLAUDE.md、激活的 skill）不打标记，放在边界之后。
- 消息侧只给**最后一条消息的最后一个内容块**打标记，靠前缀匹配自然累积；thinking 块不作为断点锚点。
- 侧调用（分类器、验证、`skipCacheWrite`）把断点回退一位，避免为一次性内容付写入费。
- TTL 默认 5 分钟，1 小时档由服务端白名单/环境变量控制；模型级开关可整体禁用。
- 官方博客的结论与本文一致：缓存不是"加几个标记"，而是 prompt 装配结构本身，任何 `Date.now()`、UUID、非确定性序列化都会静默击穿。

### 3.2 Codex：稳定身份 + 动态上下文作为独立条目

- `prompt_cache_key` 由线程 id 派生（`codex-rs/core/src/client.rs`），`session-id` / `thread-id` 头与它同源；缓存路由的"身份"与会话身份绑定，而不是每次请求重新生成。
- fork 出的子 agent **继承父线程的 `prompt_cache_key`**（openai/codex 提交 `ee57db3`），这样共享前缀的并行分支能命中同一份热缓存。
- 上下文条目（`environment_context`、`current_time_reminder`、`developer_instructions`、`compaction_summary`）在 `core/src/context/` 下各自成模块，与基础指令分开注入，基础指令本身保持静止。
- 压缩（`compact.rs`、`compact_remote_v2`）是一次显式的历史替换，而不是逐条改写。

### 3.3 对照

| 能力 | Claude Code | Codex | 本仓库 |
| --- | --- | --- | --- |
| 静态/动态切分 | 显式边界 + 只标记静态段 | 动态内容作为独立 context 条目 | 全部拼进一个 system 字符串 |
| 断点 | 显式，最多 4 个 | 自动前缀 + 路由键 | 无 |
| 工具集稳定 | 会话内不换 | 会话内不换 | 随模式/权限变化 |
| 历史改写 | 只压缩时 | 只压缩时 | 压缩 + **每步裁剪** |
| 缓存身份 | 会话 + 工作区 | thread id，fork 继承 | 无 |
| 可观测 | usage 三元组 + 断点调试 | usage + 亲和键 | usage 三元组 + 命中率 |

## 4. 方案

按杠杆从大到小，分五层。前两层改的是"每次请求是否天然命中"，后三层是"命中率能不能被观测和利用"。

### 4.1 工具数组做成不变量

1. `ToolRegistry.list()` 按名字排序输出；适配器不再依赖注册顺序。
2. **权限不再过滤工具数组**，只在执行边界拒绝。`read-only` 下模型仍看见 `write_file`，调用时得到 `tool "write_file" is not available in read-only mode`。代价是模型可能白试一次；收益是权限切换**完全不触碰前缀**（工具、system、历史都不变）。也不要为此往 system 里加"当前权限"一行——那会把一次权限变更重新变成一次 system 层失效。
3. 模式仍可过滤（`ask`/`plan` 的工具面是产品行为，不是权限）。模式切换由前缀指纹识别，写入 `context/cache-break`（`reason: 'mode'`），Context 页标注"上次前缀中断"。

> 如果后续希望模式切换也零成本，把 `modePrompt` 从 system 移入一条会话中 system 消息、工具面固定成全量即可；这需要模型侧支持 mid-conversation system 角色，先把上面的三件做完再评估。

### 4.2 裁剪改为单调的 prune epoch

把"每步重算投影"改成"一次性提交"：

- 新增日志事件 `context/prune`：`{ uptoSeq, at, reason, freedTokens, invalidatedTokens }`。
- 提交时选出"最新 N 条工具结果之外"的候选，取其中最老到最新的整段，**一次性**全部裁剪，`uptoSeq` 记为这批里最新的 `seq`。
- `build()` 只根据最近一次 `context/prune` 判断：`seq <= uptoSeq` 的工具结果裁剪，之后不再回看。事件不可变，所以同一份日志永远得到同一份投影（回放安全，Context 页的裁剪列表也不再漂移）。

**触发条件按代价算，而不是按条数。** 一次 epoch 的成本是"从最早被裁位置到末尾"的整段按写入价重算，收益是后续每一步少读 `freed` 个 token。设后缀为 `S`、释放量为 `F`、步数为 `K`、读取折扣为 `rd`、写入倍率为 `rw`：

```
一次成本 ≈ S × (rw − rd)
收益     ≈ K × F × rd
值得做   ⟺  F / S > (rw − rd) / (K × rd)
```

按 Anthropic 5m（`rd=0.1, rw=1.25`）、再看 5 步：`F/S > 2.3`——几乎永远不成立。§2.1 实测那条是 `F/S = 0.055`，按同一公式要连续 **209 步**才回本。所以：

- **常规情况下不单独提交裁剪 epoch**。压力大就直接压缩，压缩本来就要重写历史，裁剪再搭一趟只是白付一次重写。
- 只在**低于压缩阈值、但仍高于 `pruneAtPercent`** 时提交，且 `F / S` 必须超过 `pruneMinFreedRatio`（默认 0.3）。超过压缩阈值就直接压缩，不先裁。
- 每次提交都记录 `freedChars` / `invalidatedChars`，让它可被质疑。

这条替换掉当前的 `pruneKeepRecent` 语义：`keepRecent` 仍是"至少保留多少条不碰"，但不再每步滑动。

### 4.3 缓存意图显式化

`ModelRequest` 增加一个与提供方无关的意图字段：

```ts
// packages/llm/src/types.ts
export interface CacheIntent {
  /** 提供方按前缀桶路由时使用的稳定身份。 */
  key?: string
  /** 只缓存静态段，不写尾部（侧调用用）。 */
  staticOnly?: boolean
  /** 请求方期望的 TTL 档位。 */
  ttl?: '5m' | '1h'
}
```

映射职责留在适配器：

| 适配器 | `key` | `staticOnly` |
| --- | --- | --- |
| OpenAI 兼容（chat completions） | 可选，`prompt_cache_key` 字段（配置开启才发，避免不认这个字段的网关 400） | 无操作（自动缓存） |
| OpenAI Responses（未来） | `prompt_cache_key` | 仅静态段；TTL 用 `prompt_cache_options.ttl` |
| Anthropic（未来） | 无 | 断点只打 tools + 最后一个 system 块；否则再打最后一条消息 |
| mock / llm-mock | 忽略 | 忽略 |

`key` 的取值不要用请求级 UUID：

```
key = hash(provider + model + toolsHash + systemHash)
```

这样同一工作区、同一模式的两个会话共享静态前缀路由；fork 出的子 agent 因为 `tools`/`system` 相同，自动落在同一个桶里（对应 Codex 的 fork 继承）。会话尾部的匹配仍靠前缀本身。

侧调用（`context.summarize()`、`refreshMemory()`）一律 `staticOnly: true`：它们的尾部只读一次，不该付写入费。

### 4.4 前缀指纹与归因

`build()` 顺带算出每段的指纹，和上一次请求比对，得出"第一处分歧在哪"：

```ts
interface PrefixFingerprint {
  tools: string        // hash(JSON.stringify(sortedTools))
  system: string       // hash
  messages: string[]   // 每条消息一个 hash
  epoch: number        // 最近一次 summary/prune/mode 变更的 seq
}
```

`recordContext()` 只在每轮第一步写 `context/snapshot`，所以真正的中断记录是一个独立事件：每次前缀断掉都追加 `context/cache-break`（`{ region, index?, reason, invalidatedChars }`），Context 页读 `GET /api/sessions/:id/context` 的 `cache` 字段展示。于是当某一步 `cachedInputTokens === 0` 时，界面能直接回答：

```
上一步前缀中断：messages[37]（工具结果裁剪）  作废 18.4k · 释放 2.1k
```

没有这个，缓存回归会像 Anthropic 博客里说的那样"静默存在几个月"。

### 4.5 预热与并发

- **不默认预热**。交互式会话的第一次真实请求自然会写入缓存。唯一的例外：提供方支持 `max_tokens: 0`（Anthropic）、静态前缀足够大、且首字延迟确实可见时，可以在会话创建后预热静态段；这是"把写入提前"，省的是延迟不是钱。
- **并发不共享写入**：多路子 agent 同时启动时，谁都读不到别人正在写的条目。如果有并行子任务，先让主分支发出第一步，再放子 agent；或者明确接受并行分支各自冷启动。
- 子 agent 的会话日志独立，静态前缀相同即可复用 tools+system 那一层。

### 4.6 与推理引擎的"意图同步"：只做有接口的那一半

把"harness 与引擎双向沟通"拆成具体信号逐条对照，会发现一半已经存在，另一半没有接口：

| 方向 | 信号 | 今天有无接口 | 本方案 |
| --- | --- | --- | --- |
| →引擎 | 哪些字节会被复用 | 有：`cache_control` 断点；自动前缀缓存 | §4.2 / §4.3 |
| →引擎 | 多久内会复用 | 部分：Anthropic `ttl: 5m\|1h`；OpenAI Responses `prompt_cache_options.ttl`（默认 30m，部分模型另有 12h 档） | 按空闲间隔选档，见下 |
| →引擎 | 即将有相似请求 | 无专门字段；只能用 TTL 表达 | 不单独建 |
| →引擎 | 路由到同一处 | 有：`prompt_cache_key` | §4.3 |
| →引擎 | 预热 | 有：Anthropic `max_tokens: 0` | 仅按 §4.5 的条件 |
| ←引擎 | 本次命中 / 写入 / 未命中 | 有：usage 三元组 | 已有 |
| ←引擎 | **为什么没命中**（模型、工具、system、消息、过期） | 有：Anthropic cache diagnostics（2026-09 已 GA，可返回 `cache_miss_reason` 与分歧位置）；OpenAI 也有 diagnostics 指南 | 归因**优先用服务端结论**，本地指纹兜底 |
| ←引擎 | 哪些前缀仍驻留、缓存压力、剩余 TTL | **没有公开接口** | 不建 |
| ←引擎 | 据此推迟会破坏前缀的请求 | 没有接口，也不需要——用本地循环知识即可 | 只在回合边界压缩 |

落地为两件事：

1. **归因分两层**。本地指纹（§4.4）负责"我们自己改了什么"；引擎 diagnostics 负责"是不是过期了、是不是模型/速度变了、是不是服务端丢了 thinking 块"。后者是本地无法推断的，尤其是模型侧丢弃历史 thinking 造成的失效——只看 usage 会误判成自己的 bug。没有 diagnostics 的提供方自动降级为本地指纹。
2. **TTL 按预期复用距离选档，而不是固定值**。长档的写入更贵：Anthropic 1h 是 2×、OpenAI 12h 是 2.5×，读取仍是 0.1× 级别，所以两边都需要**至少 3 次**读取才回本。策略：
   - 默认 5m。
   - 当同一会话的历史回合间隔 p90 超过 5 分钟、且会话仍在继续时，切到长档；连续 N 轮没有出现长空档就切回。切换本身是一次显式事件（`context/cache-ttl`），便于对账。
   - 同一请求里长档必须排在短档之前（Anthropic 的排序约束），所以按段设 TTL，不按请求设。

**对当前仓库的收益判断**：中等偏小。原因是本仓库唯一在用的适配器是 OpenAI 兼容的 `/chat/completions`，`prompt_cache_options` 与 12h 档属于 Responses API，暂时用不上；Anthropic 的 `ttl` 与 diagnostics 也要等对应适配器存在。而命中率的主要损失来自 §2.1 的自伤式裁剪，不是过期或路由。所以顺序是：先做 §4.1–§4.2 把结构修对，再把 diagnostics 接进归因（阶段 4），TTL 选档随 Anthropic / Responses 适配器一起做。**"驻留查询 / 缓存压力 / 按引擎信号调度"不建**——没有接口，做了也只是猜测。

### 4.7 引擎侧扩展：现在不做（以 vLLM 为例）

自托管推理引擎（vLLM / SGLang）确实握有 harness 看不到的运行时信息。但对这个仓库，**改引擎的收益还不足以覆盖维护成本**，而且大部分所需信号今天不用改引擎就能拿到：

| 想要的能力 | vLLM 今天的接口 | 是否必须改引擎 |
| --- | --- | --- |
| 单请求命中量 | OpenAI 兼容层在 `usage.prompt_tokens_details.cached_tokens` 回报前缀命中 | 否 |
| 服务级命中率、排队数、KV 压力 | Prometheus `/metrics`（prefix cache queries/hits、`num_requests_waiting`、KV 使用率） | 否 |
| 前缀保留 / TTL / 钉住某段 | 无。块哈希自动淘汰，没有 per-request 保留语义 | 是 |
| 缓存亲和排序 | 仍是一个开放 RFC，不是稳定契约 | 是 |
| 自定义调度 | `--scheduler-cls` 换调度类；官方 plugin 入口主要面向平台、IO processor、stat logger | 是，但不必 fork |

四条拒绝理由：

1. **当前部署不是自托管**。`llm-catalog` 把所有 provider 注册为 OpenAI 兼容适配器，默认种子是 DeepSeek 云 API；仓库里没有任何 vLLM 代码或配置。为不运行的引擎写扩展，是把维护成本押在一个假设上。
2. **能拿的信号已经拿得到**。命中量走 usage（`readUsage()` 已经解析 `details.cached_tokens`，指向 vLLM 时零改动可见）；压力与队列走 `/metrics`。文章说"只有引擎知道"的那部分，恰好是 Prometheus 已经暴露的部分。
3. **想用引擎做的控制没有场景**。本仓库单用户、每会话串行（`AgentService.turns` 一次只跑一个回合），并发只有偶发子 agent。前缀误驱逐不构成可测损失，优先级调度没有队列可排。
4. **接口不稳定**。vLLM 迭代很快，调度相关能力还在 RFC 阶段；跟它维护扩展的收益/成本比很差，而本仓库的规范是"不引入新依赖除非确有必要"。

**重新评估的触发条件**（三条同时成立才考虑）：

- 主部署切到自托管 vLLM / SGLang，且出现多会话并发导致的相互驱逐；
- §2.1–§2.3 的结构问题已修完，命中率仍显著低于预期；
- diagnostics 与 metrics 都指向"被驱逐"，而不是"前缀被自己改写"。

即便那时，顺序也是：先接 `/metrics`（零侵入）→ 再用 `--scheduler-cls` 做优先级或亲和 → 最后才考虑插件或 fork。引擎侧扩展永远是可选的旁路能力，不进 harness 的必需依赖。

## 5. 失败模式

| 失败 | 表现 | 处理 |
| --- | --- | --- |
| 提供方不支持缓存 | `cachedInputTokens` 恒为 0 | 无操作；命中率显示为 0 而不是报错 |
| `AGENTS.md` / skills 在会话中被修改 | 前缀从 system 断开一次 | 作为 epoch 记录原因；不阻止 |
| 模式切换 | 工具数组 + system 同时变化 | 显式 epoch；UI 标注 |
| 换模型 | 缓存按模型隔离，必然全冷 | 记录为 epoch；不做特殊处理 |
| 网关不认 `prompt_cache_key` | 400 | 配置开关，默认不发；发送失败只记日志不重试 |
| 前置代理改写请求体 | 缓存永不命中，无错误 | 靠指纹归因发现"请求本身一致但命中为 0"，提示检查代理 |
| 服务端 diagnostics 不可用 | 只能看到"没命中" | 降级到本地指纹归因，不阻塞 |
| 长 TTL 档用错场景 | 写入 2–2.5× 却没有后续读取 | 按间隔 p90 选档，并记录 `context/cache-ttl` 供对账 |
| 压缩后立刻再压缩 | 每次重写整段 | 已有 `MIN_SHRINK_RATIO` 与熔断，保持不变 |

## 6. 验证

缓存问题必须是**能失败的测试**，不能只靠线上账单发现。

1. **前缀单调性单测**：构造一个 `build()` → 追加一条 `tool/result` → 再 `build()` 的序列，断言第二次请求的 messages 以第一次的 messages 为精确前缀。这条测试在当前的 `pruneToolResults` 上会失败——先让它失败，再改实现。
2. **假 provider**：在 `tests/` 里加一个 `PrefixCacheProvider`，序列化请求、与上次请求求最长公共前缀，把该长度作为 `cachedInputTokens` 上报。它同时验证了 usage 归一（互斥计数）。
3. **集成断言**：
   - 追加用户消息 / 助手消息 / 工具结果后，下一步 `cachedInputTokens` 等于上一步的 prompt 总量。
   - 切换权限（`workspace-write` → `read-only`）后工具数组不变，命中不断。
   - 越过大结果阈值时**只写一次** `context/prune`，其后的步骤恢复为只追加。
   - 摘要侧调用不上报 `cacheWriteInputTokens`（`staticOnly`）。
4. **归因单测**：手工改动 `system` 的一个字节，断言 `firstDivergence` 指向 `system`；改动第 3 条消息，断言指向 `messages[3]`。
5. **归因降级**：假 provider 不返回 diagnostics 时，归因仍由本地指纹给出；返回 diagnostics 时，服务端结论优先，并且两者冲突时保留本地结论作为交叉验证。

## 7. 实施顺序

| 阶段 | 内容 | 文件 | 风险 |
| --- | --- | --- | --- |
| 0 | 前缀指纹 + `context/snapshot` 归因字段 | `packages/context`、`packages/ui-app` | 低，纯观测 |
| 1 | 工具排序；权限不再过滤工具数组改由执行边界拒绝 | `packages/tools/src/index.ts`、`packages/agent/src/index.ts` | 中，模型可能多试一次 |
| 2 | prune epoch：新事件、单调投影、触发条件 | `packages/context/src/compaction.ts`、`index.ts` | 中，需迁移旧会话的回放语义 |
| 3 | `CacheIntent` + 适配器映射 + 侧调用 `staticOnly`；TTL 选档随 Anthropic / Responses 适配器落地 | `packages/llm/src/types.ts`、`llm-openai` | 低，自动缓存下是空操作 |
| 4 | 指纹测试、`PrefixCacheProvider`、接入服务端 diagnostics（有则用、无则降级）、Context 页展示 | `tests/`、`packages/ui-app` | 低 |

本次实施已完成阶段 0–4 的服务端部分与 Context 页提示。旧日志没有 `context/prune`，投影退化为"不裁剪"——这正是安全的默认，不需要迁移。未做的两项见 §11。

## 8. 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `promptCacheKey`（llm-openai） | false | 是否发送 `prompt_cache_key`；Responses 系端点才认这个字段 |
| `pruneToolResults` | true | 是否允许提交裁剪 epoch |
| `pruneAtPercent` | 50 | 上下文达到阈值的该比例后才评估裁剪 |
| `pruneMinFreedRatio` | 0.3 | 释放量 / 被作废后缀的下限，低于则等压缩 |
| `pruneKeepRecent` | 8 | 任何 epoch 都不裁的最近工具结果数 |
| `pruneThreshold` / `pruneHead` / `pruneTail` | 8000 / 3000 / 2000 | 单条结果的裁剪阈值与保留头尾 |

自适应 TTL（`cache.ttlPolicy`）与 `cache.key` 的 `session` 模式尚未实现：它们只有在 Anthropic / Responses 适配器存在时才有意义，届时随适配器一起加。

## 9. 不做什么

- **不把时间戳、cwd、UUID 写进 system**。需要时放在用户消息或会话中 system 消息里；本仓库目前没有这类注入，保持这个状态。
- **不为 UI 折叠改写模型视图**。UI 已经是从日志派生的投影，两边互不影响。
- **不追求跨会话命中对话历史**。缓存的时间尺度是分钟，跨会话共享的只有静态前缀。
- **不默认预热**。它只是把写入提前，省延迟不省钱；只在 §4.5 的三个条件同时成立时用。
- **不建没有接口的"引擎反馈"**。驻留状态、缓存压力、剩余 TTL 都没有公开 API；与其猜，不如只做服务端能给出的事后归因（diagnostics）与本地指纹。
- **不按引擎信号调度请求**。会破坏前缀的操作（压缩、裁剪、切模式）只由本地循环知识决定何时发生——回合边界、压力阈值——而不是等一个不存在的"缓存空闲"信号。

## 10. 实施结果

已落地（全量 450 个测试通过）：

- **工具数组**：`ToolRegistry.list()` 按名排序；`agent.toolsFor` 与 `context.info` 不再按权限过滤，权限只在 `ToolRegistry.invoke` 与审批层生效。
- **裁剪**：`context/prune` epoch + `pruneByEpoch` 纯投影。同一 epoch 下追加事件不改变任何已决策的字节（单测断言两次投影的 map 完全相等）。触发点在 `maybeCompact` 的"低于压缩阈值"分支。
- **归因**：`buildFingerprint` / `diffPrefix` 计算 tools / system / messages 指纹。每次真实请求（`record: true`）与上一次比对，断掉时追加 `context/cache-break`，并写入该轮 `context/snapshot` 的 `cacheBreak`。
- **缓存意图**：`ModelRequest.cache`（key / staticOnly / ttl）；agent 用 `provider|model|tools+system 指纹` 作 key；摘要与记忆刷新标记 `staticOnly`；适配器由 `promptCacheKey` 开关决定是否发送。
- **可见性**：`GET /context` 返回 `prune` 与 `cache`，Context 卡片显示"上次前缀中断：<原因> · 作废 N"。

新增测试：

- `packages/context/tests/cache.spec.ts`：9 项归因与键测试（追加不算断，工具 / 模式 / 系统 / 压缩 / 裁剪各自归因，首条改写定位）。
- `packages/agent/tests/cache.spec.ts`：权限切换后工具面不变；模式切换记一次 `mode` 中断；纯追加回合不记中断，且请求消息的前缀逐字节相同。
- `packages/tools/tests/registry.spec.ts`：注册顺序不影响渲染顺序。
- `packages/context/tests/compaction.spec.ts`：epoch 投影的单调性。

未做：

- 自适应 TTL 与服务端 diagnostics：需要 Anthropic / Responses 适配器，当前 chat-completions 路径用不上。
- 按最长公共前缀上报 `cachedInputTokens` 的 `PrefixCacheProvider`：现有的"消息前缀逐字节相同"断言更直接，暂不引入第二套模拟。

### 10.1 效果实测

同一套渲染路径做 A/B：新策略调用真实的 `build()`；旧策略在每一步提交一个等价 epoch（把最新 8 条之外的结果全部裁剪），复现改造前的行为。20 步、每步约 10k 字符的工具结果，`compactAt` 设到不触发摘要。命中量按相邻两次请求的最长公共前缀计算；成本按"读取 0.1×、未命中 1×"折算，1.0 = 完全无缓存。

| 场景 | 策略 | 重新处理字符 | 断点 | 成本@读取 0.1× | 成本@读取 0.5× |
| --- | --- | ---: | ---: | ---: | ---: |
| 工具循环（20 步） | 旧 | 1,320,993 | 12 | 0.641 | 0.801 |
| | 新 | 255,145 | 0 | **0.184** | **0.547** |
| 中途切权限 | 旧 | 369,840 | 3 | 0.565 | 0.758 |
| | 新 | 128,985 | 0 | **0.256** | **0.587** |
| 压力下裁剪一次 | 旧 | 1,320,993 | 12 | 0.641 | 0.801 |
| | 新 | 388,364 | 1 | **0.241** | **0.578** |

- 工具循环里，新策略每步重新处理约 12.6k 字符（基本都是本步新增），旧策略约 103k；末步命中率 95.1% vs 40.5%，重新处理量下降 81%。
- 切权限时旧策略整段作废一次（命中率掉到 0.8%），新策略保持在 85–90%。
- 压力场景只允许一次 epoch：命中率在那一跳掉到 6.8%，随后回到 93%。
- 新策略发送的总 prompt 更大（不裁剪旧结果），但多出的部分按读取价计费，总输入成本仍低三到七成。
- 字符级前缀是上界：提供方按 token 块（Anthropic 精确字节、OpenAI 128 递增、DeepSeek 64）向下取整，绝对命中率会略低；差距的量级不受影响。

## 11. 参考

- Anthropic 官方博客《Lessons from building Claude Code: Prompt caching is everything》——结构与静默失效的工程结论。
- Anthropic 文档：Prompt caching、Cache diagnostics——断点上限、最小长度、TTL 与分层失效表。
- [cablate/claude-code-research · Prompt Cache Architecture](https://github.com/cablate/claude-code-research)——对 SDK 的静态分析，静态/动态边界与 `skipCacheWrite` 的具体位置。
- [openai/codex@ee57db3 · Inherit forked agent prompt cache keys](https://github.com/openai/codex/commit/ee57db3debe793d759ba28e49d35a8116e3bb753)——`prompt_cache_key`、`session-id` / `thread-id` 三者同源与 fork 继承。
- [Anthropic · Cache diagnostics](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)——服务端返回未命中原因与分歧位置，2026-09 GA。
- [OpenAI · Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)——自动前缀缓存与 `prompt_cache_key` 的语义。
- [OpenAI · Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)——对应 OpenAI 侧的归因接口。
- DeepSeek 文档：Context Caching——按块自动缓存与命中计价。
- [vLLM · Plugin System](https://docs.vllm.ai/en/latest/design/plugin_system/)——官方插件入口覆盖的范围。
- [vLLM · Production Metrics](https://docs.vllm.ai/en/latest/usage/metrics/)——prefix cache 与队列指标，§4.7 的观测依据。
- [vLLM RFC #42185 · Cache-affinity-aware request ordering](https://github.com/vllm-project/vllm/issues/42185)——缓存亲和排序尚未成为稳定契约。

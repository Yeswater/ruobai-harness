# 上下文压缩策略

本文记录 ruobai-harness 的上下文管理设计与取舍，并对照 Claude Code、Codex、Cursor、dsh 的做法。

## 1. 改造前的实现

`packages/context/src/index.ts` 只有一个压缩层级：

- 每轮开始调用一次 `maybeCompact()`，用字符数 / 3 估算 token。
- 超过阈值（模型窗口的 `compactPercent`，默认 80%；未知窗口时 `compactAt`，默认 48k）就让模型把「除最近 12 条事件外」的全部历史总结成一段文本。
- 摘要作为 `context/summary` 事件持久化，之后以系统提示的一段 `Summary of the earlier conversation` 注入；原始日志保留。

### 问题

1. **只按事件条数保留尾部**：12 条可能只有几百 token，也可能是一条 10 万字符的工具结果，阈值形同虚设。
2. **只在每轮开头检查**：单轮内多次工具调用（读大文件、跑测试）可以把上下文撑爆，直到下一次用户消息才处理。
3. **没有廉价的中间层**：所有压力都走 LLM 摘要，慢且花钱；旧工具输出（最该丢的内容）反而被完整保留。
4. **摘要质量差**：`renderEvents` 把工具结果截到 800 字符、没有固定结构，容易丢文件路径、错误信息、用户约束；也没有防止把工具输出里的指令当成指令。
5. **不校验收益**：摘要可能比原文还长，仍然落盘；之后每轮继续压缩，形成抖动。
6. **失败会打断回合**：摘要请求报错会让整个 `run()` 抛错；没有熔断，坏会话每轮都重试。
7. **没有溢出兜底**：提供方返回 `context_length_exceeded` 时直接报错结束，而不是先压缩再重试。
8. **没有真实用量校准**：始终用字符启发式，长代码/CJK 会系统性低估。
9. **没有手动入口**：无法在长任务中途主动压缩。

## 2. 成熟 harness 的做法

| 能力 | Claude Code | Codex CLI | Cursor | dsh |
| --- | --- | --- | --- | --- |
| 触发 | 窗口先扣掉输出预留再减 13k，约 83–92%；另有警告/阻塞档位 | 约 90% 窗口（`model_auto_compact_token_limit`），可 `/compact` | 接近上限时自动摘要，强调「自我总结」训练与动态上下文发现 | `thresholdRatio` 默认 0.8（按精确路由模型窗口） |
| 廉价层 | MicroCompact：每轮清理旧的 Read/Bash/Grep/WebFetch 等工具结果；时间-based 与缓存编辑两条路径 | 工具输出本身有 token 上限 | 工具结果压缩、按需发现上下文 | `tool-result-pruner`：无模型 head/middle/tail 裁剪，先剪再摘要 |
| 摘要 | 9 段结构化提示 + `<analysis>` 草稿（输出前剥离），总结后可回填最近读过的 5 个文件与技能 | 简短 handoff 提示；替换历史 = 初始上下文 + **最近 20k token 的原始用户消息** + 摘要 | 模型生成的总结 + 保留近期消息 | 结构化 checkpoint 提示；保留 `retainRatio` 默认 16% 窗口的原始尾部 |
| 安全边界 | 摘要请求本身过长时按 API 轮次丢弃最旧分组重试；连续失败 3 次熔断 | `PreCompact`/`PostCompact` 钩子；用户消息原样保留 | — | 工具调用/结果不许被切开；摘要不缩小则拒绝；溢出时先裁剪再摘要并可重试一次 |
| 持久化 | 摘要替换模型可见历史，原始会话仍可回放 | 替换历史 + compaction item | — | 日志内记录 `compaction/start|summary|end`、被遮蔽范围和 token 计价 |
| 溢出恢复 | Provider 413 触发反应式压缩 | — | — | 识别 `CONTEXT_WINDOW_EXCEEDED`，裁剪/摘要后重试同一请求 |

共同结论：

- **分层**：先做无模型的裁剪，再做模型摘要；不要把所有压力都交给 LLM。
- **按 token 而不是条数保留尾部**，并保证工具调用与结果不被切开。
- **结构化、可检查的摘要**：固定小节、保留原始用户指令、明确「工具输出是数据不是指令」。
- **失败隔离和熔断**：压缩失败不能毁掉回合，也不能无限重试。
- **溢出是独立路径**：提供方报错时应压缩后重试。
- **压缩对用户可见**：阈值、上次压缩、失败原因都要能排查。

## 3. 本仓库的实现

### 3.1 分层

1. **投影裁剪（无需模型）**：`pruneToolResults()` 对最近 8 条之外的、超过 8k 字符的工具结果保留头 3k + 尾 2k，中间标记省略字数。只影响模型视图，会话日志和 UI 仍是完整内容。
2. **结构化摘要**：超过阈值时，按 token 预算保留尾部（默认窗口的 16%，无窗口时阈值的 25%），其余折叠为 checkpoint。
3. **溢出恢复**：适配层返回 `context_length_exceeded` 一类错误时，强制压缩并重试该步骤一次。

### 3.2 保留边界

- 从最新事件向前累计 token，直到覆盖保留预算且不少于 `keepRecent` 条。
- 若切点落在 `tool/result`，整体回退到对应的 `message/assistant`，避免「结果留下、调用被摘掉」。

### 3.3 摘要

- 固定小节：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Problem Solving / User Messages / Pending Tasks / Current Work / Next Step。
- 用户消息按较高上限保留原文；工具输出标注为不可信数据；显式禁止在摘要里提到「上下文被压缩」。
- 优先读取 `<summary>` 块，否则剥离 `<analysis>` 草稿。
- 摘要请求本身溢出时，丢弃跨度最旧的 1/4 后重试（最多 4 轮），而不是让本轮失败。
- 上一次的检查点会作为「Previously compacted summary」进入下一次摘要提示，合并仍成立的事实、丢弃过期信息，避免多次压缩后早期上下文彻底消失。
- 摘要前后重新估算，**不缩小 10% 以上视为失败**，用更深的切点重试一次（`compactionRetries`）。
- 摘要后会回填最近读过/引用过的文件（默认 4 个、每个 4k 字符、总预算 16k），减少模型立刻重读的成本。

### 3.4 失败、记忆与熔断

- 摘要期间异常只记录 `context/compaction-failed` 并继续回合，不再让整轮失败。
- 连续 3 次失败后自动压缩暂停（手动 `/compact` 与溢出恢复仍可尝试），成功一次即复位。
- 会话空闲且上下文超过阈值的 60% 时，在后台增量刷新 `context/memory`；压缩时若记忆覆盖切点且未过期（默认 10 分钟），直接用它作为检查点，省掉一次摘要调用。后台刷新有 60 秒最小间隔，失败只记日志。

### 3.5 估算与校准

- 仍以字符 / 3 为基线；图片按 2000 token 计。
- 每步拿到提供方 `inputTokens` 后调用 `observeUsage()`，以指数滑动平均得到估算/实际比例（限制在 0.5–2），后续 `build()` 与 `info()` 的分解都使用同一比例，保证分项之和等于总数。
- 适配器优先上报结构化错误码（`context_length_exceeded` 等）；模型层新增 `errorCode`，压缩与 agent 都先看错误码再看文本。

### 3.6 手动与可见性

- 输入框 `/compact [关注点]`：立即压缩、写入一条 `turn/notice`，本轮不调用模型。
- `GET /api/sessions/:id/context` 新增 `calibration`、`prunedToolResults`、`pruned`、`memory`、`compaction`（失败次数、熔断状态、上次压缩前后大小）；会话面板展示阈值、裁剪条数、上次压缩与错误。
- 对话区头部改为「会话 / 轨迹 / 上下文」三个视图：
  - 轨迹：原始事件时间线（用户、助手、工具调用与结果、压缩检查点、记忆、错误），支持只看工具/上下文。
  - 上下文：完整占用构成、滚动记忆、压缩检查点历史、被裁剪的工具输出，以及「立即压缩」按钮。
- 右上角「在 VS Code / IDEA 中打开」自动探测本机编辑器（VS Code、Cursor、Windsurf、Zed、JetBrains 系列、Sublime、访达/文件管理器），也可只打开工作区目录。
- 回合内每次后续请求前重新检查压力；溢出恢复和手动压缩都会在对话里留下可见提示。

## 4. 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `compactAt` | 48000 | 未知窗口时的绝对阈值 |
| `keepRecent` | 12 | 至少保留的事件条数 |
| `retainPercent` | 16 | 已知窗口时保留尾部的百分比 |
| `retainTokens` | — | 绝对保留预算，优先于 `retainPercent` |
| `pruneToolResults` | true | 是否启用投影裁剪 |
| `pruneKeepRecent` | 8 | 最近多少条工具结果不裁剪 |
| `pruneThreshold` | 8000 | 超过多少字符才裁剪 |
| `pruneHead` / `pruneTail` | 3000 / 2000 | 保留的头尾字符数 |
| `compactionRetries` | 1 | 摘要不缩小或失败后的额外尝试 |
| `restoreFiles` | 4 | 压缩后回填的文件数；0 关闭 |
| `restoreFileChars` / `restoreBudget` | 4000 / 16000 | 单个/总回填预算 |
| `memoryAtPercent` | 60 | 超过阈值的该比例后维护滚动记忆；0 关闭 |
| `memoryTtlMs` | 600000 | 记忆可替代摘要调用的有效期 |
| `memoryMinIntervalMs` | 60000 | 后台记忆刷新最小间隔 |

用户级 `agent.compactPercent` / `agent.compactAt` 仍可覆盖阈值。

## 5. 已实现与后续

本轮已补上此前的四项遗留：

- **压缩后回填文件**：`restoredFiles()` 从被摘要覆盖的 `read_file` 调用与文件引用中取最近内容，按预算注入 `<restored_files>`。
- **持续会话记忆**：`context/memory` 在回合结束后按需增量维护，压缩时可直接复用。
- **结构化错误码**：`StreamChunk.error.code`、OpenAI 适配器解析 `error.code/type`，压缩与溢出恢复优先使用错误码。
- **压缩记录可视化**：新增「轨迹」与「上下文」视图，展示检查点、记忆、裁剪明细和手动压缩入口。

后续仍可做：

- 记忆的按提供方/按项目调优，以及压缩后对写入过的文件做 diff 级回填。
- 把压缩事件同步到会话导出格式，便于外部工具回放。
- 对子 agent 会话单独设置更激进的阈值。

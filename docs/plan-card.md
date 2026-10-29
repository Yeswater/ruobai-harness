# 计划审批卡片（plan）

## 问题

Plan 模式产出的计划原本只是一段聊天文本：用户读完要么手动切到 Agent 模式再打一句「开始执行」，要么自己复制计划。计划与决定分散在两条消息里，改一版计划就要重读全文；模型也常把计划写成正文后直接停住，「计划」在日志里没有可检索的结构。

问句与文本都无法承载「接受 / 修改」这个二选一——用户要的是一张写着完整计划的卡片，和两个按钮。

## 约束

- **计划必须先落日志**：重开页面、切换会话后卡片仍在；刷新不能把待确认的计划弄丢。
- **接受即执行**：Plan 模式的工具集是只读的（`mode-plan.allowTools` 只给读工具），所以接受计划必须同时切到可写模式，否则「开始执行」什么都改不了。
- **不阻塞回合**：与 `ask_user` 不同，计划提交后模型应结束回合；用户可能几分钟后才决定，不能让一个工具调用挂在那儿。
- **修改要有上下文**：点「继续修改」时把意见作为用户消息发回，模型据此更新计划并再次提交。
- **卡片与文本同源**：卡片消失后，计划仍要从轨迹里读得到——工具调用本身就是那条记录。

## 方案

两个包，沿用 `ask` / `todo` / `commit-prompt` 的分法：

```
packages/plan/      工具 plan_submit、事件、投影、resolvePlan()
packages/plan-web/  HTTP + 广播
```

### 事件与投影

```
plan/proposed  { id, sessionId, title, plan, createdAt }
plan/resolved  { id, sessionId, action: 'accept' | 'revise', feedback?, at }
```

投影 `plan` 折叠为 `{ proposal | null, lastSeq }`：`proposed` 把计划放上去，`resolved` 只清除同一个 id。阅读用 `planOf(ctx, sessionId)`。

这与 `ask` 的纯内存请求不同：计划是会话的一等产物，回放必须得到同一张卡片。

### 工具 `plan_submit`

- 参数只有 `title` 与 `plan`（Markdown）；标题缺省取第一个标题行，再缺省为「实施计划」。
- `readOnly: true`：它只记录提案，不碰外部世界；因此 Plan 模式的只读工具集里也能用。
- 返回「计划已提交，等待确认。停止继续输出」，让模型把回合收在提交这一刻。
- 校验空计划、超长计划（20k 字符）并拒绝，日志不变。

`mode-plan` 的系统提示改成「最后调用 `plan_submit`，不要把计划只写成正文」，并把工具加进 `allowTools`。

### 决定

`POST /api/plans/:id`，body `{ sessionId, action, feedback? }`：

- **accept**：若当前是 `plan` 模式且 `agent` 已注册，`chat.setMode(agent)`；然后 `chat.send('计划已确认，按上面的计划开始执行。')`。
- **revise**：把 `feedback`（缺省为一句通用修改指令）作为用户消息发回，模式不变。

两种决定前都先停掉仍在运行的回合：`plan_submit` 之后模型可能还在出下一步，一条插话会被同一个回合在下个步骤边界读走，而那个回合仍持有 Plan 模式的只读工具集。停止后消息进队列，`turn-end` 时以新回合启动。

### 浏览器侧

- `useHarness` 在切换会话时拉 `GET /api/plans?sessionId=…`，并订阅 `plan` 推流；`requested` 上卡，`resolved` 按 id 清卡。
- `PlanCard` 只收 plain props；计划用 `MarkdownPreview` 渲染，动作是「继续修改」（展开一个意见输入框）与「开始执行」。
- 轨迹里的 `plan_submit` 行以计划标题为标题、正文渲染整份计划；等待决定时自动展开。卡片消失后，这里仍能读到计划。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| 空计划 / 超长 | 工具返回错误，模型看到原因；不写事件 |
| 重复决定 | 第二个请求 404（投影里已无该提案） |
| 提交后模型继续跑 | 决定时先停掉回合，再以新回合执行/修改 |
| Plan 插件被卸载 | 工具与卡片都消失；日志里的 `plan/proposed` 事件仍可回放 |
| 子智能体会话 | 计划事件照常写入，但子会话不出现在会话栏，卡片只随父会话查看 |
| 接受时 `agent` 未注册 | 不切模式，只发执行消息；模型会在当前模式下说明无法执行 |

## 验证

`packages/plan/tests/plan.spec.ts`（7 例）：

- 提交写入 `plan/proposed`、投影可读、返回「等待确认」；
- 标题回退到首个标题行；空计划被拒且不写事件；
- HTTP 快照、accept 切到 `agent` 并发出执行消息、revise 留在 `plan` 并带回反馈；
- 重复决定 404；`ui/broadcast` 的 `plan` 通道收到 `requested` / `resolved`。

浏览器侧：

- `packages/ui-app/tests/plan-card.spec.tsx`：卡片渲染标题、计划、两个按钮；轨迹行渲染计划正文与「等待确认」。
- `packages/todo/tests/todo.spec.ts` 新增一例：系统提示在清单为空时也带「多步任务维护任务清单」的规则。

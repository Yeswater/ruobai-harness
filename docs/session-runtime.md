# 会话运行中的权限与消息队列

三个相关改动：运行中可切换权限、完全权限可以作为全局默认、运行中提交的消息在下一个步骤边界插话进当前回合。

## 问题

1. Composer 的权限 chip 在 `streaming` 时被禁用，用户想收紧/放宽权限必须等这一轮结束。
2. `PermissionService.modeFor`、`ChatService.permissionFor/create` 和设置页三处都显式排除了 `full-access`，它只能作为单个会话的临时选择。
3. `AgentService.prompt` 在会话运行时抛 `session is already running`，HTTP 层映射成 409，用户只能等回合结束再发送。

## 约束

- 追加日志是唯一事实源，模型可见 ⟺ 已落日志。
- 排队消息只能落在**步骤边界**：正在流式产出的 step 不能被中途切断，否则模型写到一半的内容与被夹进来的新要求会错位。
- 权限判断必须读实时状态，不能在本轮开始时快照。
- 排队是运行态，不是会话状态；不引入新的事件类型。

## 方案

**权限热切换。** 权限本来就只落在 `session/meta` 上，`PermissionService.modeFor` 和 `AgentService` 的工具过滤、`ToolRegistry.invoke`、`ApprovalService` 每次调用都会重新读它，所以后端不需要改运行路径。真正挡住用户的是 UI：`PermissionSelect` 去掉 `streaming` 禁用，运行中切换立即作用于下一次工具调用与审批。Agent 模式选择仍保持禁用——`mode` 只在本轮开始时读取，中途切换会让 UI 与实际行为不一致。

**全局完全权限。** 删除三处 `!== 'full-access'` 过滤，以及 `settings-web` 的 `normalizeDefaultPermission` —— 那里还有一道"完全权限不能作为全局默认"的接口校验，只放行前三档。设置页的默认权限下拉恢复完整四档，选择完全权限时弹确认框（与 Composer 里的一致），确认后作为草稿，保存才生效。新会话创建时把默认权限写进 `session/meta`，已有会话不受影响。

**排队与插话。** `ChatService` 为每个会话维护内存队列，`AgentService` 在每个回合的步骤边界来取：

- `send()` 发现会话在运行时，生成 `QueuedMessage`（保留 id、文本、附件）入队，通过 `session-updated` 广播新的 `session.queued`，并返回 `{ message, queued: true }`。
- 日志此时**不**写入 `message/user`：消息还没有被接纳。
- `AgentService` 暴露 `registerInterjections(source)`，`ChatService` 在构造时注册自己的队列。回合循环的每一轮开头（`steps > 0`，即上一步的工具都跑完之后、下一次请求之前）调用它：整队取出、以原 id 追加 `message/user`，随后 `maybeCompact` 与紧接的请求都能读到它们——**仍在同一个回合里**。
- 没有下一个边界（模型不调工具、直接收尾）时，`agent/turn-end` 的 `drain()` 把剩下的排队项作为下一轮开始（`agents.prompt(..., { id })` 沿用同一 id）。
- `withdraw()` 把某条移出队列、广播、把内容返回给调用方。
- 停止（`stop()`）只中断当前回合，**保留**队列：回合结束即开下一条，与 Claude Code 按 Esc 的行为一致。
- 会话删除时一并清空队列。

客户端：`send` 在运行时不再校验 `streaming`，回车排队；发送按钮与停止按钮同时存在。`Transcript` 从 `session.queued` 渲染排队气泡（虚线、`排队中 · 当前步骤结束后发给模型`），不写进 `messages`，因此 `buildPlan` 不会把正在运行的回合误判为已结束。每条排队气泡有两个动作：

- **编辑**：`DELETE .../queued/:queuedId` 取回该条，正文放回输入框（在已有草稿之前），回车即重新排队。
- **撤回**：同一个 DELETE，但只丢弃，不回填输入框。

没有「立即发送」：它必然要切断正在产出的 step，而 Claude Code 只在当前工作可以转后台时才不打断；本 harness 的模型流与工具执行都是同步的，没有可后台化的通道，所以插话一律等到步骤边界。

## 失败模式

- **排队消息进日志的时序**：只能由边界注入或 `drain()` 追加；HTTP 响应从不写日志，避免模型在自己的 step 中途看到它。
- **边界注入与压缩的顺序**：注入先于 `maybeCompact`，压缩看到的是接纳后的会话。
- **没有下一步的回合**：排队项在 `turn-end` 由 `drain()` 兜底成新回合，不会丢。
- **SSE 帧丢失**：`useHarness.send` 在 HTTP 响应里再合并一次排队项并按 id 去重，事件流断了也不会看不到刚发的消息。
- **多标签页**：排队项以 `session.queued` 为准，第二个标签页无需本地状态也能显示。
- **刷新丢失**：队列是内存态，刷新后未开始的排队消息消失（与 Claude Code 一致）；日志里不存在"已排队但未开始"的消息。
- **drain 时又有新回合**：`prompt` 抛错时把消息留在队首，等下一次 `turn-end` 再试。

## 中断留下的半步

「停止」可能中断一个正在流式输出的 step。日志此时可能已经写入了**只有 reasoning** 的 assistant 消息（模型还没产出正文或工具调用）。下一条用户消息请求时，这条消息会以 `content: null`、无 `tool_calls` 的形状发给 OpenAI 兼容提供方，DeepSeek 直接返回 `400 Invalid assistant message: content or tool_calls must be set`，之后每次发送都会撞上同一个错误。

日志仍是事实源：中断前的思考要留在对话界面里，所以不在写入时丢弃。归一化放在模型视图（`context.build`）：

- assistant 消息只保留有正文的文本和**已拿到结果**的工具调用；两者都没有就整条不进请求。
- 没有对应调用的孤立 `tool/result` 丢弃；结果未落地的工具调用（回合在两次调用之间被中断）从该条消息里去掉。

`packages/context/tests/context.spec.ts` 覆盖这两种形状：只有 reasoning 的 step 不进请求；中断后再发消息，请求里只留下正文与已完成的调用。

## 验证

- `packages/chat/tests/runtime.spec.ts`：运行中排队并在结束后作为独立回合执行；排队消息在工具返回后的步骤边界插话进同一回合（只产生一个回合，且该消息之后仍有 assistant step）；停止后排队照常开始；取回排队项；运行中切到 `read-only` 立即生效；全局 `full-access` 作为默认并让审批自动放行。
- `packages/ui-server/tests/api.spec.ts`：第二次提交返回 `201 { queued: true }`，运行中 fork 仍是 409；排队项的取回走通。
- 浏览器实测（mock 提供方，`POST /api/sessions/:id/model` 切到 `mock/mock-1`）：运行中回车出现排队气泡；权限 chip 在运行中可点，切成"仅可查看"后接口立即返回 `read-only`；回合结束后排队消息自动成为下一轮且气泡消失；设置 → 通用 → 默认权限含"完全权限"并弹出确认框。

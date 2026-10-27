# 会话运行中的权限与消息队列

三个相关改动：运行中可切换权限、完全权限可以作为全局默认、运行中提交的消息排队到下一轮。

## 问题

1. Composer 的权限 chip 在 `streaming` 时被禁用，用户想收紧/放宽权限必须等这一轮结束。
2. `PermissionService.modeFor`、`ChatService.permissionFor/create` 和设置页三处都显式排除了 `full-access`，它只能作为单个会话的临时选择。
3. `AgentService.prompt` 在会话运行时抛 `session is already running`，HTTP 层映射成 409，用户只能等回合结束再发送。

## 约束

- 追加日志是唯一事实源，模型可见 ⟺ 已落日志。
- 一批排队消息不能在当前回合的后续 step 里被模型看到：`context` 每个 step 都从日志重建历史。
- 权限判断必须读实时状态，不能在本轮开始时快照。
- 排队是运行态，不是会话状态；不引入新的事件类型。

## 方案

**权限热切换。** 权限本来就只落在 `session/meta` 上，`PermissionService.modeFor` 和 `AgentService` 的工具过滤、`ToolRegistry.invoke`、`ApprovalService` 每次调用都会重新读它，所以后端不需要改运行路径。真正挡住用户的是 UI：`PermissionSelect` 去掉 `streaming` 禁用，运行中切换立即作用于下一次工具调用与审批。Agent 模式选择仍保持禁用——`mode` 只在本轮开始时读取，中途切换会让 UI 与实际行为不一致。

**全局完全权限。** 删除三处 `!== 'full-access'` 过滤，以及 `settings-web` 的 `normalizeDefaultPermission` —— 那里还有一道"完全权限不能作为全局默认"的接口校验，只放行前三档。设置页的默认权限下拉恢复完整四档，选择完全权限时弹确认框（与 Composer 里的一致），确认后作为草稿，保存才生效。新会话创建时把默认权限写进 `session/meta`，已有会话不受影响。

**排队消息。** `ChatService` 为每个会话维护内存队列：

- `send()` 发现会话在运行时，生成 `QueuedMessage`（保留 id、文本、附件）入队，通过 `session-updated` 广播新的 `session.queued`，并返回 `{ message, queued: true }`。
- 日志此时**不**写入 `message/user`。若直接 append，当前回合下一次请求就会把这条消息当作历史，模型提前回答，之后排队轮又会重复一遍。
- `agent/turn-end` 后 `drain()`：取出队首，用 `ChatService` 生成的 id 调 `agents.prompt(..., { id })`，让浏览器里已经显示的排队项与最终日志项是同一行；剩下还有排队项时再广播一次 `session-updated`。
- `withdraw()` 取回队首之前的一条：移出队列、广播、把该条内容返回给调用方。`sendNow()` 把它挪到队首并中断当前回合，回合结束后它就是下一条。
- 停止（`stop()`）只中断当前回合，**保留**队列：回合结束即开下一条，与 Claude Code 按 Esc 的行为一致。
- 会话删除时一并清空队列。

客户端：`send` 在运行时不再校验 `streaming`，回车排队；发送按钮与停止按钮同时存在。`Transcript` 从 `session.queued` 渲染排队气泡（虚线、`排队中 · 当前回合结束后发送`），不写进 `messages`，因此 `buildPlan` 不会把正在运行的回合误判为已结束。每条排队气泡有三个动作，对齐 Claude Code 的排队交互：

- **发送**：`POST /api/sessions/:id/queued/:queuedId/send` → 中断当前回合、把该条提到队首，立刻成为下一轮。
- **编辑**：`DELETE .../queued/:queuedId` 取回该条，正文放回输入框（在已有草稿之前），回车即重新排队。
- **撤回**：同一个 DELETE，但只丢弃，不回填输入框。

## 失败模式

- **排队消息进日志的时序**：见上，只能在 drain 时 append。
- **SSE 帧丢失**：`useHarness.send` 在 HTTP 响应里再合并一次排队项并按 id 去重，事件流断了也不会看不到刚发的消息。
- **多标签页**：排队项以 `session.queued` 为准，第二个标签页无需本地状态也能显示。
- **刷新丢失**：队列是内存态，刷新后未开始的排队消息消失（与 Claude Code 一致）；日志里不存在"已排队但未开始"的回合。
- **drain 时又有新回合**：`prompt` 抛错时把消息留在队首，等下一次 `turn-end` 再试。

## 验证

- `packages/chat/tests/runtime.spec.ts`：运行中排队并在结束后作为独立回合执行；停止后排队照常开始；取回排队项；立即发送打断当前回合；运行中切到 `read-only` 立即生效；全局 `full-access` 作为默认并让审批自动放行。
- `packages/ui-server/tests/api.spec.ts`：第二次提交返回 `201 { queued: true }`，运行中 fork 仍是 409；排队项的取回与立即发送走通。
- 浏览器实测（mock 提供方，`POST /api/sessions/:id/model` 切到 `mock/mock-1`）：运行中回车出现排队气泡；权限 chip 在运行中可点，切成"仅可查看"后接口立即返回 `read-only`；回合结束后排队消息自动成为下一轮且气泡消失；设置 → 通用 → 默认权限含"完全权限"并弹出确认框。

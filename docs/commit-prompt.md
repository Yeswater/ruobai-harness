# 提交卡片（commit-prompt）

## 问题

「解决完一个问题后提示用户是否要提交」原本靠模型在对话里问一句「是否提交？」，再等用户回答。三个代价：

- **一次多余的模型往返**：写一条 message、发出去、等回答，token 与延迟都花在一句模板话上。
- **决定散落在对话里**：提交说明、涉及哪些文件、用户改没改，全在几条消息之间，回头找不着。
- **容易漏**：模型忙着下一步时根本不问，工作区攒着未提交的改动。

问句本身没有信息量——用户要的是一张写着现成 message 的卡片，和一个「提交」按钮。

## 约束

- **提交说明不能靠模型生成**：那就又成了一次模型往返。信息其实已经在手上——会话标题由用户写，文件列表 git 自己知道。
- **不提交的东西必须自动排除**：`AGENTS.md` §9 明令 `.env`、`.sessions/`、`.ruobai/`、`dist/` 不进提交。这些恰好都在工作区里，`git status` 一定会看到；生成式提交绝不能顺手把它们带进去。
- **提交范围必须是卡片上显示的那些文件**：用户在卡片上看到 2 个文件，点提交后就不能变成 5 个——卡片展示与实际提交必须同一份清单。
- **失败要能重试**：hook 拦下、索引锁、提交说明为空都发生过；卡片不能一次失败就消失。
- **沙箱与审批不参与**：`git.commit()` 是宿主侧服务调用，不走 `ctx.shell`，与 agent 的命令执行边界无关。

## 方案

两个包，按 §1 的服务端与 Web 适配器分离：

```
packages/commit-prompt/      CommitPromptService：准备 proposal、执行提交、/commit 命令
packages/commit-prompt-web/  HTTP + 广播
```

### message 从哪来

`packages/commit-prompt/src/message.ts` 是纯函数，可单测：

| 步骤 | 规则 |
|---|---|
| 类型 | 路径决定优先于措辞：全是 `docs/` 或 `.md` → `docs`；全是 `tests/` 或 `*.spec.*` → `test`；全是配置文件 → `chore`。路径混杂时才读标题里的词：`重构/拆分` → refactor，`修复/问题/失败` → fix，`新增/支持/实现` → feat；都没命中则「有新增文件 → feat，否则 fix」 |
| 主题 | 会话标题原文（`New session` 占位符视为空），截到 52 字符加 `…` |
| 备选 | 第二条是 `type: 更新 <最集中 2 个目录>（N 个文件）`，作为 diff 形状的兜底 |

会话标题通常就是用户的原话（「修复 输入框有两个输入按钮问题」），比模型概括更准，而且零 token。

### 谁唤起

- **自动**：`agent/turn-end` 且 `reason === 'done'`。`stopped` / `error` / `max-steps` 说明工作没做完，此时问提交等于请用户提交半个步骤，所以不弹。
- **手动**：`/commit` 命令。注册在 `Service.init` 里（见下方「踩到的坑」）。

同一份 diff 只问一次：proposal 带 `fingerprint = HEAD + 增删行数 + 排序后的路径`。用户点「稍后」后该指纹记入 `settled`，之后同样的脏树不再打扰；改动内容或文件变了就是新问题。仅用路径不够——同一个文件改两次必须重新问。

### 提交范围

`partitionChanges()` 在服务端按 `AGENTS.md` 的黑名单过滤，`kept` 进 `files`，`skipped` 单独返回并在卡片上说明（「已排除 1 个 harness 自身状态文件」）。提交时只 stage `files`，因此：

- 卡片显示的就是会提交的，不多不少；
- 卡片弹出后工作区又冒出的文件不会被卷进来（有单测覆盖）。

### 服务端接口

```
GET  /api/commits?sessionId=…      → { proposals: CommitProposal[] }
POST /api/commits/:id              → { resolution }    body: { action: 'commit' | 'dismiss', message? }
```

广播走 `ui.broadcast('commit', { kind: 'requested' | 'resolved', … })`，与 `ask` / `todo` 同构；浏览器 `EventSource` 与 WebSocket 两条通道都在 `api.ts` 里接了。

### 浏览器侧

`CommitCard` 只收 plain props（`proposal` / `onCommit` / `onDismiss`），无 Cordis、无 transport。message 是可编辑输入框，候选是 chip，文件列表常显。

## 失败模式

- **`auto` 让每条完成的回合都弹卡**：确实如此——只要还有未提交改动。这是有意的：漏提交比多一次「稍后」更糟。想彻底静音把 `commit-prompt` 的 `auto` 设成 `false`，卡片只留 `/commit`。
- **指纹只看路径**：已修。只看路径时，同一文件改两次的第二次不会弹卡；现在把增删行数并进指纹。
- **提交失败吞掉卡片**：`resolve()` 在 `git.commit()` 抛错时把 proposal 放回 `pending` 再抛出，用户能改说明重试。
- **空 message**：服务端拒绝并保留卡片；前端按钮也是 `disabled`。
- **非 git 工作区 / 干净工作区**：`propose()` 返回 `null` 而不是抛错。自动路径不能因为「没东西可提交」让回合失败。
- **子智能体会话**：`kind === 'subagent'` 直接返回，卡片归父会话所有，否则一个任务会弹好几张。
- **多标签页**：以 `GET /api/commits` 为准，另一标签页点提交后本页收到 `resolved` 帧清卡。

### 踩到的坑：`Service` 构造函数里的 `ctx.effect` 是静默失效的

第一版把 `ctx.effect(() => ctx.on('agent/turn-end', …))` 写在 `constructor` 里。测试里 `ctx.commitPrompt.config` 正常、事件也能 emit，但卡片永不出现——Service 的构造函数先于 fiber 激活运行，此时注册的 effect 不入 disposer 表，被直接丢弃，且**不报错**。

这与 `AGENTS.md` §2「异步初始化不能写在 class constructor 的 effect 里」是同一类事故的另一面：不只是异步要挪走，`ctx.effect` 本身就得在 `[Service.init]` 里注册。现在两者都在 `async *[Service.init]()` 中 yield。

## 验证

`packages/commit-prompt/tests/`：

- `message.spec.ts`：标题优先、docs/test/chore 由路径决定、混杂时读措辞、无措辞时按新增/编辑判型、目录聚合成 scope、主题截断。
- `service.spec.ts`：propose 生成的 message/files/stat；干净工作区返回 `null`；只提交 `files` 里列出的文件（卡片弹出后新增的文件留在工作区）；「稍后」后同一 diff 不再问、改动后重新问；空 message 被拒且卡片存活；`.ruobai/` 与 `dist/` 被排除且不出现在提交里；HTTP 取列表与提交、重复提交 404；`ui/broadcast` 帧；`turn-end(done)` 自动弹卡，`stopped` / `error` 不弹。

浏览器实测（临时实例 4419，工作区为 `/tmp` 下的测试仓库，mock 提供方）：

- `/commit` 唤起卡片，内容为 `fix: 修复 输入框有两个按钮`，2 个文件 · +3 −1，并标注「已排除 1 个 harness 自身状态文件（.ruobai/wiki/.index/index.json）」。
- 点「提交」后 `git log` 新增 `fix: 修复 输入框有两个按钮`，`git show --name-only` 只有 `app.txt` / `extra.txt`，`.ruobai/` 仍在工作区未提交。
- 改一个文件再跑一轮，卡片重新出现；点「稍后」后卡片消失、无提交、`pending` 归零。

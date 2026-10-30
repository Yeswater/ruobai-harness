# 工具层：大文件、搜索、视觉验收与基线对照

这份文档对应一组来自实际编码会话的反馈：单文件 1.1 万行的样式表读不了也改不了、grep 对跨行正则直接返回空、视觉改动无法截图、测试抖动只能手工 stash 对照、临时文件被迫写进源码树。下面记录每一条的原因、修法与边界。

## 1. 大文件读写

**原因**：`read_file` 与 `write_file` 共用 `maxBytes`（默认 64 KiB）。`read_file` 超过就直接报错；`edit_file` 虽然读文件不受限，但预览和落盘都要求「结果 ≤ maxBytes」，于是一个 300 KB 的 CSS 文件永远改不了。审批卡里的 diff 还会因为 LCS 表过大退化成「N lines changed」，等于没有预览。

**修法**：

| 入口 | 行为 |
| --- | --- |
| `read_file` | 新增 `offset`（1 基行号）与 `limit`（默认 2000，上限 5000）。文件超过 `maxBytes` 时自动返回窗口，首行是 `[path: lines 1-2000 of 11642 | 312345 bytes | next offset=2001]` |
| `edit_file` | 受新的 `maxEditBytes`（默认 8 MiB）约束，而不是读上限；整文件重写不再因为「超过 64 KiB」失败 |
| 检查点 | `checkpoints.maxBytes` 提到 2 MiB，大文件改动仍可回滚（内容寻址，只存不同版本） |
| diff 预览 | 先裁掉公共前后缀，再对中间段做 LCS；改一行就是一小段 hunk，并带 3 行上下文 |

**边界**：超过 8 MiB 的文件仍拒绝整文件编辑，错误信息会说明「按窗口读、用 write_file，或调大 maxEditBytes」。二进制文件保持不变。

`bash` 的单条命令上限是 32k 字符（此前 8k，heredoc 补丁很容易超过）。超限时错误会建议拆分步骤，或把大段内容交给 `write_file` / `edit_file`。

## 2. grep

**原因**：`grep` 逐行读文件并对每一行跑正则，`\.a \{[\s\S]{0,1800}?\.b \{` 永远不可能匹配单行，于是返回“No matches”，而不是告诉调用方匹配模式用错了。

**修法**：

- 新增 `multiline` 参数：整文件读取（上限 2 MiB），正则加 `s` 与 `m` 标志，结果给出起始行号与压平后的片段。
- 没开 `multiline` 而模式看起来跨行（`\n`、`[\s\S]`、`(?s)` 等）时，空结果会附带提示。
- 截断信息说明如何继续：提高 `maxResults`（≤500）或缩小搜索范围；多行模式下单独报告因体积被跳过的文件数。

## 3. 临时文件

`write_file` 一直可以写 `.ruobai/`（它已在 `.gitignore` 里），但系统提示没有说明，模型就选了 `src/.tmp-*`。

修法：默认系统提示加入「临时文件放 `.ruobai/scratch/`，不要放进源码树」，`write_file` 的描述同步说明。没有新增工具，也没有新的写路径。

`.ruobai/` 同时被 `grep` / `glob` 忽略：检查点 blob 是源码的副本，不忽略会让每次检索都把同一段代码报两遍。

## 4. 测试抖动与基线

**原因**：判断「这条失败是不是我改的」需要 stash、跑基线、pop、再跑、重复三次；stash 期间一旦 pop 冲突或中断，在途改动就悬空。

新增两个脚本：

```bash
pnpm test:flake packages/memory-distill/tests/x.spec.ts --runs 5
pnpm test:baseline                             # 当前 HEAD 的全量
pnpm test:baseline --ref origin/main           # 指定 ref
pnpm test:baseline packages/tool-fs/tests/fs.spec.ts
```

- `test:flake`：连续跑同一个文件，输出 `pass/FAIL` 序列；失败的那次打印末尾 25 行。首次失败就足够说明「它不稳定」，不必再猜。
- `test:baseline`：用 `git worktree add --detach` 在临时目录里检出指定 ref，`pnpm install --offline` 后运行，结束自动移除。它**不碰当前工作区**，所以没有 stash/pop 的风险，也不需要另开终端记数据。

实测：本机对一个瞬时失败的 `workspace-web` 用例跑 `--runs 3`，3/3 通过，确认与改动无关。

## 5. 视觉验收

**原因**：harness 的工具有文件、命令、检索，没有浏览器。视觉任务只能以 `typecheck` + `build:ui` 收尾，而这恰好答不了「看起来对不对」。

新增 `@ruobai/browser-preview`（默认挂载）。它保留一个**跨调用存活的页面**：打开、快照、点击、输入、截图都作用于同一份文档，交互式验收不再需要每次从零加载：

| 工具 | 作用 |
| --- | --- |
| `browser_open({url \| preview})` | 打开 URL，或按 `launch.json` 配置名打开已运行的预览服务器；之后可省略 url |
| `browser_snapshot({maxNodes?})` | 无障碍树，每行 `uid=… role "name"`；uid 是点击/输入的句柄 |
| `browser_click({uid \| selector})` / `browser_fill({uid \| selector, value})` | 真实鼠标事件与 input/change 事件；可写工具，只读模式不可用 |
| `browser_console({level?, clear?})` | 页面 console（log/info/debug/warning/error/异常） |
| `browser_network({filter?, requestId?})` | 请求列表与状态；`failed` 只看失败，`requestId` 读响应体 |
| `browser_resize({preset \| width/height, colorScheme?})` | mobile / tablet / desktop 或显式尺寸，可切换配色方案 |
| `browser_screenshot({fullPage?, includeImage?, reload?})` | 同一页面的 PNG，存到 `.ruobai/screenshots/`，返回路径、标题、尺寸、控制台错误与警告 |
| `browser_eval({expression, reload?})` | 同一页面里执行表达式，返回 JSON；用于计算样式、`scrollWidth` 溢出、`matchMedia('(prefers-color-scheme: dark)')` |
| `browser_close({url?, all?})` | 关闭当前页面或本会话全部页面，释放 Chrome 进程 |

实现取舍：

- **不引入依赖**：通过 Chrome DevTools Protocol 直连，使用 Node 22 自带的全局 `WebSocket`。
- **页面按（会话, URL）复用**：首次调用启动 `--headless=new` 与独立临时 profile；之后沿用同一页面，空闲 `idleMs`（默认 120 s）关闭，每会话最多 `maxPages`（默认 4）个页面，按最久未用回收；进程内仍串行，避免多个 Chrome 同时跑。
- **不带尺寸的调用不改视口**：只有显式传 `width`/`height`/`colorScheme` 或 `browser_resize` 才会改，之前切换的尺寸不会在下一步被悄悄重置。
- **默认只允许 loopback**（`127.0.0.1` / `localhost` / `::1`）。要截远程页面，必须在 `cordis.yml` 的 `allowedHosts` 里显式添加——边界写在代码里，而不是让工具自己决定。
- **`preview` 参数只读**：按配置名取已运行服务器的 URL，不会启动命令；启停仍是用户在预览面板里的动作。
- **控制台错误算结果的一部分**：页面截图正常但脚本报错是常见情况，工具会把 `console.error`、未捕获异常与 `Log.entryAdded` 一起返回。
- **实时投屏**：页面一打开就通过 `Page.startScreencast` 推帧到右侧预览面板（`browser` 通道），并在首次打开时自动展开，用户看到的就是模型正在操作的那一页；可切回开发服务器视图。详见 [`terminal-and-preview.md`](terminal-and-preview.md)。
- 整页截图高度封顶 4000 px，避免一张图几十 MB。
- 截图会作为工具结果的一部分交给视觉模型；纯文本模型只收到路径与说明。详见 [`tool-images.md`](tool-images.md)。

Chrome 不在常见路径时，工具返回明确的错误，要求设置 `browser-preview.chromePath`；没有 Chrome 的机器上功能不可用，但不会影响其他工具。

## 6. 工作区并发

一次真实事故：另一个会话把同一工作区里的在途样式改动 `git add` 进了自己的提交，随后才发现 `git status` 里“改动不在了”。

这不在插件能拦截的范围（提交是另一个进程的 `git`），但可以降低概率：

- 提交前只暂存本次相关路径，不要 `git add -A` / `git add .`（`AGENTS.md` 已有此约定）；
- 判断「这条改动是不是我的」用 `git diff <path>`、`git show` 这类只读方式，不用 `git add` 试探；
- 基线对照一律用 `test:baseline`，它不碰工作区；
- 同一工作区里并行多个会话时，先看 `git status` 再提交，并把自己的改动留在自己的提交边界内。

## 7. 工作方式：一次实测复盘

对一次真实会话（修复两个 UI 缺陷，25 分钟）的事件日志做了统计：405 次工具调用、406 个模型步骤，**没有任何一步发出两个并行调用**；`bash` 210 次，其中 `head` 73、`grep` 71、`sed -n` 55、`ls` 49，而 `read_file`、`grep`、`glob` 这些专用工具几乎没用；同一个 `useHarness.ts` 被 `cat`/`sed` 读了 14 次。浏览器侧 95 次 `browser_eval`、29 张截图，多次把「连续点击」塞进同一个 eval，随后把 React 尚未提交的状态误判成产品 bug。沙箱拒绝后换命令重试，加上启动 dev server 的 `sleep`，累计 194 秒。

结论不是「模型不够聪明」，而是原来的系统提示只有 6 句话，没有告诉它：文件工具的相对路径以工作区为根、读文件该用哪个工具、独立调用应当合并在一步、浏览器 eval 不是点击工具、沙箱拒绝后不该换命令重试。修法：

- 基础提示改为分节的操作规范（工作方式、路径与环境、工具选择、边界），把上述失败模式逐条写成可执行规则；保留「推理用中文」。
- `context` 新增 `environment` 提示段（顺序在 base 与 mode 之间）：工作区根、平台、日期、是否 git 仓库及分支，并明确「文件工具的路径以工作区根为基准，越界会被拒绝；bash 也从这里开始但受沙箱限制」。工作区与用户所指的仓库不是同一个目录时，模型第一步就能看见，不必再靠失败调用推断。
- `bash`、`read_file`、`write_file`、`edit_file`、`browser_eval`、`browser_click`、`browser_fill` 的描述分别写明：读文件别用 `cat/sed/grep/find`、一次调用只做一件事、不要用 shell 改文件、eval 只做只读检查、点击/填值前先取新快照。
- `write_file` / `edit_file` 的成功信息返回解析后的绝对路径，`resolveInside` 的越界错误带上工作区根，避免「相对谁」的歧义。

## 8. 工具目录按需加载

同一份会话日志里，46 个工具中实际只用了 12 个：gitee、wiki、memory、contract、delivery、plan_submit、skill_propose 等 25 个领域工具整场未用，却每个请求都随 schema 渲染。首步上下文约 1.3 万 token，工具 schema 占了大头。

修法不是删能力，而是把「默认可见」和「注册存在」分开：

- `ToolDefinition.defer`：标记领域工具；默认不进入请求，除非当前会话用 `tool_search` 打开，或者模式在 `allowTools` / `extraTools` 里显式列出（Ask/Plan 列了只读 gitee 三件套，Goal 列了 `goal_complete`，所以这些模式行为不变）。
- `ToolRegistry.offered(sessionId, { allow, includeDeferred, deny })`：一次请求真正渲染的集合；`list()` 仍返回全量，UI 与诊断不受影响。
- `ToolRegistry.searchDeferred(query, allow)`：按工具名、分组前缀、描述与 `keywords`（含中文）打分；`activate(sessionId, names)` 把命中的工具打开到会话结束。激活状态随会话删除回收，不落日志，刷新后重新检索。
- Agent 新注册 `tool_search` 工具（约 300 字 schema），并在 `agent/decision.available` 里记录**本次真正可见**的工具，而不是全量目录。

实测（测试 harness 装配全部插件）：全量 47 个，Agent 模式可见 **22 个**；schema 字节数 32,385 → 17,428（约 −46%）。Ask 仍是 7 个，Plan 8 个，Goal 23 个，没有因延迟加载丢工具。

## 验证

- `packages/tool-fs/tests/fs.spec.ts`：12000 行文件的分段读、末尾窗口、以及超过读上限的 `edit_file` 成功且校验点仍可捕获。
- `packages/tool-fs/tests/search.spec.ts`：跨行模式默认无结果并提示 `multiline`，开启后命中起始行。
- `packages/ui-app/tests/tool-diff.spec.ts`：5000 行文件里改一行，diff 小于 20 行且行号正确。
- `packages/browser-preview/tests/browser.spec.ts`：URL 白名单；无障碍树与网络整形单测；真实无头 Chrome 的「打开 → 快照 → 按 uid 点击/填值 → 控制台/网络 → 移动端尺寸 → 关闭」与按 preview 配置名打开（Chrome 缺失时该组按运行时探测跳过）。
- `pnpm test:baseline packages/tool-fs/tests/fs.spec.ts` 实测可用（临时 worktree，结束后自动移除）。

## 失败模式

| 情况 | 行为 |
| --- | --- |
| 文件 > 8 MiB 需要编辑 | 明确报错并给出替代路径，不静默截断 |
| `offset` 超出文件行数 | 返回空窗口与提示，不伪造内容 |
| 多行 grep 的文件 > 2 MiB | 跳过并计数，不静默漏掉 |
| 没有 Chrome | 截图/求值返回可行动的错误；其他工具不受影响 |
| Chrome 关闭时 profile 未删净 | 清理是 best-effort，临时目录残留不影响功能（ENOTEMPTY 不再变成工具失败） |
| 基线 worktree 安装失败 | 脚本以非零退出并保留错误；不会影响当前检出 |

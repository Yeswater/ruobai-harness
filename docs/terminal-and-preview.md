# 终端与服务器预览

给 harness 补上两块日常开发入口：底部可交互终端，以及右侧的开发服务器预览。交互对齐 Claude Code 的对应功能：多标签、清屏、展开；`launch.json` 启停、日志、内嵌页面、外部打开。

## 1. 终端

### 链路

```
xterm.js (浏览器)  ⇄  /api/terminal  ⇄  TerminalService  ⇄  pty_bridge.py  ⇄  $SHELL
```

- `@ruobai/terminal` 管理 shell 生命周期，输出通过 `terminal/output` 事件推到 `ui` 广播通道（SSE + WebSocket）。
- `@ruobai/terminal-web` 提供列表、创建、输入、resize、缓冲区与关闭。
- 前端 `TerminalPanel` 用 xterm 渲染；输入按 8 ms 合并后 POST，避免逐键请求。

### 为什么用 Python 而不是 `script(1)`

macOS 的 `script` 在标准输入输出是管道时会失败（`tcgetattr: Operation not supported on socket`），而 harness 只能用管道与子进程通信。`packages/terminal/src/pty_bridge.py` 用标准库 `pty.fork()` 分配伪终端并在两路之间转发字节，不引入原生 Node 模块。

- 初始窗口大小由 `COLUMNS`/`LINES` 传给 helper，并在 fork 后用 `TIOCSWINSZ` 设置。
- 动态 resize 通过 NUL 前缀的控制行 `\0resize:<rows>:<cols>\n` 传给 helper；键盘无法产生 NUL，所以不会和正常输入冲突。
- 关闭终端会向进程组发 `SIGTERM`，750 ms 后 `SIGKILL`，避免 `python3` 退出后 shell 残留。

### 边界

- **终端只给用户，不注册 agent 工具。** 它继承用户的完整环境，不经过 Seatbelt；如果模型能写它，就是一条绕过命令沙箱的通道。
- 终端 cwd 必须位于工作区内（`root` 默认为 `process.cwd()`）。
- 最多 6 个终端；每个保留最近 200 KB 输出用于重连回放。
- 需要 `python3`（macOS 自带命令行工具即满足）。缺失时终端会显示明确的错误，其他功能不受影响。
- 页面刷新或关闭面板不会杀掉 shell；重新打开时从服务端缓冲区恢复。

### 已支持的交互

多标签、新建 / 关闭、清屏、展开（55vh）、深色/浅色跟随主题、粘贴（客户端按 32 KB 分片）、`⌘J` 开关。

### 页签生命周期

- 首次打开面板只创建一个 shell：挂载请求用一个共享 Promise，StrictMode 的二次执行不会重复创建。
- 创建响应与服务端 `changed` 帧会竞争，列表按 id 合并去重；服务端快照是成员关系的权威。
- 关闭先在本删除并释放 xterm；服务端 `kill` 同步移除条目再发 `changed`，因此退出事件不会把刚关掉的页签“复活”。
- 编号复用最小空闲值：关掉 2 号后新终端仍叫 2 号，不会一路涨到几十。

## 2. 服务器预览

### 配置

读取 `.ruobai/launch.json`，没有时回退到 `.claude/launch.json`（与 Claude Code 共用格式）：

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "app",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dev"],
      "port": 4310
    }
  ]
}
```

字段：`name`、`runtimeExecutable`、`runtimeArgs`、`port`、`url`（可省略，默认由 port 推出）、`cwd`（相对工作区）、`autoPort`（覆盖全局默认）。

- `port: 0` 表示总是挑一个空闲端口；端口被占用时默认也会自动换一个（`autoPort: true`）。
- 子进程的 `PORT` 永远被设为实际使用的端口，父 harness 自己的 `PORT` 不会泄漏给子进程。命令如果不用 `PORT`，可以在 `runtimeArgs` 里用 `{port}` 占位符。
- `autoPort: false` 时端口冲突直接显示失败原因，不启动进程。

重名、缺可执行文件、非法端口/URL 都会在面板里显示为配置错误，不会启动任何进程。

### 行为

- 启动前检查端口：被占用时自动选择空闲端口，并在日志里写明 `port 4310 is in use; using 51234`；`url` 会同步改成新端口。
- 启动后等待端口可连接（默认 30 s）；进程提前退出则标记为失败，并把日志尾巴留在面板里。
- 命令以独立进程组运行，停止时先 `SIGTERM` 整个组，2 s 后 `SIGKILL`，`pnpm dev` 拉起的子进程不会残留。
- 每次启动清空服务端日志；面板同步清空本地镜像。
- 服务器自行退出时状态回到“已停止”，不会继续显示“运行中”。
- 日志按行转发（最多 400 行，去掉 ANSI），通过 `preview` 通道实时推送。

### 边界

- **只有 UI 能启停。** 没有 agent 工具：`launch.json` 是工作区文件，模型可写；若再给它一个“执行已声明命令”的工具，就形成审批之外的执行通道。`browser_open` 的 `preview` 参数只读取已运行配置的 URL，不会启动命令。
- 配置和命令都限定在工作区内。
- 内嵌页面来自本地服务器，和 harness 不同源，因此面板**读不到 iframe 的控制台与网络**。需要检查页面内部状态时，用 `@ruobai/browser-preview` 的无头页面（见下节）。
- 如果命令不读取 `PORT`（例如把端口写死在参数里），自动换端口不会生效；这类配置应使用 `{port}` 占位符或 `autoPort: false`。

### agent 侧：一个保持状态的页面

`@ruobai/browser-preview` 不是每次调用新开浏览器，而是**每个（agent 会话, URL）保留一个页面**，工具之间共享同一份文档状态，所以「打开 → 看快照 → 点击 → 输入 → 截图」是一条连贯的验证流程：

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 打开 URL（或已运行的 preview 配置名），之后可以不传 url |
| `browser_snapshot` | 无障碍树，每行 `uid=… role "name"`；uid 是后续点击/输入的句柄 |
| `browser_click` / `browser_fill` | 按 uid 或 CSS 选择器点击/填值，派发真实鼠标与 input/change 事件 |
| `browser_console` | 页面 console（log/info/debug/warning/error/异常），可 `clear` 开新的观察窗口 |
| `browser_network` | 请求列表与状态，`filter: failed` 只看失败，`requestId` 读响应体 |
| `browser_resize` | mobile 375×812 / tablet 768×1024 / desktop 或显式尺寸，可切换配色方案 |
| `browser_screenshot` / `browser_eval` | 同一页面上的截图与表达式求值 |
| `browser_close` | 关闭当前页面或本会话全部页面，释放 Chrome 进程 |

页面在最后一次调用后 `idleMs`（默认 120 s）自动关闭；每个会话最多保留 `maxPages`（默认 4）个页面，超出按最久未用回收。导航仍限定 loopback（`browser-preview.allowedHosts` 可放开）。点击与输入标记为可写工具，只读权限模式下不可用。

### 实时投屏：让用户看到模型在操作的那一页

页面一打开就通过 CDP `Page.startScreencast` 采帧（JPEG、质量 60、每 2 帧取 1），经 `ui.broadcast('browser', …)` 走 SSE / WebSocket 推给浏览器；`chat` 之外多了一条 `browser` 通道，帧里带 `sessionId`、页面标题、URL 与实际视口尺寸。

客户端（`PreviewPane`）按当前会话过滤：

- 收到 `open`（`fresh: true`）时右侧预览面板**自动打开**并切到「模型页面」；面板晚于事件挂载时，从模块级的最新帧缓存补齐，不会空着等下一次重绘。
- `frame` 以 100 ms 间隔节流，被丢掉的中间帧会保留最后一帧补发——镜像是给人看的，不追求逐帧一致。
- 标题栏显示「模型正在操作」的页面标题与 URL，并用一个按钮在「模型页面 / 开发服务器」之间切换；面板原本的 `launch.json` 启停、日志、iframe 全部保留在服务器视图里。
- `close`（手动关闭、空闲回收、插件卸载）后回到服务器视图。
- 每帧都要 ack（`Page.screencastFrameAck`），否则 Chrome 自己停流；静态页面只有首帧，发生重绘才会继续推。

## 3. 安全模型

这里新增了两个 loopback 上的执行面：终端输入与预览启停。约束如下：

1. 两者都只通过 HTTP API 暴露给页面，没有注册成工具。
2. HTTP 面沿用 harness 的边界：`web-auth` 配置了 token 时，所有 `/api/*` 都要求凭据；未配置时仅绑定 `127.0.0.1`。
3. agent 的 bash 走 Seatbelt，默认网络只允许 443，无法访问 harness 的端口；用户若显式放开网络，也就等于接受本地 API 可被访问。
4. `launch.json` 的命令只来自磁盘上用户可审的文件，启动动作必须由用户点击。

## 4. 验证

- `packages/terminal/tests/terminal.spec.ts`：真实 pty 执行 `echo`、`pwd`、退出事件、cwd 越界拒绝、HTTP 输入/缓冲区/关闭。
- `packages/preview/tests/preview.spec.ts`：真实启动一个 Node HTTP 服务、端口就绪、HTTP 请求、日志、停止后端口关闭；重复配置报错；HTTP 启停。
- 浏览器实测：底部终端渲染 zsh 提示符并成功执行 `echo ui-terminal-ok`；预览面板选择 `fixture` → 启动 → 状态“运行中” → iframe 显示页面 → 停止后回到“已停止”。截图见 `docs/assets/`（本地验证，未提交图片）。

## 5. 与 Claude Code 预览的差异

Claude Code 的预览是**一个应用内的浏览器页签**：`.claude/launch.json` 里的配置由 `preview_start`（模型可调用）拉起，模型再用 `preview_snapshot` / `preview_click` / `preview_fill` / `preview_screenshot` / `preview_console_logs` / `preview_network` / `preview_resize` 直接驱动这个页签，用户看到的就是模型在操作的那一页；页面天然跨调用保持状态。

ruobai 现在把这套交互能力补齐到了工具层，但仍刻意保留两条边界：

| | Claude Code | ruobai |
| --- | --- | --- |
| 启动服务器 | `preview_start` 工具，模型可调 | **只能用户点「启动」**；工具只能按配置名读取已运行 URL |
| 浏览器在哪 | 应用内的预览页签 | 独立的无头 Chrome（`browser-preview`） |
| 跨调用状态 | 同一页签 | 同一页面：按（会话, URL）复用，空闲 120 s 回收 |
| 截图 / 快照 / 点击 / 输入 / 控制台 / 网络 / 尺寸 | `preview_*` 全套 | `browser_*` 全套（`browser_open` 起首，之后可省略 url） |
| 用户能否看到模型正在看的页面 | 是，同一个页签 | 是：右侧预览面板实时显示同一页面的 screencast，可切回开发服务器 |
| 选择器 | 快照 uid + CSS | 快照 uid + CSS |

仍未做：在面板里直接操作用户手势（目前只做镜像，输入仍由模型通过 `browser_click` / `browser_fill` 发起）；终端与 IDE 的集成、任务/工作树面板；Windows 终端（需要 ConPTY）。

验证：`packages/browser-preview/tests/browser.spec.ts` 的无障碍树/网络整形单测，以及真实 headless Chrome 的「打开 → 快照 → 按 uid 点击 → 按 uid 填值 → 读控制台/网络 → 切 mobile 尺寸 → 关闭」集成用例与「open / frame / close 投屏事件」用例。

## 6. 与 Claude Code 的终端差距

已对齐：多终端、清屏、展开、终端持久化。

未做（不在本轮范围）：终端与 IDE 的集成、任务/工作树面板；Windows 终端（需要 ConPTY）。

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

- **只有 UI 能启停。** 没有 agent 工具：`launch.json` 是工作区文件，模型可写；若再给它一个“执行已声明命令”的工具，就形成审批之外的执行通道。
- 配置和命令都限定在工作区内。
- 内嵌页面来自本地服务器，和 harness 不同源，因此面板**读不到 iframe 的控制台与网络**。需要检查页面内部状态时，用 `browser_eval` / `browser_screenshot`（`@ruobai/browser-preview`）对同一 URL 另开无头页面。
- 如果命令不读取 `PORT`（例如把端口写死在参数里），自动换端口不会生效；这类配置应使用 `{port}` 占位符或 `autoPort: false`。

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

## 5. 与 Claude Code 的差距

已对齐：多终端、清屏、展开、终端持久化；`launch.json`、启停、日志、内嵌预览、外部打开、失败原因。

未做（不在本轮范围）：

- 终端与 IDE 的集成、任务/工作树面板；
- 预览页面的控制台、网络面板与点击/输入自动化（`browser_*` 工具覆盖了页面求值与截图，但没有 iframe 内的元素驱动）；
- Windows 终端（需要 ConPTY）。

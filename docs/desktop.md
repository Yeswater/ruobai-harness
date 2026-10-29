# 桌面端

> 目标：不改协议、不搬 UI，把现有的 `pnpm dev` 组合装进一个可以双击打开的窗口。
> 相关实现：`apps/desktop/`、`apps/cli/src/bin.ts`、`apps/cli/src/boot.ts`。

## 1. 参考对象

### Claude Code 桌面端

Claude Code 的桌面端没有开源，能直接确认的是它的产品形态，而不是内部实现：

- 以 Electron 应用分发（macOS 的 `Claude.app`），Code 标签页管理本地会话，也管理 SSH / 云端会话。
- CLI 仍然是执行体：桌面端负责窗口、会话管理、文件选择、通知、预览这些原生能力，模型调用与工具执行仍由后端进程完成。
- 因此它的桌面端是一层**进程管理与原生壳**，不是把 agent 重写进渲染进程。

内部 IPC 协议、会话进程的生命周期细节属于闭源部分，本文不当作事实引用。

### dsh（deepseek-harness）

dsh 目前**没有**桌面端，但已经把接入口留好了（见 `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md`）：

- `packages/host/*` 与 `packages/client/*` 严格分层，协议定义在 `apiproxy`，浏览器可 `import type`。
- 客户端继承 `AbstractApiClient`，平台差异只体现在 `doFetch` 一个切面；已有 `InProcessApiClient`、`WebApiClient`、`FixtureApiClient`。
- 文档明确写着「将来的 Electron 应用经由 IPC fetch 载体复用同一套 web client 包」，并注明该形态**尚未实现**；`webserver` 也注明「Electron 不复用它」。
- 应用层只有 `apps/cli` 与 `apps/web`。

结论：dsh 的路线是「先把协议与传输解耦，再让 Electron 只换载体」。ruobai 的客户端并没有做这层抽象，直接照搬会先付出重构成本。

| | Claude Code 桌面端 | dsh | ruobai（本实现） |
| --- | --- | --- | --- |
| 壳 | Electron（闭源） | 预留 Electron 形态 | Electron 45 |
| UI 来源 | 桌面端自带渲染层 | 同一套 client 包 | 现有 `ui-app`，浏览器 UI 原样加载 |
| 通信 | 壳内 IPC（细节未公开） | 计划：IPC fetch 载体 | 本机 loopback HTTP + SSE + WebSocket |
| 后端 | CLI / agent 进程 | host + client 同源 | `apps/cli` 子进程 |
| 原生能力 | 窗口、会话、文件、通知 | 待实现 | 窗口、菜单、文件夹选择、外部浏览器 |

## 2. 采用方案

```
Electron 主进程 (apps/desktop/src/main.ts)
  │  spawn（独立进程组）
  ▼
apps/cli/src/bin.ts  ── 与 `pnpm dev` 完全相同的组合
  │  cordis.yml → 全部插件
  ▼
web-server :0 ── 静态 UI / /api / SSE / WebSocket
  ▲
  │  loadURL(loopback)
BrowserWindow（无 nodeIntegration，sandbox）
```

### 为什么直接复用 HTTP，而不是 dsh 式 IPC 载体

- 浏览器侧已经用 `fetch` + `EventSource` + WebSocket 消费 `ctx.web`，这些就是当前唯一的 wire。再实现一套 IPC 载体，等于同时维护两条协议路径；按 AGENTS「没有核心里的 if」，这条分叉没有收益。
- Electron 的渲染进程和本机服务在同一台机器上，loopback HTTP 的延迟与安全边界都足够；`127.0.0.1` 只监听本机，默认无 token。
- 桌面上线不需要改动任何插件、事件或投影。`cordis.yml` 一行未变。
- 代价是保留了一个 HTTP 端口。端口用 `--port 0` 交给系统分配，避免与 `pnpm dev` 冲突。

### 为什么是 Electron，不是 Tauri

- 与 Claude Code 桌面端、dsh 的预留方向一致。
- 后端是 Node 进程，Electron 主进程管理子进程、解析输出、处理信号都是 Node 原生能力，不需要 Rust 侧桥接。
- 代价是 `electron` 包体积大（本机安装后 `dist/` 约 258 MB），这一成本被接受。

## 3. 进程与目录

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/main.ts` | 应用生命周期、窗口、菜单、原生能力、崩溃恢复 |
| `apps/desktop/src/harness.ts` | 启动/停止 harness 子进程，解析就绪 URL，回收进程组 |
| `apps/desktop/src/bounds.ts` | 窗口位置与工作区约束（纯函数） |
| `apps/desktop/build.mjs` | 用 esbuild 把主进程打成 `dist/main.mjs` |

启动链：

1. `pnpm desktop` → esbuild 构建主进程 → Electron。
2. 主进程按 `--workspace` / 位置参数 / 上次会话或 `RUOBAI_WORKSPACE` / 检出目录的顺序确定工作区。
3. 以独立进程组启动 `apps/cli/src/bin.ts`：`<root>/cordis.yml --workspace <dir> --port 0`。
4. CLI 在 `web-server` 监听后向 stdout 打印 `[ruobai-harness] ui: <url>`。
5. 主进程读到该行，创建 `BrowserWindow` 并 `loadURL`。
6. 退出时 `before-quit` 先向整个子进程组发 `SIGTERM`，5 秒后升级 `SIGKILL`。

### `--workspace`：配置来自检出，状态落在工作区

桌面端要能打开任意目录，但插件必须从 harness 检出加载。为此：

- `apps/cli` 先解析配置的绝对路径，再 `chdir(workspace)`，因此 `cordis.yml` 里的 `process.cwd()`（会话、检查点、工具根、沙箱范围）都指向工作区。
- `boot()` 的 `ctx.baseUrl` 改为**配置文件所在目录**，而不是进程 cwd；否则 Loader 会去工作区里找 `@ruobai/*` 包（实测报 `Cannot find package '@ruobai/cordis-plugin-include'`）。

实测：在 `/tmp/rbu-desk-test` 启动后，该目录出现 `.ruobai/` 与 `.sessions/`。

## 4. 安全边界

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层拿不到 Node。
- 权限请求默认拒绝，只放行剪贴板读写（复制按钮需要）。
- 新窗口与外部导航只允许 harness 自己的 origin；其余 `http(s)` 交给系统浏览器，其余协议丢弃。
- 桌面壳不接触文件系统与命令执行；这些仍在 harness 进程，并继续受 `sandbox-policy` / Seatbelt / 审批约束。
- 若设置了 `RBU_TOKEN`，桌面端加载 URL 时自动带上 `?token=`，复用现有登录门。

## 5. 失败模式

| 情况 | 行为 |
| --- | --- |
| harness 60 秒内未打印 URL | 弹出错误框并退出，附最后 20 行 stderr |
| harness 在就绪前退出 | 同上 |
| 运行中崩溃 | 弹框选择「退出 / 重新启动」 |
| 端口被占用 | 不会发生：始终用系统分配的端口 |
| `ui-app/dist` 存在 | 子进程 `NODE_ENV=production`，直接服务静态产物 |
| 未构建 UI | 回退 Vite 中间件（`RUOBAI_DESKTOP_UI=dev` 可强制） |
| Electron 被 `SIGKILL` | 子进程组来不及回收；这是已知限制，正常退出与 Ctrl-C 都会回收 |
| 打包分发 | 未实现；当前要求本机有 Node 与 `pnpm install` 后的 `tsx` |

## 6. 验证结果（2026-10-29，macOS 15.6）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（host + ui 两套 tsconfig） |
| `pnpm test` | 710 passed（123 files） |
| `pnpm exec vitest run apps/desktop/tests` | 10 passed |
| CLI 启动 | `[ruobai-harness] ui: http://127.0.0.1:52553`，`SIGTERM` 后正常停止 |
| 外部工作区 | `/tmp/rbu-desk-test` 生成 `.ruobai/`、`.sessions/` |
| Electron 窗口 | CDP 读到 `title: RuoBai Harness`、`readyState: complete`、`#root` 存在，正文已渲染工作区界面 |
| 生产静态 UI | `pnpm build:ui` 后加载 `/assets/index-*.js`，不再启动 Vite 中间件 |
| 工作区切换 | 显式 `--workspace /tmp/rbu-desk-test` 与默认检出目录都写入 `desktop.json`，未把应用目录误当工作区 |
| 退出 | Electron `exit 0`；harness 打印 `SIGTERM: stopped`，未留下本次子进程 |

## 7. 尚未做

- 打包、图标、签名与公证（需要 `electron-builder` / `@electron/packager` 与分发策略）。
- 应用内原生文件夹选择器：目前由菜单重启 harness 实现；UI 内的目录选择仍走浏览器能力。
- 自动更新、通知、协议关联（`ruobai://`）。
- 若未来客户端需要脱离 HTTP（例如远程桌面或权限隔离），再按 dsh 的方式引入 `doFetch` 切面与 IPC 载体；当前不预留空抽象。

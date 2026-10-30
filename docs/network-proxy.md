# 网络代理

## 问题

模型请求、余额查询、技能下载、知识库 embedding、A2A、命令与 git 子进程都是服务端发出的网络流量。本机代理软件（Clash、Surge 等）是否开启取决于当时环境；Node 的全局 `fetch` 默认不读取 `HTTP(S)_PROXY`，所以代理一开，harness 的外发请求就会失败，而用户看不出原因。

## 约束

- Node 22 的 `fetch` 不认环境变量，必须在请求层带 dispatcher。
- 命令与 `git` 子进程读的是环境变量，必须显式注入，且不能把 harness 的密钥带出去。
- 本地服务（UI、MCP、preview）必须始终直连。
- 用户要求配置的是应用级 `HTTP_PROXY / HTTPS_PROXY / NO_PROXY`：默认继承系统值，可覆盖，可恢复；应用级在 harness 内优先于系统级。

## 方案

设置存 `network: { enabled, httpProxy?, httpsProxy?, noProxy? }`：

- `enabled` 关闭时完全不注入代理。
- 三个字段留空即继承系统值；填写后覆盖对应变量。
- 「恢复系统默认」清空三个字段，继续继承。
- 系统值来源：macOS `scutil --proxy`（`HTTP*` / `HTTPS*`），其他平台读 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`。缓存 15 秒。

解析顺序（每个变量独立）：应用值 → 系统值 → 内置默认（`NO_PROXY` 默认 `localhost,127.0.0.1,::1,.local`）。`HTTPS_PROXY` 缺省时回退到 `HTTP_PROXY`。

`@ruobai/net` 提供 `ctx.net`：

- `status()`：开关、应用覆盖、检测到的系统值、当前生效值、错误。
- `fetch()`：全局 `fetch` 的替代品。按目标协议选 HTTP/HTTPS 代理；有代理且目标不是本地地址时用 undici `ProxyAgent`，否则直连。
- `subprocessEnv()`：`HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY`（大小写各一份），注入命令与 git 子进程。
- `check(url)`：用当前设置请求一次，返回耗时、状态码、是否经代理。

接口：`GET /api/network`（`?refresh=1` 强制重检）、`POST /api/network/test`；写入走 `PATCH /api/settings` 的 `network` 字段。

接入点：

- HTTP：模型（`llm-catalog` → `llm-openai`）、余额、模型列表、技能下载、知识库 embedding、A2A。
- 子进程：`shell-direct`、`git`/`gh`。沙箱内命令的出口由沙箱自己的网络策略决定，不在这里注入。

## 失败模式

- 地址非法（SOCKS、空主机）：`status()` 返回错误并展示；请求退回直连但界面标红。
- 开关打开但系统没代理、应用也没填：明确提示「没有可用的代理地址」。
- 端口写错：请求失败，错误来自 undici（`ECONNREFUSED` 等），测试按钮原样展示。
- 本地地址：`localhost`、`127.0.0.1`、`::1`、`*.local` 固定直连。
- 沙箱命令：不经过这套代理注入，按沙箱自身的网络策略执行。

## 验证

- `packages/net/tests/net.spec.ts`：地址归一化、`NO_PROXY` 归一化、子进程变量。
- `packages/shell-direct/tests/proxy-env.spec.ts`：命令实际读到 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`；关闭时不注入。
- 手动填不可用端口，确认 `/api/network/test` 失败且 `viaProxy: true`；关闭后恢复直连。
- 设置页「网络」页签在 CC / DeepSeek × 明 / 暗下检查布局。

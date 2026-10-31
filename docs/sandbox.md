# 沙箱：从"处处审批"改成"边界即授权"

状态：已实现（2026-10-31）。旧的路径级 escalation 模型已从应用组合中移除；
Seatbelt 的机制细节与实测数据仍见 `docs/sandbox-macos.md` 与附录 F。

## 为什么要改

旧模型把沙箱当成审批之前的一道额外关卡：

- 每条 `bash` 都要审批，哪怕它只是在工作区里跑 `ls`；
- 沙箱拒绝后，只有文件类的拒绝能通过 escalation 逐路径放宽；**网络拒绝永不放宽**，所以 `pnpm install`、`curl` 这类命令一旦被拦就是死路；
- cordis.yml 里只能写 `*:443` 这种端口白名单，因为 Seatbelt 不接受域名；
- `full-access` 模式仍然写不进工作区外、连不上网，用户感知是"权限开了但什么都没变"。

结果就是用户直接关掉沙箱。新模型参照 Claude Code：**留在沙箱内的命令本身就是安全决策，不再叠加审批；只有越过边界才需要人批准。**

## 新模型

1. **沙箱内自动放行。** `sandbox.autoAllowBashIfSandboxed`（默认开）让预计在沙箱内执行的 `bash` 直接通过审批层。内置危险命令规则、显式 ask/deny 规则仍优先生效。
2. **网络走域名白名单代理。** 进程只被允许连本机回环上的沙箱代理；代理按域名放行，HTTPS 用 CONNECT 隧道（只按域名过滤，不解密）。默认放行 npm/PyPI/GitHub/Go/Crates 等构建必需的域名，列表在设置里可增删。
3. **越过沙箱要审批。** 两种方式：
   - 模型在 `bash` 里传 `dangerouslyDisableSandbox: true`（用户批准后执行一次）；
   - 命令在 `sandbox.excludedCommands` 中（默认 `docker`、`podman`），始终直连，但仍需审批。
4. **本地开发是显式能力。** `network.allowLocalBinding`（默认开）允许监听/连接 localhost；否则 vite、vitest、回调服务都跑不起来。
5. **策略在设置里，热生效。** 域名、排除命令、额外可写目录、三个开关都走 `settings.sandbox`；`sandbox-policy` 订阅 `settings/updated` 并 bump policy version，编译缓存随之失效，不需要重启。
6. **不再有路径级 escalation。** 被拒绝时模型收到结构化说明与两条出路：调整沙箱设置，或在用户批准后不经沙箱重跑。`@ruobai/sandbox-escalation` 包保留给测试/嵌入式场景，但应用不再挂载。

## 组成

| 包 | 职责 |
| --- | --- |
| `@ruobai/sandbox` | 平台无关 IR、默认域名与排除命令、命令可执行文件解析 |
| `@ruobai/sandbox-policy` | 从设置生成每会话策略快照（写目录、域名代理、本地回环） |
| `@ruobai/sandbox-proxy` | 本机 HTTP/HTTPS CONNECT 代理，按域名白名单过滤，可串联系统代理 |
| `@ruobai/sandbox-macos` | SBPL 编译与 `sandbox-exec` 执行 |
| `@ruobai/shell-sandboxed` | 默认执行器：沙箱/直连的选择、代理环境、拒绝说明 |
| `@ruobai/permissions` | 沙箱内 bash 的免审批判定 |
| `@ruobai/sandbox-web` | 状态与策略读写 API、设置面板 |

数据流：

```
tool-bash ──> approval ──(sandboxed? auto allow)──> ctx.shell
                                                      │
                                   shell-sandboxed ──┼─> sandbox-policy (settings)
                                                      │        │
                                                      │        └─> proxyPort / domains
                                                      ├─> sandbox-proxy (env: HTTP(S)_PROXY)
                                                      └─> sandbox-exec (Seatbelt)
```

## 设置

```jsonc
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": true,
    "excludedCommands": ["docker", "podman"],
    "network": {
      "allowedDomains": ["registry.npmjs.org", "github.com", "*.example.com"],
      "allowLocalBinding": true
    },
    "filesystem": {
      "allowWrite": ["~/.cache/uv"]
    }
  }
}
```

- 默认域名见 `packages/sandbox/src/types.ts` 的 `DEFAULT_ALLOWED_DOMAINS`；清空列表等于完全断网。
- `*.example.com` 只匹配子域，不匹配 `example.com` 本身；`host:port` 可限定端口。
- 设置文件本身被 `harness-state` 守卫禁止写入，模型无法自己放宽策略。

## 失败模式

| 现象 | 行为 |
| --- | --- |
| 代理未挂载 | policy 退回 `deny`，不会生成"只允许一个不存在的端口"的半残策略 |
| 域名不在列表 | 代理返回 403，命令输出里带域名与修改入口；内核层没有额外拒绝需要归因 |
| 上游系统代理不可用 | 代理返回 502；沙箱内命令失败，但不会静默绕过白名单 |
| 程序无视 `HTTP(S)_PROXY` | 内核只放行代理端口，连接被拒；这是预期，需改用支持的客户端或申请不经沙箱 |
| 容器类命令 | 默认在 `excludedCommands`，直连 + 审批 |
| `sandbox-exec` 嵌套 | provider 自检失败，命令 fail-closed；不会退回无隔离执行 |
| 用户关掉沙箱 | 直连执行，审批规则仍在；关闭需要一次确认 |

## 实测（macOS 26.6.2）

用真实 `sandbox-exec` + 真代理跑：

- `curl https://registry.npmjs.org/`（在允许列表）→ HTTP 200，1725ms。
- `curl https://example.com/`（不在列表）→ curl exit 56（CONNECT 被 403），命令未发出。
- `curl http://127.0.0.1:<port>/`（本地回环）→ 200，说明 `allowLocalBinding` 生效。
- 沙箱内 `node` 监听 127.0.0.1 → 成功。
- `bash` + `dangerouslyDisableSandbox` → 直连执行并带 `[sandbox] 按请求未经沙箱执行` 标记。

同步的 Seatbelt 结论：

- `(remote ip "127.0.0.1:<port>")` 会让整份 profile exit 65；必须写 `localhost:<port>`。
- `localhost:*` 可用于 outbound、`network-bind`、`network-inbound`。

## 与 Claude Code 的差异

- 只实现 macOS Seatbelt；Linux 仍无后端（fail-closed）。
- 代理只做域名过滤，不做 TLS 解密、路径/方法规则或流量审计。
- 不提供 unix socket 白名单；需要时走 `excludedCommands`。
- 没有"工作区信任对话框"；设置页的一次关闭确认是唯一的全局降级点。

## 旧模型迁移

- `sandbox-policy` 的静态 `network.allow` 只在没有 settings 服务的测试/嵌入式场景生效；应用中由用户域名列表取代。
- `shell-sandboxed.escalate` 配置已移除；旧 cordis.yml 中的 `sandbox-escalation` 行已删除。
- `sandbox-web` 的会话级 escalation 开关与授权撤销随服务移除，面板改为策略编辑。

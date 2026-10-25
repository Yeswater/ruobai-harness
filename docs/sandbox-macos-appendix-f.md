
## 附录 F：重启后真实回归（沙箱承载自己的 shell 时暴露的缺陷）

把 `cordis.yml` 切到 `shell-sandboxed` 之后，**harness 自己的 bash 工具就变成了被测对象**。第一批命令就打出若干在单元/集成测试里测不到的缺陷——因为之前的测试只覆盖了「单命令 exec 成功」这一种形态。

### F.1 缺陷清单与修复

| # | 实测输出 | 根因 | 影响 | 修复 |
|---|---|---|---|---|
| **A18** | `/bin/sh: fork: Operation not permitted`（exit 128）；`git status`、`a \| b`、`a && b` 全失败 | `(deny default)` 下只 allow 了 `process-exec*`，**没有 `process-fork`**。`sh -c 'cmd'` 可靠 exec 优化免 fork，所以 `echo hi` 一直"通过"，掩盖了问题 | 任何真实工具链（git、npm、node 起 helper、管道、子 shell）**全部不可用** | `(allow process-fork)` + `processFork` 配置（默认 allow） |
| **A19** | 每条命令都附带 `fs-write-outside /dev/dtracehelper`，进而**触发升级**并批准 `write-root:/dev` | ① dyld/libSystem 每次 exec 都写 `/dev/dtracehelper`，被记为 denial；② 判断条件用 `denials.length` 而非退出码，成功的命令也升级；③ `fs-write-outside` 豁免取 `dirname(target)`，单文件放大成整个 `/dev` | ① 退化成"每步弹窗"——正是本设计要删除的行为；② **把 `/dev` 整目录变成可写**，安全倒退；③ 放宽后命令仍失败，用户被要求批准一个无效的放宽 | ① 基线 allow `/dev/dtracehelper`；② `classify()` 噪音过滤（`sysctl-read`/`file-read-metadata`/`process-info*`/`mach-lookup`/`/dev/*` 写）；③ 退出码 0 时**只附诊断、不升级**；④ 豁免改 `write-file`（`literal` 单文件）+ `NON_RELAXABLE_PREFIXES` 黑名单 |
| **A20** | `npx: /usr/bin/env: bad interpreter: Operation not permitted` | nvm 装的 `node`/`npm`/`npx` 在 `~/.nvm/versions/node/<v>/bin`，且 `npx` 是符号链接到 `../lib/node_modules/npm/bin/npx-cli.js` —— **shebang 脚本自身也需要 exec 权限** | 沙箱内跑不了任何 node 工具链（`npx vitest`、`npm test`），等于切断 harness 自己的验证通道 | 编译时把 `dirname(process.execPath)` **与其上一级**（node 安装根）加入 exec 白名单 |
| **A21** | 已在 Seatbelt 内再调 `sandbox-exec` → `sandbox-exec: sandbox_apply: Operation not permitted`（**exit 71**） | **Seatbelt 不能嵌套** | 用 `bin/rbu-jail` 启动 harness 时每次执行都失败 | 检测 `exit 71 + sandbox_apply` → 抛 `NestedSandboxError`；self-check 命中即把 provider 标为不可用（fail-closed） |
| **A22** | `git`: `unable to load libxcrun … file system sandbox blocked open()` | `/usr/bin/git` 是 **xcrun shim**，要 dlopen developer 目录的 `libxcrun.dylib`；读白名单没有 Xcode / CommandLineTools | `git` 完全不可用，连带所有 xcrun 包装工具 | `TOOLCHAIN_READ`（Xcode Developer / CommandLineTools 只读）+ `TOOLCHAIN_EXEC`（只放 `usr/bin`），按 `existsSync` 过滤 |
| **A23** | `git`（`/usr/local/bin/git`）`Operation not permitted` | `/usr/local/bin/git -> /usr/local/git/bin/git`。Seatbelt 按 **realpath 后的 vnode** 判定（同 A16），所以 grant `/usr/local/bin` 对目标无效；且其 dylib 在 `/usr/local/git/lib*`，读白名单也没有 | `git` 仍不可用 | `expandExecDirs()`：扫 PATH 目录里每个符号链接，把**目标所在目录**加入 exec 白名单；`BASELINE_READ` 补 `/usr/local`、`/opt/homebrew` |
| **A24** | `vitest` 启动即 `Error: spawn EPERM`（esbuild 服务进程） | esbuild 的 native binary 在 pnpm 的 `.pnpm` 存储里，既不在 PATH 也不在任何白名单；`node_modules/.bin` 同理 | 测试/构建工具全部不可用 | **架构修正**：`可写 ⟹ 可执行`。`compileProfile` 把 `policy.fs.write` 的 grant 一并加入 exec 白名单 |
| **A25** | 沙箱内跑 `vitest`：`Serialized Error: { errno: -1, code: 'EPERM', syscall: 'kill' }`，worker 收不到终止信号 | `(deny default)` 下没有 `signal` 授权。`(target self)` 和 `(target others)` 实测都**不能**给自己的子进程发信号，只有 `(target children)` 可以 | 任何需要回收自己子进程的工具（测试 runner、超时 supervisor、构建工具）在沙箱内失败；命令本身却返回 0，表现为"测试莫名中断" | 基线加 `(allow signal (target children))`——作用域仅限**自己的子进程**，不能给 harness、审批进程或其他会话发信号 |
| **A26** | 挂上 `sandbox-native-log` 后，每条命令都附 `unknown path:/dev/dtracehelper ioctl-command:(_IO "h" 4)` | dyld 启动时对 `/dev/dtracehelper` 发的是 **ioctl**，不是 read/write；只 allow `file-read*`/`file-write*` 时该操作仍被拒 | A19 的噪音反馈以新形态复发：成功命令也带 `[sandbox]` 诊断 | 基线加 `(allow file-ioctl (literal "/dev/dtracehelper"))`（`ioctl` 不是合法 SBPL 操作名，实测报 `unbound variable`） |
| **A27** | `npx --version` 成功但附带 `unknown kcfpreferencesanyapplication` | `npx`/node 启动时读**全局**偏好域（`user-preference-read kcfpreferencesanyapplication`）。实测 `(literal ...)`、`(preference-domain ...)`、`(subpath ...)` 三种过滤器都**匹配不上**，放行不了 | 每个 npm 入口都带一条假「沙箱拒绝」诊断 | 不做放行（偏好读取继续被拒）。在 `sandbox-denial.isNoise()` 里只把**全局域**的 `user-preference-read` 当启动探测过滤；`com.apple.*` 等应用域仍算真实拒绝（应用偏好可能含 token） |

A24 是**架构层面的判断错误**，不是又一个补丁。A20→A22→A23→A24 逐个打补丁的模式说明：在 node 生态里枚举 exec 白名单不可维护。正确的不变式是——

> **可写 ⟹ 可执行。** agent 能写的目录里本来就能放脚本，拒绝 exec 只会挡住工具链，挡不住 `sh dropped.sh` / `node -e`。真正的硬边界是 `deniedExecutables`（`security`、`osascript`、`sudo`、`launchctl`、`crontab`、`setsid`、`nohup`）+ 文件写授权。

同理补上 **可写 ⟹ 可读**：写在 `TMPDIR` 的文件必须能读回。同时用 `dedupeGrants()` 保证 read/write 重叠时不产生重复语句。

另补两条平台必需读取（不是噪音，被拒会让工具行为异常）：`/private/var/db/timezone`（`date`、locale、几乎所有运行时启动都读）、`/Library/Preferences/Logging`（`com.apple.diagnosticd.filter.plist`）。

### F.2 环境变量泄漏

`sandbox-macos` 的 `spawn` 原来用 `env: spec.env ?? process.env`。Seatbelt 完全不管 `env`，所以 `echo $RBU_TOKEN` 会原样打印 harness 自己的 token——**沙箱拦不住的泄漏**。

修复：

- `@ruobai/shell` 导出 `SECRET_ENV` / `scrubbedEnv()`（`shell-direct` 与 `shell-sandboxed` 共用一份清单）；
- `shell-sandboxed` 显式传 `env: scrubbedEnv()`；
- provider 在调用方**没传** env 时用 `minimalEnv()`（最小 PATH + HOME + TMPDIR + LANG），**不再继承 `process.env`**。fail-safe 默认：忘记传也不会泄漏。

实测：`echo "token=[$RBU_TOKEN]"` → `token=[]`。

### F.3 静默失败：退出码 0 时不能吞掉拒绝

A19 的修复最初写成 `if (!denials.length || exitCode === 0) return base`，结果是 `git status | head -5`（git 失败、head 成功）**什么都不显示**——模型会把它读成成功。

最终语义拆成两种：

| 情形 | 行为 |
|---|---|
| 有 denial 且退出码 ≠ 0 | **升级审批**，返回 `renderDenials()`（含"请勿重试"） |
| 有 denial 但退出码 = 0 | **不升级**，返回 `renderDenialNotice()`：「命令成功，但其中有操作被拒绝：…（未升级审批）」 |
| 无 denial | 原样返回（噪音已被过滤，`echo clean` 属于此类） |

### F.4 tool-fs 的进程内守卫（设计 §2.6 第三层，此前遗漏）

Seatbelt 只看得到子进程，`tool-fs` 全部运行在宿主进程内。之前未接 `ctx.sandboxPolicy.check()`，意味着 `.git`、`.ssh`、`.env` 守卫**只对 bash 生效**，`write_file`/`read_file` 可直接绕过。

现已接上：

- `read_file` → `check(target, 'read')`；`write_file` / `edit_file` → `check(target, 'write')`；
- 守卫查询是**惰性**的（每次 execute 时 `ctx.get('sandboxPolicy')`），因此支持热插拔：沙箱卸载后立即停止守卫，不需要重启；
- 没有挂沙箱时（`tests/harness.ts`）行为不变；
- 抛 `PathGuardError`，错误信息含 guard id 与 reason，模型能看懂。

### F.5 修复后的判据（已加入测试）

| 判据 | 测试位置 |
|---|---|
| `echo one \| tr a-z A-Z`、`echo a && echo b`、`git status --porcelain` 成功 | `seatbelt.spec.ts` → `toolchain and environment` |
| `echo clean` 成功时**不触发审批**，输出不含 `[sandbox]` | 同上 |
| `$RBU_TOKEN` 在沙箱内为空 | 同上 |
| 放宽只针对**单个文件**（`write-file`），不放大到目录 | `sandbox-escalation/tests/escalation.spec.ts` |
| `/dev`、`/etc`、`/System`、`/usr`、`/Library` 下**永不放宽** | 同上 |
| profile 含 `(allow process-fork)`、`(allow signal (target children))`、`(allow file-ioctl (literal "/dev/dtracehelper"))` | `sandbox-macos/tests/compile.spec.ts` |
| **可写路径可执行 / 可写路径可读 / 无重复 grant** | 同上 |
| 噪音不产生 denial（含全局偏好域探测）；应用偏好域仍算真拒绝；真拒绝与噪音并存时只报真拒绝 | `sandbox-denial/tests/denial.spec.ts` |
| `write_file`/`read_file`/`edit_file` 撞守卫被拒；守卫 disposer 后立即失效；无沙箱行为不变 | `tool-fs/tests/guards.spec.ts` |

### F.6 教训（已并入 M1 验收标准）

1. **"单命令成功"不是沙箱可用的证明。** 至少要跑一条 `a | b`、一条 `a && b`、一条真实工具链命令（`git status`、`npm test`）。
2. **升级判断看退出码，不看"有没有 denial 记录"。** 任何 `(deny default)` profile 在每个进程启动时都产生拒绝日志。
3. **豁免单位必须与拒绝单位一致。** 拒绝发生在文件上，豁免就必须是文件；`dirname()` 会把"一个文件"放大成"一个目录"。
4. **不要用枚举式白名单约束 node 生态。** 用「可写 ⟹ 可执行 / 可读」这类不变式；把真正的边界放在 deny 列表和写授权上。
5. **沙箱不能嵌套**，进程级 jail 与 per-exec 沙箱是互斥的两种部署形态。
6. **内核不管 `env`**，任何"继承父进程环境"的默认值都是不受约束的泄漏通道。

### F.7 自我阻塞（必须记录的运维事实）

发现 A18–A24 期间，**agent 自己的 shell 就在这个坏 profile 里**：

- 不能 `npx`（A20）、不能 `git status`（A22/A23）、不能跑 `vitest`（A24）；
- 连 `cmd > file` 都失败（重定向要 fork，A18），无法用 shell 合并文档；
- 无法嵌套 `sandbox-exec` 验证新 profile（A21）。

可行通道只剩**直接调用 node**：`node ./node_modules/typescript/bin/tsc -p tsconfig.json`（`node` 在 `.../bin`，旧 profile 已放行）。以此完成 typecheck；测试则必须等修复后的 profile 生效。

结论：

1. 改沙箱代码期间必须保留 `@ruobai/shell-direct` 作为逃生舱（`cordis.yml` 一行切换）；
2. 验证必须**双通道**：一条走沙箱（验证隔离），一条不走沙箱（验证编译/工具链）；
3. 每次改 profile 必须重启才能验证 → M1 起把「重启 → 跑 5 条真命令」做成固定回归脚本。

### F.8 第二轮修复后的完整回归（2026-10-26）

上一轮结束时仍有 10 个失败用例（`tsc` 已过，测试因 profile 未生效而无法跑）。这一轮逐条定位：

| 失败 | 根因 | 修复 |
|---|---|---|
| `sandbox-escalation` 7 例全部 `escalation` 为 `undefined` | `EscalationService.inject` 含 `denial`，测试只挂了 `approval` + `policy`，fiber 停在 PENDING | 测试 setup 挂载 `DenialService` |
| `compileProfile > grants read wherever it grants write` | 测试取的是**第一条** `(allow file-read*`，而基线先输出 `(literal "/")` | 断言改为合并全部 read-allow 行 |
| 真实 `git status --porcelain` exit 126 | `SYSTEM_EXEC_DIRS` 误把 `/usr/local/bin`、`/opt/homebrew/bin` 当作"OS 自带目录"跳过展开——而这两个目录恰恰全是符号链接（A23 的修复被自己的跳过表抵消了） | 跳过表只保留 `/usr/bin`、`/bin`、`/usr/sbin`、`/sbin` |
| `git status` 在临时目录 exit 128 | 测试把临时目录当仓库用；`git` 已能执行，但那里没有 `.git` | 改为 `git --version`（同样验证 symlink→realpath 的 exec 授权） |
| tool-fs 热卸载测试 `ctx.tools` 为 `undefined` | `Service.ctx` 是**根 Context**，`policy.ctx.fiber` 是根 fiber；dispose 它等于卸载整个 harness | 测试改用 `ctx.plugin()` 返回的插件 fiber |

补充三项实测缺陷 A25–A27（见 F.1），随后验证：

- `tsc -p tsconfig.json`：0 错误；
- 全量 `vitest run`：**69 个文件 / 402 个用例全绿**；
- 真实 Seatbelt 内（根 = 仓库）：
  - `echo one | tr a-z A-Z` → `ONE`，`echo a && echo b` → `a b`；
  - `git status --porcelain` → 正常输出；
  - `npx --version` → `10.9.8`，`npx tsc --noEmit` → 通过，`npm test` → 19 passed，**均无 denial、无审批**；
  - `node ./node_modules/typescript/bin/tsc --noEmit` → 通过；
  - `node ./node_modules/vitest/vitest.mjs run packages/sandbox-macos` → **19 passed**（A24/A25 修复前分别卡在 esbuild EPERM 与 kill EPERM）；
  - `echo "token=[$RBU_TOKEN]"` → `token=[]`；
  - `echo clean` → **0 denial、0 审批**；
  - `cat ~/.ssh/id_ed25519` → `fs-read-guarded`（guard `ssh-keys`）；`.git/config` 写入 → `fs-write-guarded`（guard `git-dir`，native-log/high）；
  - `curl 127.0.0.1:4310` → exit 7，`network-outbound`，仅诊断、不升级。

**结论：M1 的沙箱组合在真实 Seatbelt 下可用，工具链（git / tsc / vitest / npx）不再被沙箱切断。**

### F.8 A28：网络过滤器只接受 `*` / `localhost`（A26 的“解析成 IP”修法本身不可用）

重启后 registry 仍不可达。原判断是“域名规则永不匹配”，实测比这更严重——以下四种写法**都会让 `sandbox-exec` 在应用 profile 时直接拒绝**：

```
(remote ip "registry.npmmirror.com:443")
(remote ip "122.190.12.50:443")
(remote ip "127.0.0.1:443")
(remote tcp "122.190.12.50:443")
```

```
sandbox-exec: host must be * or localhost in network address
/dev/fd/3:160:26: (remote ip "122.190.12.50:443")     # exit 65
```

也就是说，把域名解析成 A 记录不仅没有修好，反而让**每一条命令都起不来**。只有 `*` 和 `localhost` 能被接受：

| 规则 | 结果 |
|---|---|
| `(remote ip "*:443")` / `(remote tcp "*:443")` | ✅ 应用成功；`curl https://…` 通，`:80` 被拒 |
| `(remote ip "localhost:443")` | ✅ 应用成功 |
| 任意域名 / 任意 IP | ❌ `host must be * or localhost`，exit 65 |

另外，**沙箱内的 DNS 是独立的一次 `network-outbound`**：解析走 `/private/var/run/mDNSResponder` 这个 unix socket。只放行 `*:443` 时 `curl https://example.com` 仍然 exit 6（无法解析）；补上

```
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
```

后才返回 200。

修复：

1. 删除 `resolveNetRules()` / `dns.resolve4`（它解决的是不存在的“匹配”问题）；
2. `compileProfile` 只接受 `*` 与 `localhost`；其余条目产出 warning 并**跳过**（fail-closed、但 profile 仍可运行），全部被跳过时显式 `(deny network*)`；
3. 只要有任意 TCP 规则生效，就同时放行 mDNSResponder 的 unix socket，否则域名解析必然失败；
4. `cordis.yml` 用 `host: '*'` + `port: 443`：这是这台 macOS 上**能表达的最窄授权**（按端口而非按主机）。注释里写明原因，依赖装完后改回 `deny`。

验证（真实 Seatbelt）：

- `curl https://example.com/` → `200`，exit 0；
- `curl http://example.com/` → exit 7，`network-outbound` 拒绝（端口 80 未被授权）；
- `echo clean` → 0 denial；
- `compile.spec.ts` 24 例覆盖：域名/IP 被跳过并告警、`*`/`localhost` 生效、mDNS socket 随之生成。

教训：**先测“这条规则能不能被这台 OS 应用”，再谈它匹配什么。** 一个自检只跑 `echo` 的 sandbox，无法发现网络规则会让整份 profile 失效。

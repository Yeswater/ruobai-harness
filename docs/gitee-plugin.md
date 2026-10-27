# Gitee 插件

## 问题

harness 没有任何代码托管平台集成。发布到 Gitee 需要建库、配置 remote、推送与 Release，而 Gitee 不支持 push 时自动建库；把这一串动作留在临时脚本里，既不可审计也不可复用。

## 范围

- 设置页：私人令牌、默认 owner、API 地址、默认可见性、测试连接。
- 仓库：只读浏览仓库、分支、提交、文件、Release。
- 发布：建库 → 配置 remote → 推送分支 → 可选 tag/Release；面板先预览计划再执行。
- Issue：列表/详情/创建/评论/关闭。
- PR：列表/详情/创建/评论。

浏览器侧：设置 → 这台电脑 → Gitee；顶部 Gitee 按钮打开右侧抽屉，含仓库浏览、发布、Issue、PR。

## 包与职责

- `packages/gitee`（`@ruobai/gitee`）：`GiteeService`（`ctx.gitee`）、OpenAPI 客户端、工具、发布编排。
- `packages/gitee-web`（`@ruobai/gitee-web`）：`/api/gitee/*` 路由；`client/index.jsx` 注册 `settings.gitee` 与 `header.actions`。
- `packages/settings`：`gitee` 段，token 只写。
- `packages/git`：`remotes` / `addRemote` / `push(options)` / `createTag` / `pushTag`，发布复用宿主侧 git。
- `packages/ui-app`：`SettingsDialog` 增加 Gitee 页签并渲染 `settings.gitee` Slot。
- `packages/mode-ask`、`packages/mode-plan`：只读 Gitee 工具加入 allowlist。

## 工具

| 工具 | 权限 | actions |
| --- | --- | --- |
| `gitee_repo` | 读 | list / get / branches / commits / file / releases |
| `gitee_issue` | 读 | list / get |
| `gitee_pr` | 读 | list / get |
| `gitee_issue_write` | 审批 | create / comment / close |
| `gitee_pull_write` | 审批 | create / comment |
| `gitee_release` | 审批 | 为已有 tag 创建 Release |
| `gitee_publish` | 审批 | 建库 / 推送 / tag / Release |

写工具没有 `approvalSubject`（现有 subject 只有 command/path），因此每次写操作都会弹审批；`gitee_publish` 的预览会先跑一遍无副作用的计划。

## 发布流程

1. 预检（`/api/gitee/publish/preview` 或工具 preview）：账号、仓库是否存在、本地分支/HEAD/脏文件、remote 与 tag。
2. 仓库不存在时建空库：个人 `POST /user/repos`，组织 `POST /orgs/{org}/repos`，`auto_init:false`。
3. remote 名称默认 `gitee`，URL 由 `remoteTemplate` 生成，默认 `git@gitee.com:{owner}/{repo}.git`；已存在且地址不同则报 409，不覆盖。
4. `push -u gitee <branch>`（宿主侧 `ctx.git`，`networkTimeoutMs` 控制超时）。
5. 可选 tag：创建并推送。
6. 可选 Release：`POST /repos/{owner}/{repo}/releases`。

重复发布是幂等的：仓库/remote 相同则跳过，已有 tag 视为已创建；部分失败会返回已完成步骤，便于重试。

## 令牌与密钥

- token 存在 `.ruobai/settings.json`（已 gitignore），与 provider/MCP 一致；支持 `GITEE_TOKEN` 覆盖。
- `get()`/`publicGitee()` 只返回 `hasToken`，不返回 token。
- 请求只通过 `Authorization: token …` 发送；不放进 URL、argv、日志或错误消息。
- 错误消息在返回前把 token 替换为 `***`。
- API 地址必须 http(s)，拒绝 userinfo；默认拒绝私网地址，测试通过 `allowPrivateHost` 打开。

## 网络与沙箱

Gitee API 请求和 `git push` 都由宿主插件发起，和 MCP/A2A 一样绕过 Seatbelt；agent 的 shell/工作区工具仍受沙箱约束。这是有意的边界：插件是网络出口，工具是工作区边界。`cordis.yml` 中已注明。

## 失败模式

- 401：token 缺失或失效；设置页提示配置。
- 403：令牌 scope 不足（projects/issues/pull_requests）或组织权限不足。
- 404：owner/repo 不存在或无权访问。
- 409：`gitee` remote 已指向另一个地址。
- 429：GET 读取 `Retry-After` 后重试一次；写操作不重试。
- 超时/跨域重定向/超大响应：统一 502，不泄露 token。
- 发布部分失败：返回已完成步骤与失败步骤，重试幂等。

## 验证

- `packages/gitee/tests/client.spec.ts`：本地 `node:http` fixture，覆盖 header 鉴权、分页、401/429、超大响应、跨域重定向、文件 base64 与目录。
- `packages/gitee-web/tests/api.spec.ts`：全栈 harness + fixture，覆盖 token 只写、测试连接、仓库/Issue/PR 读取与写入、无令牌 401、工具注册与审批标记。
- `packages/gitee-web/tests/publish.spec.ts`：fixture API + 临时 bare 仓库，覆盖建库/推送/tag/Release、remote 冲突、预览与工作区状态。
- 手动：设置页测试连接 → 抽屉仓库浏览 → 发布预览（不写远端）→ Issue/PR 页面。

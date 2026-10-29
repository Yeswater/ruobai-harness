# 更改面板：提交与按托管平台推送

## 问题

「更改」页能看 diff、能创建 PR，但不能提交；提交说明、提交并推送藏在右侧 Git 面板的更改列表里。于是有两个别扭的地方：

- 看完 diff 想提交，得换到另一个面板，说明框里还要重新找文件范围；
- 「提交并推送」只能推到上游，而仓库同时挂着 GitHub 和 Gitee 两个 remote 时，推到哪里不可选，也看不到哪个平台当前是连通的。

## 方案

### 更改面板里的提交栏

`CommitBar`（`packages/ui-app/src/components/git/CommitBar.tsx`）放在更改列表上方：

| 控件 | 行为 |
| --- | --- |
| 提交说明 | 手动输入；⌘/Ctrl+Enter 提交 |
| 智能提交 | 请求 `/api/git/suggestion`，用会话标题 + 当前改动生成说明（`commit-prompt` 的纯函数，不走模型），写入说明框后立即提交 |
| 提交 | `POST /api/git/commit`，提交范围就是列表里当前显示的改动 |
| 推送到 <平台> | 主按钮推到该平台的匹配 remote；下拉里列出所有已注册平台及其状态、还有一个「上游分支」兜底 |

提交范围同时经过两层过滤：前端用 `@ruobai/commit-prompt/message` 的 `ignoredPath` 去掉 `.env`、`.sessions/`、`.ruobai/`、`dist/` 等（AGENTS §9），服务端 `/commit` 再过滤一次；如果请求的路径全被排除，返回 400 而不是退化成「提交所有已暂存」。

### 可插拔的代码托管注册表

`GitService` 提供注册表：

```ts
ctx.git.registerHost({ id, label, matches(url), status() })
```

- **内置 GitHub**：`gh auth status` 成功即「已连接」，从输出里取账号名；失败显示「未检测到 gh 登录」。
- **Gitee**：`@ruobai/gitee` 在加载时注册自己，`status()` 先看令牌是否配置，再用账号接口确认连通性。
- 没加载的插件不会出现在下拉里；卸载即注销，没有残留。

`GET /api/git/hosts?sessionId=` 返回每个平台的 `configured / account / detail / error`，以及当前仓库里匹配它的 remote（`git remote -v` 按平台正则过滤）。探测有 4 s 上限，已连接的结果缓存 60 s、未连接缓存 5 s——一个慢平台不会拖住整个提交栏。

`POST /api/git/push` 接受 `{ remote }`，平台条目用它的第一个匹配 remote（优先 `origin`）。

### 为什么不在服务端自动推送

智能提交只提交、不推送；推送永远是点击。断网、凭证过期、推错 remote 都是不可逆动作，不能藏在「智能」二字后面。

## 失败模式

- **平台探测超时/失败**：条目禁用并显示原因，其余平台仍可选；主按钮回落到「推送到 上游」。
- **没有匹配 remote**：平台显示「无匹配远程」并禁用——远程仓库地址决定推送到哪，不猜。
- **一个平台插件都没有**：菜单只剩「上游分支」。
- **说明为空**：提交按钮禁用；智能提交没有生成说明时报错，不提交。
- **全部路径被排除**：400 并说明哪些文件不会被提交。
- **面板刚打开**：平台状态未返回前主按钮显示「推送到…」且禁用，避免在未知目标上误推。

## 验证

- `packages/git-web/tests/api.spec.ts`：`/hosts` 返回 GitHub（origin）与 Gitee（gitee remote）各自的匹配 remote；`/suggestion` 按会话标题生成 `fix:` 说明；`/push {remote}` 推到本地裸仓库并能在裸仓库里查到分支。
- 浏览器实测：更改面板显示「智能提交 / 提交 / 推送到 GitHub」，下拉里 GitHub 与 Gitee 均为「已连接 · <账号>」，标题里写着各自的 remote。

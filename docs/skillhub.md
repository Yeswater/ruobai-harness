# SkillHub 技能市场接入

## 问题

技能页原本只列出工作区里已有的 `SKILL.md`。WorkBuddy 的技能页可以直接浏览 SkillHub、按分类与下载量排序、一键安装。harness 要补齐这条路径，同时不能把"下载远程压缩包并解压"变成一个新的任意文件写入面。

## 接口

SkillHub 提供免登录的公开接口（2026-10 实测）：

| 用途 | 地址 |
| --- | --- |
| 列表 / 搜索 | `GET https://api.skillhub.cn/api/skills?page&pageSize&keyword&category&sortBy&order` |
| 分类 | `GET https://api.skillhub.cn/api/v1/categories` |
| 精选 | `GET https://api.skillhub.cn/api/v1/showcase/recommended` |
| 下载 | `GET https://api.skillhub.cn/api/v1/download?slug=<slug>` → 302 到对象存储 zip |

`sortBy` 使用 `score` / `downloads` / `updated_at`。列表响应是 `{ code, data: { skills, total } }`，服务端代理后收窄为 `{ skills, total }`。

## 方案

- **服务端代理**：`skills-web` 新增 `/api/skillhub/*`，浏览器不直接碰第三方域名，避免 CORS，也避免把下载 URL 交给页面。请求有 20 秒超时，失败返回 502。
- **安装**：`POST /api/skillhub/install { slug, sessionId }`。服务端下载 zip，解压到 `<root>/.ruobai/skill-downloads/<uuid>`，读取 `SKILL.md` 的 `name`，校验 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 后移动到 `<root>/.ruobai/skills/<name>`，最后 `ctx.skills.invalidate(root)`。
- **移除**：`DELETE /api/skillhub/installed/<name>?sessionId=`，只删除工作区内的技能目录并失效缓存；全局技能不在此列。
- **UI**：`SkillsPane` 展示精选、分类、排序、SkillHub 卡片网格、已安装列表与待审提案。安装按钮在无会话时禁用；已安装按 slug / namespace / 本地技能名做保守匹配。

## zip 解压的安全边界

安装器不调用系统 `unzip`，而是用 `node:zlib` 读 ZIP 中央目录：

- 拒绝加密条目、ZIP64、非 store/deflate 压缩方法；
- 拒绝绝对路径、盘符路径、含 `..` 的路径与反斜杠穿越；
- 拒绝 symlink 条目（external attributes 的 Unix mode）；
- 压缩包 ≤ 30 MB、条目 ≤ 500、解压总量 ≤ 30 MB，inflate 时带 `maxOutputLength`；
- 只接受有 `SKILL.md` 的包，支持根目录或单一顶层目录两种布局；
- 失败时 `finally` 清理临时目录。

这些规则由 `packages/skills-web/tests/zip.spec.ts` 覆盖（正常嵌套、路径穿越、symlink）。

## 失败模式

- **离线 / 限流**：代理返回 502，技能页显示错误与刷新按钮；已安装技能和提案仍可用。
- **同名 slug 跨 namespace**：下载接口只接受 slug，无法区分 namespace；当前按 SkillHub 返回的第一个下载处理。
- **付费技能**：列表会显示 `labels.pricing_type`，但安装仍请求公开下载地址；是否可用取决于 SkillHub 的返回。
- **名称不合法**：`SKILL.md` 的 name 不满足目录名规则时拒绝安装，不退回 slug。
- **安装后未生效**：缓存已失效；若仍未出现，检查 `.ruobai/skills` 是否为会话工作区而不是进程 cwd。

## 验证

- 真实接口：列表、分类、精选、下载均通过本地 `/api/skillhub/*` 代理。
- 安装实测：`linkding` 包解压出 `SKILL.md`、`README.md`、`scripts/linkding-api.sh`、`_meta.json`，`/api/skills` 立即出现该技能；`DELETE` 后目录与缓存都消失。
- `pnpm test` 的 zip 解析用例覆盖路径穿越与 symlink 拒绝。

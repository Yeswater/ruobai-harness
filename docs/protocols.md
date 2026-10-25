# 协议目录（.ruobai）

harness 会自动读取用户级 `~/.ruobai` 与项目级 `<workspace>/.ruobai`，兼容
AGENTS.md、Agent Skills、MCP 与 A2A 的目录/文件约定。所有内容都是本地只读
输入；除 MCP / A2A 外不会发起网络请求。

## 目录布局

```
~/.ruobai/                       # 用户级，优先级低于项目
  AGENTS.md | agent.md | CLAUDE.md
  AGENTS.local.md | agent.local.md | CLAUDE.local.md
  skills/<name>/SKILL.md         # 也支持 skills/<name>.md
  mcp.json
  a2a.json

<workspace>/.ruobai/             # 项目级，覆盖同名用户级内容
  （同上）

<workspace>/AGENTS.md | agent.md | CLAUDE.md   # 工作区根，最后合并
<workspace>/.mcp.json                          # Claude Code 风格的 MCP 配置
<workspace>/.claude/skills/…                   # 技能兼容目录
<workspace>/.agents/skills/…                   # 技能兼容目录（dsh）
```

注意：本仓库的 `.gitignore` 忽略 `.ruobai/`，因此上面这些项目配置默认只存在于
本机；需要共享时请把它们纳入版本控制或放到团队约定的位置。

## 优先级

- 指令：`~/.ruobai` → 项目 `.ruobai` → 工作区根；同一目录内
  `AGENTS.md` → `agent.md` → `CLAUDE.md`，随后叠加 `.local.md`。更具体的内容
  排在后面；完全相同的正文会去重，保留项目副本。总长度受
  `context.maxInstructions`（默认 16000 字符）限制，超出时优先保留项目文件。
- 技能：项目 `.ruobai/skills` → 项目 `.claude/skills` → 项目 `.agents/skills`
  → 用户 `~/.ruobai/skills` → `~/.claude/skills` → `~/.agents/skills`。
  同名技能以先出现的为准。
- MCP：`<workspace>/.mcp.json` → `<workspace>/.ruobai/mcp.json` →
  `~/.ruobai/mcp.json` → 设置页里的 MCP 服务。同名以文件为准；
  文件里 `disabled: true` 会屏蔽低优先级的同名服务。
- A2A：项目 `.ruobai/a2a.json` 覆盖 `~/.ruobai/a2a.json` 中的同名 agent。

## 指令文件

支持工作区根与两个 `.ruobai` 目录下的 `AGENTS.md`、小写 `agent.md`、
`CLAUDE.md`，以及对应的 `.local.md` 覆盖文件。它们会以
`# Instructions from <路径>` 的形式拼进系统提示。

## 技能（SKILL.md）

```md
---
name: code-review
description: Review a change for correctness and regressions
disable-model-invocation: false   # true = 只允许用户 /code-review
user-invocable: true              # false = 只允许模型 skill 工具
---

正文…
```

- 发现后只把 `name` + `description` 放进 `<available_skills>`；正文通过
  `skill` 工具按需加载（渐进式披露）。
- 模型调用 `skill` 时可以传 `file` 读取技能目录内的附带文件，例如
  `references/guide.md`。
- 在输入框输入 `/` 会列出可用的用户技能；选择后写入字面量 `/name `。
  发送后由宿主把该技能正文注入到这一轮对话（不显示为额外用户气泡）。
- 新增、删除技能会在最多 5 秒后的下一次模型步骤生效；正文始终重新读取。

## MCP 配置文件

支持 Claude 风格与原生数组两种形态：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "TOKEN": "${TOKEN}" },
      "cwd": ".",
      "disabled": false
    }
  }
}
```

```json
{ "servers": [{ "id": "filesystem", "command": "npx", "args": ["-y", "…"] }] }
```

`cwd` 缺省为配置文件所在目录；支持 `~/` 与 `${ENV}` 展开。文件变化会被监听并
重新同步连接；连接仍是全局的（不按会话隔离），项目文件按服务端启动目录解析。

## A2A 远端智能体

```json
{
  "agents": [
    {
      "id": "reviewer",
      "name": "Reviewer",
      "url": "https://agents.example.com/reviewer",
      "headers": { "Authorization": "Bearer ${A2A_TOKEN}" },
      "approval": "always",
      "timeoutMs": 120000,
      "allowPrivateHosts": false,
      "readOnly": false,
      "disabled": false
    }
  ]
}
```

- Card 地址：`url` 以 `.json` 结尾时直接使用，否则依次尝试
  `/.well-known/agent-card.json` 与 `/.well-known/agent.json`。
- 每个远端 agent 注册一个工具 `a2a__<id>`，描述里带上卡片名称、说明和技能列表；
  调用参数为 `message`、可选的 `skill`、`contextId`。
- 调用走 JSON-RPC 2.0：`message/send`（回退 `tasks/send`），任务未完成时轮询
  `tasks/get`，取消时调用 `tasks/cancel`。
- 默认需要审批，默认拒绝 loopback / 私网地址；仅在明确配置
  `allowPrivateHosts: true` 时允许。

## 设置 → 协议

只读页面展示当前加载的指令文件、技能与扫描根、MCP 配置文件以及 A2A agent 状态，
用于排查“为什么没有生效”。技能与 MCP 的运行时状态变化后点“刷新”即可。

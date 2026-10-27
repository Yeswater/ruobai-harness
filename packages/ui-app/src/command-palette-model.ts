import type { SessionSummary } from '@ruobai/chat-protocol'

/** A stateless action offered by the ⌘K palette. */
export interface PaletteCommand {
  id: string
  label: string
  description: string
  /** Extra words that should match without showing up in the label. */
  keywords?: string
  /** Single key rendered next to the row, combined with the platform modifier. */
  shortcut?: string
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
  {
    id: 'new-session',
    label: '新建会话',
    description: '挑一个工作区开始新的会话',
    keywords: 'new session create 工作区 workspace',
    shortcut: 'N',
  },
  {
    id: 'settings',
    label: '打开设置',
    description: '通用 · 模式 · 主题 · 上下文',
    keywords: 'settings preference 偏好 外观 主题 语言',
    shortcut: ',',
  },
  {
    id: 'providers',
    label: '模型与供应商',
    description: '切换模型、配置接口地址与密钥',
    keywords: 'model provider api key 密钥 供应商',
  },
  {
    id: 'connectors',
    label: 'MCP 连接器',
    description: '管理 MCP 服务器与可用工具',
    keywords: 'mcp server tool 工具 连接器',
  },
  {
    id: 'wiki',
    label: '打开知识库',
    description: '项目知识页面、检索、提案与目录',
    keywords: 'wiki knowledge 知识库 资料库 页面 检索',
  },
  {
    id: 'skills',
    label: '打开技能',
    description: '查看技能目录与待审提案',
    keywords: 'skill 技能 命令 提案',
  },
  {
    id: 'experts',
    label: '专家（规划中）',
    description: '把常用工作流固化成可复用的专家',
    keywords: 'expert 专家 角色 工作流',
  },
  {
    id: 'permissions',
    label: '权限与审批',
    description: '审批规则、危险命令与权限模式',
    keywords: 'permission approval guard 审批 安全 规则',
  },
  {
    id: 'show-files',
    label: '打开文件面板',
    description: '浏览工作区文件、预览并引用到对话',
    keywords: 'file tree files 文件 树 浏览 预览 引用',
  },
  {
    id: 'show-git',
    label: '打开 Git 面板',
    description: '查看改动、diff、提交与回退',
    keywords: 'git source control 提交 改动 diff 回退',
  },
  {
    id: 'toggle-sidebar',
    label: '显示 / 隐藏工作区栏',
    description: '收起或展开左侧的会话列表',
    keywords: 'sidebar workspace 侧栏 工作区 会话列表',
    shortcut: 'B',
  },
  {
    id: 'expand-panel',
    label: '展开 / 收起文件面板',
    description: '让文件面板占满窗口',
    keywords: 'expand fullscreen 展开 全屏 面板',
    shortcut: '\\',
  },
  {
    id: 'toggle-theme',
    label: '切换主题',
    description: '在浅色与深色之间切换',
    keywords: 'theme dark light 深色 浅色 外观',
  },
  {
    id: 'stop-turn',
    label: '停止当前回合',
    description: '中断正在生成的回复',
    keywords: 'stop abort cancel 中断 停止 取消',
  },
]

export type PaletteGroupKey = 'sessions' | 'commands'

export interface PaletteEntry {
  /** Namespaced so keys stay unique across groups. */
  id: string
  label: string
  description?: string
  /** Right-aligned hint, e.g. how long ago a session was updated. */
  meta?: string
  shortcut?: string
  sessionId?: string
  commandId?: string
}

export interface PaletteGroup {
  key: PaletteGroupKey
  title: string
  entries: PaletteEntry[]
}

/** Max rows per group, so one source cannot bury the others. */
export const SESSION_LIMIT = 6
export const COMMAND_LIMIT = 5

const SEPARATOR = /[\s/\\:._#>-]/

function tokenize(query: string) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Rank one field against one term. Higher is better, 0 means "no match".
 * Prefix and word-start hits beat hits buried in the middle of a path.
 */
function termScore(text: string, term: string): number {
  const value = text.toLowerCase()
  const index = value.indexOf(term)
  if (index === -1) return 0
  if (value === term) return 120
  const tightness = Math.min(value.length - term.length, 20)
  if (index === 0) return 100 - tightness
  if (SEPARATOR.test(value[index - 1]!)) return 70 - Math.min(index, 20)
  return 40 - Math.min(index, 20)
}

/** Every term must hit some field; the scores are summed so better rows float up. */
function scoreFields(fields: Array<string | undefined>, terms: string[]): number {
  if (!terms.length) return 0
  let total = 0
  for (const term of terms) {
    let best = 0
    for (const field of fields) {
      if (!field) continue
      best = Math.max(best, termScore(field, term))
    }
    if (!best) return 0
    total += best
  }
  return total
}

function basename(path: string) {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

export interface SessionMatch {
  session: SessionSummary
  score: number
}

export function matchSessions(
  sessions: SessionSummary[],
  query: string,
  limit = SESSION_LIMIT,
): SessionSummary[] {
  const terms = tokenize(query)
  const matches: SessionMatch[] = []
  for (const session of sessions) {
    if (session.archived) continue
    const score = scoreFields([
      session.title,
      session.workspace,
      session.workspace ? basename(session.workspace) : undefined,
      session.model,
    ], terms)
    // An empty query lists recent sessions instead of filtering everything out.
    if (terms.length && !score) continue
    matches.push({ session, score })
  }
  matches.sort((a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt)
  return matches.slice(0, limit).map(match => match.session)
}

export function matchCommands(
  commands: PaletteCommand[],
  query: string,
  limit = COMMAND_LIMIT,
): PaletteCommand[] {
  const terms = tokenize(query)
  const matches = commands
    .map((command) => {
      const score = scoreFields([command.label, command.description, command.keywords], terms)
      return { command, score }
    })
    .filter(match => !terms.length || match.score > 0)
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, limit).map(match => match.command)
}

export interface PaletteBuilderOptions {
  sessions: SessionSummary[]
  commands?: PaletteCommand[]
  query?: string
  /** Time formatting is injected so this module stays free of UI imports. */
  formatTime?: (timestamp: number) => string
  sessionLimit?: number
  commandLimit?: number
}

/** The groups the palette renders, in display order. */
export function buildPaletteGroups({
  sessions,
  commands = PALETTE_COMMANDS,
  query = '',
  formatTime,
  sessionLimit = SESSION_LIMIT,
  commandLimit = COMMAND_LIMIT,
}: PaletteBuilderOptions): PaletteGroup[] {
  const groups: PaletteGroup[] = []

  const sessionHits = matchSessions(sessions, query, sessionLimit)
  if (sessionHits.length) {
    groups.push({
      key: 'sessions',
      title: '会话',
      entries: sessionHits.map(session => ({
        id: `session:${session.id}`,
        label: session.title || '未命名会话',
        description: session.workspace ?? '未分组',
        meta: session.streaming ? '运行中' : formatTime?.(session.updatedAt),
        sessionId: session.id,
      })),
    })
  }

  const commandHits = matchCommands(commands, query, commandLimit)
  if (commandHits.length) {
    groups.push({
      key: 'commands',
      title: '命令',
      entries: commandHits.map(command => ({
        id: `command:${command.id}`,
        label: command.label,
        description: command.description,
        shortcut: command.shortcut,
        commandId: command.id,
      })),
    })
  }

  return groups
}

/** Flatten groups in render order so one index drives arrow-key navigation. */
export function flattenEntries(groups: PaletteGroup[]): PaletteEntry[] {
  return groups.flatMap(group => group.entries)
}

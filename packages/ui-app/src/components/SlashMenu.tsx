import type { ReactNode } from 'react'
import {
  BotIcon, FolderPlusIcon, ShieldIcon, SlidersIcon, StopIcon,
} from './Icons.tsx'
import { ComposerMenuList, type ComposerMenuItem } from './ComposerMenuList.tsx'

export interface SlashCommand {
  id: string
  name: string
  description: string
  icon: ReactNode
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'ask', name: 'ask', description: '切换到 Ask 模式（只问答）', icon: <BotIcon size={15} /> },
  { id: 'plan', name: 'plan', description: '切换到 Plan 模式（先规划）', icon: <BotIcon size={15} /> },
  { id: 'agent', name: 'agent', description: '切换到 Agent 模式（执行）', icon: <BotIcon size={15} /> },
  { id: 'goal', name: 'goal', description: '切换到 Goal 模式（自主推进）', icon: <BotIcon size={15} /> },
  { id: 'model', name: 'model', description: '选择本会话的模型', icon: <SlidersIcon size={15} /> },
  { id: 'permission', name: 'permission', description: '切换会话权限模式', icon: <ShieldIcon size={15} /> },
  { id: 'new', name: 'new', description: '新建会话', icon: <FolderPlusIcon size={15} /> },
  { id: 'stop', name: 'stop', description: '停止当前回合', icon: <StopIcon size={14} /> },
]

export function filterSlashCommands(query: string) {
  const term = query.trim().toLowerCase()
  if (!term) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter(command =>
    command.name.startsWith(term)
    || command.name.includes(term)
    || command.description.toLowerCase().includes(term))
}

export function SlashMenu({
  query, activeIndex, onPick,
}: {
  query: string
  activeIndex: number
  onPick: (id: string) => void
}) {
  const items: ComposerMenuItem[] = filterSlashCommands(query).map(command => ({
    id: command.id,
    label: `/${command.name}`,
    description: command.description,
    icon: command.icon,
  }))
  return (
    <ComposerMenuList
      title="斜线命令"
      items={items}
      activeIndex={activeIndex}
      empty="没有匹配的命令"
      onPick={onPick}
    />
  )
}

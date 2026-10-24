import type { WorkspaceMatch } from '../api.ts'
import { ComposerMenuList } from './ComposerMenuList.tsx'
import { FileTextIcon, FolderIcon } from './Icons.tsx'

interface MentionMenuProps {
  query: string
  items: WorkspaceMatch[]
  loading: boolean
  activeIndex: number
  onPick: (path: string) => void
}

export function MentionMenu({ query, items, loading, activeIndex, onPick }: MentionMenuProps) {
  return (
    <ComposerMenuList
      title={query ? '文件与文件夹' : '工作区'}
      items={items.map(item => ({
        id: item.path,
        label: item.type === 'directory' ? `${item.name}/` : item.name,
        description: item.path,
        icon: item.type === 'directory' ? <FolderIcon size={15} /> : <FileTextIcon size={15} />,
      }))}
      activeIndex={activeIndex}
      empty={loading ? '正在搜索…' : '没有匹配的文件'}
      onPick={onPick}
    />
  )
}

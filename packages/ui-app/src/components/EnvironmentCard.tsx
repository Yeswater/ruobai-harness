import type { GitInfo } from '../api.ts'
import { BranchIcon, FolderIcon, MonitorIcon } from './Icons.tsx'

interface EnvironmentCardProps {
  git: GitInfo | null
  workspace?: string
}

function shortPath(path: string, home?: string) {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function parentOf(path: string) {
  const trimmed = path.replace(/[/\\]+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

function nameOf(path: string) {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path
}

export function EnvironmentCard({ git, workspace }: EnvironmentCardProps) {
  const root = git?.workspace ?? workspace
  const branch = git
    ? git.available && git.branch ? git.branch : '非 Git 仓库'
    : '…'

  return (
    <div className="env-rows">
      <div className="env-row">
        <span className="env-icon"><MonitorIcon size={15} /></span>
        <span className="env-label">这台电脑</span>
        <span className="env-muted env-end">本地</span>
      </div>
      {root
        ? (
          <div className="env-row" title={root}>
            <span className="env-icon"><FolderIcon size={15} /></span>
            <span className="env-label">{nameOf(root)}</span>
            <span className="env-muted">· {shortPath(parentOf(root), git?.home)}</span>
          </div>
        )
        : (
          <div className="env-row">
            <span className="env-icon"><FolderIcon size={15} /></span>
            <span className="env-muted">未选择工作区</span>
          </div>
        )}
      <div className="env-row">
        <span className="env-icon"><BranchIcon size={15} /></span>
        <span className="env-label">{branch}</span>
      </div>
    </div>
  )
}

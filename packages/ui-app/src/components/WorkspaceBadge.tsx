import { useEffect, useState } from 'react'
import { api, type GitInfo } from '../api.ts'
import { BranchIcon, FolderIcon } from './Icons.tsx'

const REFRESH_MS = 15_000

function shortName(path: string) {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path
}

/** Workspace and current Git branch, shown under the composer. */
export function WorkspaceBadge({ sessionId, workspace }: {
  sessionId?: string
  workspace?: string
}) {
  const [git, setGit] = useState<GitInfo | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setGit(null)
      return
    }
    let cancelled = false
    const load = () => {
      void api.getGitInfo(sessionId)
        .then((info) => { if (!cancelled) setGit(info) })
        .catch(() => { if (!cancelled) setGit(null) })
    }
    load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId])

  const root = git?.workspace || workspace
  if (!root) return null

  const branch = git?.available
    ? git.detached
      ? `detached@${(git.branch ?? git.head ?? '').slice(0, 7)}`
      : git.branch
    : null
  const title = branch ? `${root}\n分支 ${branch}` : root

  return (
    <span className="workspace-badge" title={title}>
      <span className="workspace-badge-item">
        <FolderIcon size={11} />
        <span className="workspace-badge-label">工作区</span>
        <span className="workspace-badge-value">{shortName(root)}</span>
      </span>
      {branch
        ? (
          <span className="workspace-badge-item">
            <BranchIcon size={11} />
            <span className="workspace-badge-label">分支</span>
            <span className="workspace-badge-value">{branch}</span>
          </span>
        )
        : null}
    </span>
  )
}

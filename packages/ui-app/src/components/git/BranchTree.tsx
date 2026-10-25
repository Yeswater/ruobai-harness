import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { GitBranch, GitInfo } from '../../api.ts'
import { BranchIcon, ChevronRightIcon, PlusIcon } from '../Icons.tsx'
import { useContextMenu } from '../ContextMenu.tsx'

export interface HistoryFilter {
  /** Branch or ref to walk, null means HEAD. */
  ref: string | null
  /** Show every ref instead of one starting point. */
  all: boolean
  label: string
}

interface BranchTreeProps {
  branches: GitBranch[]
  info: GitInfo
  filter: HistoryFilter
  disabled: boolean
  onFilter: (filter: HistoryFilter) => void
  onCheckout: (branch: GitBranch) => void
  onCreate: (name: string) => void
}

/** Local and remote branches; clicking one filters history, the row action checks it out. */
export function BranchTree({
  branches, info, filter, disabled, onFilter, onCheckout, onCreate,
}: BranchTreeProps) {
  const contextMenu = useContextMenu()
  const [closed, setClosed] = useState<Set<string>>(() => new Set(['local', 'remote']))
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const toggle = (key: string) => {
    setClosed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const locals = branches.filter(branch => !branch.remote)
  const remotes = branches.filter(branch => branch.remote)

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setName('')
    setCreating(false)
    onCreate(trimmed)
  }

  const menu = (event: ReactMouseEvent, branch: GitBranch) => {
    contextMenu.open(event, [
      {
        label: branch.current ? '当前分支' : '切换到此分支',
        disabled: branch.current || disabled,
        onSelect: () => onCheckout(branch),
      },
      {
        label: '查看此分支的提交',
        onSelect: () => onFilter({ ref: branch.name, all: false, label: branch.name }),
      },
      { separator: true },
      {
        label: '复制分支名',
        onSelect: () => { void navigator.clipboard.writeText(branch.name).catch(() => undefined) },
      },
    ])
  }

  const row = (branch: GitBranch) => (
    <div
      key={branch.name}
      className={`git-branch-row ${filter.ref === branch.name && !filter.all ? 'selected' : ''} ${branch.current ? 'current' : ''}`}
      onClick={() => onFilter({ ref: branch.name, all: false, label: branch.name })}
      onContextMenu={event => menu(event, branch)}
    >
      <BranchIcon size={12} />
      <span className="git-branch-label" title={branch.name}>{branch.name}</span>
      {branch.current ? <span className="git-branch-tag">当前</span> : null}
      {branch.gone ? <span className="git-branch-tag gone">上游已删除</span> : null}
      {branch.ahead ? <span className="git-sync">↑{branch.ahead}</span> : null}
      {branch.behind ? <span className="git-sync">↓{branch.behind}</span> : null}
      {!branch.current && !disabled
        ? (
          <button
            className="git-branch-switch"
            title={`切换到 ${branch.name}`}
            onClick={(event) => {
              event.stopPropagation()
              onCheckout(branch)
            }}
          >
            切换
          </button>
        )
        : null}
    </div>
  )

  const group = (key: string, label: string, rows: GitBranch[]) => {
    const open = !closed.has(key)
    return (
      <div className="git-branch-group" key={key}>
        <div className="git-branch-group-head" onClick={() => toggle(key)}>
          <span className={`git-caret ${open ? 'open' : ''}`}><ChevronRightIcon size={11} /></span>
          <span>{label}</span>
          <span className="git-count">{rows.length}</span>
        </div>
        {open ? <div className="git-branch-group-body">{rows.map(row)}</div> : null}
      </div>
    )
  }

  return (
    <section className="git-nav-section">
      <div className="git-nav-head">
        <span className="git-nav-title">分支</span>
        <span className="git-count">{branches.length}</span>
        <span className="spacer" />
        <button
          className="icon-btn subtle"
          title="新建分支"
          aria-label="新建分支"
          disabled={disabled}
          onClick={() => setCreating(current => !current)}
        >
          <PlusIcon size={12} />
        </button>
      </div>

      {creating
        ? (
          <div className="git-branch-create">
            <input
              value={name}
              autoFocus
              placeholder="新分支名"
              aria-label="新分支名"
              onChange={event => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
                if (event.key === 'Escape') setCreating(false)
              }}
            />
            <button className="btn compact" disabled={!name.trim()} onClick={submit}>创建</button>
          </div>
        )
        : null}

      <div className="git-branch-rows">
        <div
          className={`git-branch-row ${filter.ref === null && !filter.all ? 'selected' : ''}`}
          onClick={() => onFilter({ ref: null, all: false, label: 'HEAD' })}
        >
          <BranchIcon size={12} />
          <span className="git-branch-label" title={info.branch ?? 'HEAD'}>
            HEAD {info.detached ? `(detached ${info.branch ?? ''})` : `(${info.branch ?? '—'})`}
          </span>
        </div>
        <div
          className={`git-branch-row ${filter.all ? 'selected' : ''}`}
          onClick={() => onFilter({ ref: null, all: true, label: '所有分支' })}
        >
          <BranchIcon size={12} />
          <span className="git-branch-label">所有分支</span>
        </div>
        {locals.length ? group('local', '本地', locals) : null}
        {remotes.length ? group('remote', '远程', remotes) : null}
      </div>
    </section>
  )
}

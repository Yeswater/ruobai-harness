import { useState } from 'react'
import type { FunctionView, ToolTab } from '../../function-views.ts'
import { McpSettings } from '../McpSettings.tsx'
import { CommandIcon, PlugIcon, SearchIcon, SparkIcon } from '../Icons.tsx'
import { KnowledgeWorkspace } from './KnowledgeWorkspace.tsx'
import { SkillsPane } from './SkillsPane.tsx'

const TOOL_TABS: Array<{ id: ToolTab; label: string; icon: typeof SparkIcon }> = [
  { id: 'experts', label: '专家', icon: SparkIcon },
  { id: 'skills', label: '技能', icon: CommandIcon },
  { id: 'connectors', label: '连接器', icon: PlugIcon },
]

export function FunctionWorkspace({ view, toolTab, onToolTabChange, sessionId, onBack }: {
  view: FunctionView
  toolTab: ToolTab
  onToolTabChange: (tab: ToolTab) => void
  sessionId?: string
  onBack: () => void
}) {
  const [query, setQuery] = useState('')

  if (view === 'wiki') return <KnowledgeWorkspace sessionId={sessionId} />

  return (
    <div className="tools-workspace">
      <header className="tools-bar">
        <nav className="tools-tabs" role="tablist" aria-label="专家、技能与连接器">
          {TOOL_TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={toolTab === tab.id}
                className={toolTab === tab.id ? 'active' : ''}
                onClick={() => onToolTabChange(tab.id)}
              >
                <Icon size={15} />
                {tab.label}
              </button>
            )
          })}
        </nav>
        {toolTab === 'skills'
          ? (
            <div className="tools-search">
              <SearchIcon size={13} />
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索 SkillHub"
                aria-label="搜索 SkillHub"
              />
              {query ? <button onClick={() => setQuery('')} aria-label="清除搜索">×</button> : null}
            </div>
          )
          : null}
      </header>

      <div className="tools-body">
        {toolTab === 'experts'
          ? <ExpertsPane onBack={onBack} />
          : toolTab === 'skills'
            ? <SkillsPane sessionId={sessionId} query={query} />
            : <McpSettings />}
      </div>
    </div>
  )
}

function ExpertsPane({ onBack }: { onBack: () => void }) {
  return (
    <div className="fn-empty-page">
      <div className="fn-empty-card">
        <span className="fn-empty-icon"><SparkIcon size={26} /></span>
        <h2>专家</h2>
        <p>
          专家会把一组固定的做事方式——提示词、技能、连接器与默认权限——打包成可以反复召唤的角色。
        </p>
        <ul>
          <li>为「代码审查」「发布检查」「数据分析」等场景预置工作流</li>
          <li>专家可以携带自己的技能与连接器，不污染默认会话</li>
          <li>正在规划中，先从技能与连接器开始组合</li>
        </ul>
        <button className="btn ghost" onClick={onBack}>返回会话</button>
      </div>
    </div>
  )
}

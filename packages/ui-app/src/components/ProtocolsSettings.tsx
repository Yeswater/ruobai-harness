import { useCallback, useEffect, useState } from 'react'
import { api, type ProtocolsInfo } from '../api.ts'

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** Read-only view of the instruction, MCP config and A2A files. */
export function ProtocolsSettings({ sessionId }: { sessionId?: string }) {
  const [data, setData] = useState<ProtocolsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.getProtocols(sessionId))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const instructions = data?.instructions
  const mcp = data?.mcp
  const a2a = data?.a2a

  return (
    <div className="settings-page-body scroll protocols-page">
      <div className="protocols-head">
        <p className="field-help">
          自动读取 ~/.ruobai 与项目 .ruobai 下的指令、MCP 配置与 A2A 声明。技能与连接器在左侧功能区管理，此页只读。
        </p>
        <button className="btn ghost compact" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error ? <div className="detail-note error">{error}</div> : null}

      {instructions
        ? (
          <section className="settings-section">
            <h3>指令文件 <span className="protocol-count">{instructions.files.length}</span></h3>
            {instructions.files.length
              ? instructions.files.map(file => (
                <div className="protocol-row" key={file.path}>
                  <span className="protocol-badge">MD</span>
                  <div className="protocol-main">
                    <div className="protocol-title">{file.display}</div>
                    <div className="protocol-path mono">{file.path} · {formatBytes(file.bytes)}</div>
                  </div>
                </div>
              ))
              : <div className="detail-note">没有发现 AGENTS.md / agent.md / CLAUDE.md。</div>}
            {instructions.truncated
              ? <div className="detail-note">内容超出 maxInstructions，已截断。</div>
              : null}
          </section>
        )
        : null}

      {mcp
        ? (
          <section className="settings-section">
            <h3>MCP 配置文件</h3>
            {mcp.files.map(file => (
              <div className="protocol-row" key={file.path}>
                <span className="protocol-badge">MCP</span>
                <div className="protocol-main">
                  <div className="protocol-title">{file.label}</div>
                  <div className="protocol-path mono">{file.path} · {file.count} 个服务</div>
                </div>
              </div>
            ))}
            <div className="detail-note">设置页里的 MCP 服务与这些文件合并，同名时文件优先。</div>
          </section>
        )
        : null}

      {a2a
        ? (
          <section className="settings-section">
            <h3>A2A 远端智能体 <span className="protocol-count">{a2a.agents.length}</span></h3>
            {a2a.agents.length
              ? a2a.agents.map(agent => (
                <div className="protocol-row" key={agent.id}>
                  <span className={`status-dot ${agent.status === 'ok' ? 'ok' : agent.status === 'error' ? 'danger' : 'off'}`} />
                  <div className="protocol-main">
                    <div className="protocol-title">
                      {agent.name}
                      <span className="protocol-meta">{agent.tool}</span>
                    </div>
                    <div className="protocol-desc mono">{agent.url}</div>
                    {agent.error ? <div className="detail-note error">{agent.error}</div> : null}
                    {agent.skills.length
                      ? (
                        <div className="chip-row">
                          {agent.skills.map(skill => (
                            <span className="chip" key={skill.id} title={skill.description}>{skill.name}</span>
                          ))}
                        </div>
                      )
                      : null}
                  </div>
                </div>
              ))
              : <div className="detail-note">没有配置远端 agent（.ruobai/a2a.json）。</div>}
            {a2a.sources.length
              ? <div className="protocol-roots">
                {a2a.sources.map(source => (
                  <span className="protocol-root mono" key={source}>{source}</span>
                ))}
              </div>
              : null}
          </section>
        )
        : null}

      {!loading && !error && !instructions && !mcp && !a2a
        ? <div className="detail-note">协议服务未启用。</div>
        : null}
    </div>
  )
}

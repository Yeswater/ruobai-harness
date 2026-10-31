import { useCallback, useEffect, useState } from 'react'
import { api, type ProtocolsInfo } from '../api.ts'
import { CheckIcon, CopyIcon, RefreshIcon } from './Icons.tsx'
import { Button, Disclosure, IconButton } from './ui/index.tsx'

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function PathRow({ badge, title, detail, copy }: {
  badge: string
  title: string
  detail: string
  copy: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="protocol-row">
      <span className="protocol-badge">{badge}</span>
      <div className="protocol-main">
        <div className="protocol-title">{title}</div>
        <div className="protocol-path mono" title={copy}>{detail}</div>
      </div>
      <IconButton onClick={() => void handleCopy()} aria-label={`复制路径 ${copy}`} title="复制路径">
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </IconButton>
    </div>
  )
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
    <div className="protocols-page">
      <div className="protocols-head">
        <p className="field-help">
          自动读取 ~/.ruobai 与项目 .ruobai 下的指令、MCP 配置与 A2A 声明。技能与连接器在左侧功能区管理，此页只读。
        </p>
        <Button variant="ghost" small onClick={() => void load()} disabled={loading}>
          <RefreshIcon size={13} />
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {error ? <div className="ui-notice error">{error}</div> : null}

      {instructions
        ? (
          <section className="settings-section">
            <h3>指令文件 <span className="protocol-count">{instructions.files.length}</span></h3>
            {instructions.files.length
              ? instructions.files.map(file => (
                <PathRow
                  key={file.path}
                  badge="MD"
                  title={file.display}
                  detail={`${file.path} · ${formatBytes(file.bytes)}`}
                  copy={file.path}
                />
              ))
              : <div className="ui-empty"><strong>没有发现 AGENTS.md</strong><span>在项目根目录放一个 AGENTS.md，或在工作区配置里指定指令文件。</span></div>}
            {instructions.truncated
              ? <div className="ui-notice">内容超出 maxInstructions，已截断。</div>
              : null}
          </section>
        )
        : null}

      {mcp
        ? (
          <section className="settings-section">
            <h3>MCP 配置文件 <span className="protocol-count">{mcp.files.length}</span></h3>
            {mcp.files.length
              ? mcp.files.map(file => (
                <PathRow
                  key={file.path}
                  badge="MCP"
                  title={`${file.label} · ${file.count} 个服务`}
                  detail={file.path}
                  copy={file.path}
                />
              ))
              : <div className="ui-empty"><strong>没有 MCP 配置</strong><span>添加 .mcp.json 后刷新，这里会显示加载结果。</span></div>}
            <p className="field-help">设置页里的 MCP 服务与这些文件合并，同名时文件优先。</p>
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
                    {agent.error ? <div className="ui-notice error">{agent.error}</div> : null}
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
              : <div className="ui-empty"><strong>没有配置远端 agent</strong><span>在 .ruobai/a2a.json 里声明后，这里会显示连接状态。</span></div>}
            {a2a.sources.length
              ? (
                <Disclosure title="查找位置" meta={`${a2a.sources.length} 个`}>
                  <div className="protocol-roots">
                    {a2a.sources.map(source => (
                      <span className="protocol-root mono" key={source}>{source}</span>
                    ))}
                  </div>
                </Disclosure>
              )
              : null}
          </section>
        )
        : null}

      {!loading && !error && !instructions && !mcp && !a2a
        ? <div className="ui-empty"><strong>协议服务未启用</strong><span>启用后，这里会列出指令、MCP 与 A2A 的加载情况。</span></div>
        : null}
    </div>
  )
}

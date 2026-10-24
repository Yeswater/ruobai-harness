import { useEffect, useState } from 'react'
import {
  api,
  type ApprovalAction,
  type ApprovalMatch,
  type ApprovalRule,
  type DangerRuleInfo,
} from '../api.ts'
import { PlusIcon } from './Icons.tsx'

interface Draft {
  id?: string
  tool: string
  match: ApprovalMatch
  action: ApprovalAction
  pattern: string
  note: string
}

const SUGGESTED_TOOLS = ['bash', 'write_file', 'edit_file']

const ACTION_LABEL: Record<ApprovalAction, string> = {
  allow: '允许',
  ask: '询问',
  deny: '拒绝',
}

const MATCH_LABEL: Record<ApprovalMatch, string> = {
  exact: '精确匹配',
  prefix: '前缀匹配',
  glob: '路径通配',
  contains: '包含文本',
}

function draftOf(rule?: ApprovalRule | null): Draft {
  return {
    id: rule?.id,
    tool: rule?.tool ?? 'bash',
    match: rule?.match ?? 'exact',
    action: rule?.action ?? 'allow',
    pattern: rule?.pattern ?? '',
    note: rule?.note ?? '',
  }
}

function matchesFor(tool: string): ApprovalMatch[] {
  return tool === 'bash' ? ['exact', 'prefix', 'contains'] : ['exact', 'glob', 'contains']
}

export function PermissionsSettings() {
  const [rules, setRules] = useState<ApprovalRule[]>([])
  const [draft, setDraft] = useState<Draft>(draftOf(null))
  const [bypass, setBypass] = useState(false)
  const [guardEnabled, setGuardEnabled] = useState(true)
  const [builtin, setBuiltin] = useState<DangerRuleInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [policyBusy, setPolicyBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [policyNotice, setPolicyNotice] = useState<string | null>(null)

  const applyList = (list: ApprovalRule[], target?: ApprovalRule | null) => {
    setRules(list)
    setDraft(draftOf(target ?? null))
  }

  useEffect(() => {
    let cancelled = false
    void Promise.all([api.getApprovalRules(), api.getSettings(), api.getApprovalGuard()])
      .then(([list, settings, guard]) => {
        if (cancelled) return
        setRules(list)
        setDraft(draftOf(list[0]))
        setBypass(Boolean(settings.agent?.bypassApprovals))
        setGuardEnabled(guard.guard.enabled !== false)
        setBuiltin(guard.builtin)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patch = (partial: Partial<Draft>) => {
    setDraft(current => ({ ...current, ...partial }))
  }

  const changeTool = (tool: string) => {
    const allowed = matchesFor(tool)
    setDraft(current => ({
      ...current,
      tool,
      match: allowed.includes(current.match) ? current.match : allowed[0]!,
    }))
    setError(null)
    setNotice(null)
  }

  const selectRule = (rule: ApprovalRule) => {
    setDraft(draftOf(rule))
    setError(null)
    setNotice(null)
  }

  const addRule = () => {
    setDraft(draftOf(null))
    setError(null)
    setNotice(null)
  }

  const savePolicy = async () => {
    setPolicyBusy(true)
    setError(null)
    setPolicyNotice(null)
    try {
      await api.updateSettings({ agent: { bypassApprovals: bypass } })
      const guard = await api.updateApprovalGuard({ enabled: guardEnabled })
      setGuardEnabled(guard.enabled !== false)
      setPolicyNotice('已保存')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPolicyBusy(false)
    }
  }

  const save = async () => {
    setBusy('save')
    setError(null)
    setNotice(null)
    try {
      const input = {
        tool: draft.tool.trim(),
        match: draft.match,
        action: draft.action,
        pattern: draft.pattern.trim(),
        note: draft.note.trim(),
      }
      const list = draft.id
        ? await api.updateApprovalRule(draft.id, input)
        : await api.createApprovalRule(input)
      const saved = list.find(rule => rule.id === draft.id)
        ?? list.find(rule =>
          rule.tool === input.tool
          && rule.match === input.match
          && rule.action === input.action
          && rule.pattern === input.pattern)
        ?? list[0]
      applyList(list, saved)
      setNotice('已保存，下一条匹配的工具调用按所选动作处理')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!draft.id) return
    setBusy('remove')
    setError(null)
    setNotice(null)
    try {
      const list = await api.deleteApprovalRule(draft.id)
      applyList(list, list[0])
      setNotice('已删除')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const shell = draft.tool.trim() === 'bash'

  return (
    <div className="permissions-page">
      <section className="permission-policy">
        <label className="field">
          <span>审批模式</span>
          <select value={bypass ? 'bypass' : 'ask'} onChange={event => setBypass(event.target.value === 'bypass')}>
            <option value="ask">逐次询问（默认）</option>
            <option value="bypass">跳过审批</option>
          </select>
        </label>

        <label className="policy-toggle">
          <input
            type="checkbox"
            checked={guardEnabled}
            onChange={event => setGuardEnabled(event.target.checked)}
          />
          <span>内置危险命令保护</span>
        </label>

        <span className="spacer" />
        {policyNotice ? <span className="policy-notice">{policyNotice}</span> : null}
        <button className="btn ghost" onClick={savePolicy} disabled={policyBusy}>
          {policyBusy ? '保存中…' : '保存策略'}
        </button>
      </section>

      <p className="permission-help">
        优先级：拒绝 &gt; 询问 &gt; 允许。跳过审批只影响没有命中“询问/拒绝”规则的调用。
      </p>

      {guardEnabled && builtin.length ? (
        <details className="permission-builtins">
          <summary>查看内置保护规则（{builtin.length} 条，按“询问”处理）</summary>
          <div className="model-chips">
            {builtin.map(rule => (
              <span className="model-chip" key={rule.id} title={rule.sample}>{rule.label}</span>
            ))}
          </div>
        </details>
      ) : null}

      <div className="settings-grid">
        <aside className="provider-list">
          <button className="new-session provider-add" onClick={addRule}>
            <PlusIcon size={15} />
            <span>添加权限规则</span>
          </button>

          {rules.map(rule => (
            <button
              key={rule.id}
              className={`provider-item ${draft.id === rule.id ? 'active' : ''}`}
              onClick={() => selectRule(rule)}
            >
              <span className="provider-item-head">
                <span className="provider-name">{rule.tool}</span>
                <span className={`badge ${rule.action}`}>{ACTION_LABEL[rule.action]}</span>
              </span>
              <span className="provider-url">{rule.pattern}</span>
              <span className="provider-meta">
                {MATCH_LABEL[rule.match]}{rule.note ? ` · ${rule.note}` : ''}
              </span>
            </button>
          ))}

          {rules.length ? null : (
            <div className="provider-list-note">
              还没有规则；点审批卡上的「始终允许」会生成一条“允许”规则。
            </div>
          )}

          <div className="provider-list-note">
            规则持久化到 <code>.ruobai/settings.json</code>，重启后仍然生效。
          </div>
        </aside>

        <section className="provider-form">
          <div className="form-row two">
            <label className="field">
              <span>工具 *</span>
              <input
                list="approval-rule-tools"
                value={draft.tool}
                onChange={event => changeTool(event.target.value)}
                placeholder="bash"
              />
              <datalist id="approval-rule-tools">
                {SUGGESTED_TOOLS.map(tool => <option key={tool} value={tool} />)}
              </datalist>
            </label>
            <label className="field">
              <span>动作 *</span>
              <select
                value={draft.action}
                onChange={event => patch({ action: event.target.value as ApprovalAction })}
              >
                {(['allow', 'ask', 'deny'] as const).map(action => (
                  <option key={action} value={action}>{ACTION_LABEL[action]}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-row two">
            <label className="field">
              <span>匹配方式</span>
              <select value={draft.match} onChange={event => patch({ match: event.target.value as ApprovalMatch })}>
                {matchesFor(draft.tool).map(match => (
                  <option key={match} value={match}>{MATCH_LABEL[match]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>备注</span>
              <input
                value={draft.note}
                onChange={event => patch({ note: event.target.value })}
                placeholder="可选，例如「跑测试」"
              />
            </label>
          </div>

          <label className="field">
            <span>{shell ? '命令 *' : '工作区路径 *'}</span>
            <input
              value={draft.pattern}
              onChange={event => patch({ pattern: event.target.value })}
              placeholder={shell ? 'pnpm test' : 'src/**/*.ts'}
            />
          </label>

          <div className="field-help">
            {shell
              ? '精确匹配要求整条命令完全一致；前缀匹配只对不含 ; && | > < $() 反引号 换行的命令生效；包含文本按字面匹配，作为“允许”时含操作符的命令不会命中。'
              : '路径相对工作区；* 不跨目录，** 跨目录，? 匹配单个字符；包含文本按字面匹配路径。'}
          </div>

          {error ? <div className="detail-note error">{error}</div> : null}
          {notice ? <div className="detail-note">{notice}</div> : null}

          <div className="provider-actions">
            {draft.id ? (
              <button className="btn ghost danger" onClick={remove} disabled={busy !== null}>删除</button>
            ) : null}
            <span className="spacer" />
            <button
              className="btn"
              onClick={save}
              disabled={busy !== null || !draft.tool.trim() || !draft.pattern.trim()}
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

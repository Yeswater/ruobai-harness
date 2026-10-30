import { useEffect, useState } from 'react'
import { api, type WikiAutomation } from '../../api.ts'
import { SettingRow, SettingsGroup } from './SettingsLayout.tsx'
import { Switch } from '../ui/index.tsx'

export function WikiSettings() {
  const [automation, setAutomation] = useState<WikiAutomation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getWikiAutomation()
      .then((next) => { if (!cancelled) setAutomation(next) })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => { cancelled = true }
  }, [])

  const toggle = async (key: keyof WikiAutomation) => {
    if (!automation) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setAutomation(await api.updateWikiAutomation({ [key]: !automation[key] }))
      setNotice('已保存')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-panel">
      <SettingsGroup label="知识库自动化">
        <SettingRow
          title="每轮自动检索"
          description="按最新用户问题检索知识库，最多 8 条 / 6k 字符 / 150ms；命中片段只作为参考数据注入，不替代模型判断。"
        >
          <Switch
            checked={automation?.recall ?? false}
            label="启用每轮自动检索"
            disabled={!automation || busy}
            onChange={() => void toggle('recall')}
          />
        </SettingRow>
        <SettingRow
          title="会话空闲后生成提案"
          description="空闲 10 分钟、至少累积 2 个新用户回合后起草一页；使用当前非 mock 模型。只写入待审提案，不会直接修改页面。"
        >
          <Switch
            checked={automation?.distill ?? false}
            label="启用会话空闲后生成提案"
            disabled={!automation || busy}
            onChange={() => void toggle('distill')}
          />
        </SettingRow>
      </SettingsGroup>

      <p className="settings-section-note">
        自动检索超时或失败只跳过当前轮；自动提案仍需要人工接受，每天最多 10 次、100k tokens，连续失败会熔断。
      </p>
      {error ? <div className="ui-notice error">{error}</div> : null}
      {notice && !error ? <div className="ui-notice ok">{notice}</div> : null}
    </div>
  )
}

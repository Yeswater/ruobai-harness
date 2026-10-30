import { useEffect, useState } from 'react'
import { api, type SkillDraft } from '../../api.ts'
import { SettingsGroup, SettingsScroll } from './SettingsLayout.tsx'

/**
 * Skill drafts distilled from finished sessions.
 *
 * A draft is not a skill: it lives outside the skill roots until someone
 * approves it here. The list is the whole gate — approve moves the directory
 * into `.ruobai/skills/`, discard deletes it.
 */
export function SkillDraftsSettings() {
  const [drafts, setDrafts] = useState<SkillDraft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    try {
      setDrafts(await api.skillDrafts())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const act = async (slug: string, action: 'approve' | 'discard') => {
    setBusy(slug)
    setError(null)
    setNotice(null)
    try {
      if (action === 'approve') await api.approveSkillDraft(slug)
      else await api.discardSkillDraft(slug)
      setNotice(action === 'approve' ? '已批准，下一个会话生效' : '已丢弃')
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-panel">
      <SettingsScroll>
        <SettingsGroup label="技能草稿">
          {drafts.length === 0
            ? <div className="settings-note">还没有草稿。会话空闲后会把可复用的步骤写到这里，等你确认。</div>
            : (
              <ul className="profile-list">
                {drafts.map(draft => (
                  <li key={draft.slug} className="profile-row">
                    <span className="profile-label">{draft.name}</span>
                    <span className="profile-root">{draft.description || draft.slug}</span>
                    <button
                      className="btn ghost compact"
                      disabled={busy === draft.slug}
                      onClick={() => void act(draft.slug, 'approve')}
                    >
                      批准
                    </button>
                    <button
                      className="btn ghost compact"
                      disabled={busy === draft.slug}
                      onClick={() => void act(draft.slug, 'discard')}
                    >
                      丢弃
                    </button>
                  </li>
                ))}
              </ul>
            )}
          {error ? <div className="settings-note danger">{error}</div> : null}
          {notice ? <div className="settings-note">{notice}</div> : null}
        </SettingsGroup>
      </SettingsScroll>
    </div>
  )
}

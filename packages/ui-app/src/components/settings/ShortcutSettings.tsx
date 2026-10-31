import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  SHORTCUTS, chordFor, chordOf, findConflict, formatChord, getKeymap, isDefaultChord, resetKeymap,
  setKeymap, subscribeKeymap, type ShortcutId,
} from '../../shortcuts.ts'
import { Button } from '../ui/index.tsx'
import { SettingRow, SettingsGroup } from './SettingsLayout.tsx'

/**
 * Rebinding is a recording box, not a text field: the user presses the chord
 * they want. Comma and other punctuation keep working because matching goes
 * through `chordOf`, the same path the global handler uses.
 */
export function ShortcutSettings() {
  const map = useSyncExternalStore(subscribeKeymap, getKeymap)
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      // Capture phase: the app's own shortcuts must not fire while recording.
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        setHint(null)
        return
      }
      const next = chordOf(event)
      if (!next) {
        setHint('需要带 ⌘ / Ctrl 的组合键')
        return
      }
      const conflict = findConflict(recording, next, map)
      if (conflict) {
        setHint(`这个组合已经用于「${conflict.label}」`)
        return
      }
      setKeymap({ ...map, [recording]: next })
      setRecording(null)
      setHint(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, map])

  return (
    <SettingsGroup label="快捷键">
      {SHORTCUTS.map(item => (
        <SettingRow key={item.id} title={item.label} description={item.description}>
          <span className="shortcut-control">
            <button
              type="button"
              className={recording === item.id ? 'shortcut-key recording' : 'shortcut-key'}
              aria-label={`设置「${item.label}」的快捷键`}
              onClick={() => {
                setHint(null)
                setRecording(current => current === item.id ? null : item.id)
              }}
            >
              {recording === item.id ? '按下组合键…' : formatChord(chordFor(item.id, map))}
            </button>
            <Button
              variant="ghost"
              small
              disabled={isDefaultChord(item.id, map)}
              onClick={() => setKeymap({ ...map, [item.id]: undefined })}
            >
              重置
            </Button>
          </span>
        </SettingRow>
      ))}

      {hint ? <div className="settings-note shortcut-hint">{hint}</div> : null}

      <SettingRow title="恢复默认" description="所有快捷键回到默认组合。">
        <Button
          variant="ghost"
          small
          onClick={() => {
            resetKeymap()
            setHint(null)
            setRecording(null)
          }}
        >
          全部重置
        </Button>
      </SettingRow>
    </SettingsGroup>
  )
}

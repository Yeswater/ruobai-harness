/** UI skins are local to this machine, like the theme preference. */
export type UiSkin = 'cc' | 'deepseek'

export const SKINS: Array<{ id: UiSkin; name: string; note: string }> = [
  { id: 'cc', name: 'Claude Code', note: '暖中性色，橙色强调，密度低' },
  { id: 'deepseek', name: 'DeepSeek', note: '冷中性色，蓝色强调，密度高' },
]

const SKIN_KEY = 'rbh-skin'

export function loadSkin(): UiSkin {
  const saved = localStorage.getItem(SKIN_KEY)
  return saved === 'deepseek' ? saved : 'cc'
}

export function applySkin(skin: UiSkin) {
  document.documentElement.dataset.skin = skin
}

export function saveSkin(skin: UiSkin) {
  localStorage.setItem(SKIN_KEY, skin)
}

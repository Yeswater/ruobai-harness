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

/** Whether the sidebar shows the brand block above the new-session button. */
const BRAND_KEY = 'rbh-sidebar-brand'

export function loadSidebarBrand(): boolean {
  return localStorage.getItem(BRAND_KEY) !== 'off'
}

export function saveSidebarBrand(show: boolean) {
  localStorage.setItem(BRAND_KEY, show ? 'on' : 'off')
}

/** What the sidebar leaves behind when it is collapsed. */
export type CollapsedSidebar = 'hidden' | 'rail'

const COLLAPSED_MODE_KEY = 'rbh-collapsed-mode'

export function loadCollapsedMode(): CollapsedSidebar {
  return localStorage.getItem(COLLAPSED_MODE_KEY) === 'rail' ? 'rail' : 'hidden'
}

export function saveCollapsedMode(mode: CollapsedSidebar) {
  localStorage.setItem(COLLAPSED_MODE_KEY, mode)
}

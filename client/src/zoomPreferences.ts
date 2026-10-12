export const MIN_ZOOM = 50
export const MAX_ZOOM = 200
export const ZOOM_STEP = 10

const GLOBAL_KEY = 'icpc-app-zoom'
// 沿用已有键，保留原回复字号偏好；现在同一比例也应用于用户消息。
const REPLY_KEY = 'icpc-ai-reply-zoom'
let snapshot = { global: 100, reply: 100 }
const listeners = new Set<() => void>()

export const getZoomPreferences = () => snapshot
export function subscribeZoomPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function apply(): void {
  document.documentElement.style.setProperty('--app-zoom', String(snapshot.global / 100))
  document.documentElement.style.setProperty('--ai-reply-text-zoom', String(snapshot.reply / 100))
  for (const listener of listeners) listener()
}

function read(key: string): number {
  try {
    const value = Number(localStorage.getItem(key))
    if (Number.isFinite(value) && value >= MIN_ZOOM && value <= MAX_ZOOM) {
      return Math.round(value / ZOOM_STEP) * ZOOM_STEP
    }
  } catch { /* 存储不可用时使用默认值。 */ }
  return 100
}

export function initializeZoomPreferences(): void {
  snapshot = { global: read(GLOBAL_KEY), reply: read(REPLY_KEY) }
  apply()
}

export function setZoomPreference(kind: 'global' | 'reply', percent: number): void {
  if (!Number.isFinite(percent)) return
  const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent / ZOOM_STEP) * ZOOM_STEP))
  if (snapshot[kind] === value) return
  snapshot = { ...snapshot, [kind]: value }
  apply()
  try {
    localStorage.setItem(kind === 'global' ? GLOBAL_KEY : REPLY_KEY, String(value))
  } catch { /* 当前窗口仍可调整缩放。 */ }
}

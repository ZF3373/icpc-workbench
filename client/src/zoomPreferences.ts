export const MIN_ZOOM = 50
export const MAX_ZOOM = 200
export const ZOOM_STEP = 10

/**
 * 可独立缩放的对象：
 * - `global` 整页界面（文字、按钮、菜单一起缩放）
 * - `reply` AI 对话正文（双方消息同步）
 * - `note` 笔记查看卡片正文（复习笔记 / 学习笔记 / 任务备注共用）
 * 三者比例互相独立，各自持久化 —— 用户对「读长笔记」和「看界面」的诉求不同，
 * 合成一个比例会让任一侧偏大或偏小。
 */
export type ZoomKind = 'global' | 'reply' | 'note'

const GLOBAL_KEY = 'icpc-app-zoom'
// 沿用已有键，保留原回复字号偏好；现在同一比例也应用于用户消息。
const REPLY_KEY = 'icpc-ai-reply-zoom'
const NOTE_KEY = 'icpc-note-text-zoom'
const STORAGE_KEYS: Record<ZoomKind, string> = { global: GLOBAL_KEY, reply: REPLY_KEY, note: NOTE_KEY }
let snapshot: Record<ZoomKind, number> = { global: 100, reply: 100, note: 100 }
const listeners = new Set<() => void>()

export const getZoomPreferences = () => snapshot
export function subscribeZoomPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function apply(): void {
  document.documentElement.style.setProperty('--app-zoom', String(snapshot.global / 100))
  document.documentElement.style.setProperty('--ai-reply-text-zoom', String(snapshot.reply / 100))
  // 笔记字号只作用于笔记卡片正文（见 index.css 的 .note-card 段），
  // 卡片标题与按钮不在该变量作用域内，因此不会跟着一起变大。
  document.documentElement.style.setProperty('--note-text-zoom', String(snapshot.note / 100))
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
  snapshot = {
    global: read(GLOBAL_KEY),
    reply: read(REPLY_KEY),
    note: read(NOTE_KEY),
  }
  apply()
}

export function setZoomPreference(kind: ZoomKind, percent: number): void {
  if (!Number.isFinite(percent)) return
  const value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent / ZOOM_STEP) * ZOOM_STEP))
  if (snapshot[kind] === value) return
  snapshot = { ...snapshot, [kind]: value }
  apply()
  try {
    localStorage.setItem(STORAGE_KEYS[kind], String(value))
  } catch { /* 当前窗口仍可调整缩放。 */ }
}

/**
 * 百分数 → 倍数文案（100 → '1×'，120 → '1.2×'，50 → '0.5×'）。
 * 用户视角的「放大缩小倍数」就是这个值；面板与卡片提示都复用它，
 * 避免各处自己拼字符串拼出 '1.2000×' 这种尾巴。步长是 10%，
 * 所以保留两位小数先兜住任意非步长输入，再去掉多余的 0。
 */
export function zoomMultipleLabel(percent: number): string {
  if (!Number.isFinite(percent)) return '1×'
  const multiple = Number((Math.round(percent) / 100).toFixed(2))
  return `${multiple}×`
}

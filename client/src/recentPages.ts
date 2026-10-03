/**
 * 「最近访问」记录（全局命令面板的第一个分组）。
 *
 * 纯 localStorage + 订阅，无 React 依赖之外的副作用；用 useSyncExternalStore
 * 与侧边栏菜单顺序同款模式（连续调用必须返回稳定引用，否则 React 会判定状态变更 → 死循环）。
 */

const STORAGE_KEY = 'icpc-recent-pages-v1'
const CHANGE_EVENT = 'icpc-recent-pages-change'

/** 最多记住几个最近访问入口 */
export const MAX_RECENT = 6

/** 从 localStorage 读出最近访问的路由列表（新→旧） */
export function loadRecentPages(): string[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // 隐私模式或无 localStorage
    return []
  }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k): k is string => typeof k === 'string').slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

/** 记一次访问：已在列表里的提到最前，超上限截断，然后广播变更 */
export function pushRecentPage(key: string): void {
  if (!key) return
  const next = [key, ...loadRecentPages().filter((k) => k !== key)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 写不进去只影响下次进来的默认值
    return
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function clearRecentPages(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** 纯函数：把一次访问折叠进已有列表（供单测直接覆盖，不碰 localStorage） */
export function mergeRecent(existing: string[], key: string, max = MAX_RECENT): string[] {
  if (!key) return existing.slice(0, max)
  return [key, ...existing.filter((k) => k !== key)].slice(0, max)
}

// ---------- 订阅 ----------

let cached: string[] | null = null
let cachedKey = '\u0000unset'

function getSnapshot(): string[] {
  const next = loadRecentPages()
  const key = next.join('\u0000')
  if (key !== cachedKey) {
    cachedKey = key
    cached = next
  }
  return cached!
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => cb()
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export { subscribe as subscribeRecentPages, getSnapshot as getRecentPagesSnapshot }

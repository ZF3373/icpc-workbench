/**
 * Cookie 输入框拼装纯逻辑（Settings 页用）。
 * 独立成模块以便 node:test 直测（不依赖 antd/React）。
 */

export interface CookieFieldDef {
  key: string
  cookieName: string
  placeholder: string
  password?: boolean
}

/** 从 Cookie 串按名提取指定项（严格模式：必须匹配 `name=` 前缀，裸值不返回） */
export function extractCookieItem(s: string, name: string): string {
  const m = s.match(new RegExp(`(?:^|;)\\s*${name}=([^;\\s]+)`))
  return m ? m[1] : ''
}

/** 兼容纯值与整段粘贴的提取：不含 = 视为直接填的裸值原样返回；含 = 时按名提取。
 *  用于「已保存的 Cookie 头回填输入框」（保存值恒为拼装好的 Cookie 头）。 */
export function extractCookieValue(raw: string, name: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (!s.includes('=')) return s
  return extractCookieItem(s, name)
}

/**
 * 各输入框填的值拼装为请求用 Cookie 头：
 * - 本框自填：`name=value` 前缀按名提取（容忍整段粘贴）；不带前缀（且非多对
 *   Cookie 串）视为该框裸值原样使用
 * - 空框：只从所有框内容（整段粘贴进任一框的场景）里按 `name=` 提取自己的项，
 *   绝不拿其他框的裸值补位——否则只填一项时其余空框会被同一个值误导性地填满
 */
export function assembleCookie(
  defs: readonly CookieFieldDef[],
  values: Record<string, string> | undefined,
): string {
  if (!defs || !values) return ''
  const blob = defs.map((f) => values[f.key] ?? '').join('; ')
  return defs
    .map((f) => {
      const raw = (values[f.key] ?? '').trim()
      if (!raw) return ''
      const val =
        extractCookieItem(raw, f.cookieName) ||
        (raw.includes(';') ? '' : raw) || // 本框裸值（无 name= 前缀、非多对串）
        extractCookieItem(blob, f.cookieName)
      return val ? `${f.cookieName}=${val}` : ''
    })
    .filter(Boolean)
    .join('; ')
}

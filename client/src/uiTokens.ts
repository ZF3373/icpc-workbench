/**
 * 语义色调 Token 与具体色值读取（原 ui.ts 第一节+第二节）：
 * 页面需要 CSS 上下文的颜色时用 TONE_VAR/toneVar；需要具体色值（recharts/SVG）
 * 时用 useTokenColors。聚合入口仍是 ui.ts。
 */
import { useEffect, useState } from 'react'

/** 语义色调：状态、等级、图表统一用这套名字，页面里不再出现具体色值 */
export type SemanticTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'brand'
  | 'violet'
  | 'cyan'

/** tone → CSS 变量表达式；inline style / className 上下文可直接用（主题切换自动跟随） */
export const TONE_VAR: Record<SemanticTone, string> = {
  success: 'var(--green)',
  warning: 'var(--amber)',
  danger: 'var(--red)',
  info: 'var(--blue)',
  neutral: 'var(--text-3)',
  brand: 'var(--brand)',
  violet: 'var(--violet)',
  cyan: 'var(--cyan)',
}

/** 取语义色调的 CSS 变量表达式（等价于 TONE_VAR[tone]，给调用方一个函数入口便于以后加亮暗分支） */
export function toneVar(tone: SemanticTone): string {
  return TONE_VAR[tone]
}

/* ============================================================
   二、需要具体色值的场景（SVG / canvas / 第三方图表库）
   ============================================================ */

/** Token 名 → CSS 变量名。新增 Token 时这里和 index.css 一起改 */
const CSS_VAR = {
  success: '--green',
  warning: '--amber',
  danger: '--red',
  info: '--blue',
  neutral: '--text-3',
  brand: '--brand',
  violet: '--violet',
  cyan: '--cyan',
  text: '--text',
  text2: '--text-2',
  text3: '--text-3',
  line: '--line',
  lineSoft: '--line-soft',
  surface2: '--surface-2',
  surface3: '--surface-3',
  bgElevated: '--bg-elevated',
  overlay2: '--overlay-2',
  chartGrid: '--chart-grid',
  chartCursor: '--chart-cursor',
} as const

export type TokenName = keyof typeof CSS_VAR

/**
 * 无 DOM 环境（单测 / 预渲染）下的兜底值，与 index.css `:root` 的暗色值一致。
 * 只为「拿到一个合法色值」而不是「拿到正确主题色」—— 浏览器里一律走计算值。
 */
const TOKEN_FALLBACK: Record<TokenName, string> = {
  success: '#69d7a5',
  warning: '#f2c46d',
  danger: '#ff7b84',
  info: '#58a3ff',
  neutral: '#8993a2',
  brand: '#86a8ff',
  violet: '#c080ff',
  cyan: '#45d5e5',
  text: '#f5f7fb',
  text2: '#c4cad4',
  text3: '#8993a2',
  line: '#2a3039',
  lineSoft: '#222831',
  surface2: '#1d212a',
  surface3: '#242a34',
  bgElevated: '#15181e',
  overlay2: 'rgba(255, 255, 255, 0.04)',
  chartGrid: 'rgba(255, 255, 255, 0.06)',
  chartCursor: 'rgba(134, 168, 255, 0.05)',
}

/** 读取当前主题下某个 CSS 变量的计算值 */
export function getTokenColor(name: string, fallback = ''): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** 批量读取全部 Token 的计算值 */
export function getTokenColors(): Record<TokenName, string> {
  const out = {} as Record<TokenName, string>
  for (const key of Object.keys(CSS_VAR) as TokenName[]) {
    out[key] = getTokenColor(CSS_VAR[key], TOKEN_FALLBACK[key])
  }
  return out
}

/**
 * 同一主题内返回同一个对象引用：`setState` 拿到相同引用时 React 会跳过重渲染，
 * 避免 MutationObserver 每次触发都白渲染一轮。
 */
let cachedTokens: Record<TokenName, string> | null = null
let cachedThemeKey = '\u0000unset'

function tokensForCurrentTheme(): Record<TokenName, string> {
  const key = typeof document === 'undefined' ? 'no-dom' : document.documentElement.dataset.theme ?? ''
  if (cachedTokens && cachedThemeKey === key) return cachedTokens
  cachedTokens = getTokenColors()
  cachedThemeKey = key
  return cachedTokens
}

/**
 * 订阅当前主题的 Token 具体色值（recharts 等把颜色写进 SVG 属性的场景必须用这个）。
 *
 * 用 MutationObserver 监听 `documentElement[data-theme]` 而不是读 React context：
 * ThemeProvider 在 effect 里写属性，子组件的 effect 先于父组件执行 —— 挂载时先主动同步一次，
 * 之后主题切换由 observer 驱动，两条路径合起来保证首帧和切换后都拿到正确色值。
 */
export function useTokenColors(): Record<TokenName, string> {
  const [tokens, setTokens] = useState(tokensForCurrentTheme)
  useEffect(() => {
    const sync = () => setTokens(tokensForCurrentTheme())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return tokens
}

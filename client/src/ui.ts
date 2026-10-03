import { useEffect, useState } from 'react'
import { PLATFORMS } from '../../shared/src/index.ts'
import type { PlatformId } from '../../shared/src/index.ts'

/**
 * 纯展示层工具：平台主题色 / 难度配色 / 语义色 Token。
 * 只做视觉取值，不涉及任何业务逻辑与 API。
 *
 * 「颜色从哪来」的唯一约定（UI 优化方案 §6.1 Design Token 治理）：
 * - 所有颜色在 `index.css` 的 `:root`（暗）与 `[data-theme='light']`（亮）里各定义一次；
 * - 页面里**不允许**再写任何 hex / rgba —— 需要 CSS 上下文（inline style、className）时用
 *   `toneVar(tone)` 或直接 `var(--token)`；
 * - 需要**具体色值**时（recharts 把 fill/stroke 写进 SVG 表现属性，`var()` 在其中不生效）
 *   用 `useTokenColors()` 取当前主题的计算值，亮/暗切换会自动重取。
 *
 * 有意保留的硬编码色（属于「数据本身」而非「主题」，不跟随亮暗切换）：
 * - `PLATFORM_COLOR`：各 OJ 的品牌色，换了就不是那个平台了；
 * - `TAG_PALETTE`：知识点标签的散列色板，同一标签必须永远同色（跨主题稳定）。
 */

/* ============================================================
   一、语义色调 Token
   ============================================================ */

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

/* ============================================================
   三、平台
   ============================================================ */

/** 平台展示色（彩色圆点标识用，与后端无关；暗色底下的高可读版本） */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  codeforces: '#58a3ff',
  atcoder: '#f2b75b',
  luogu: '#45d5e5',
  nowcoder: '#69d7a5',
  daimayuan: '#f2965c',
  leetcode: '#ffa116',
  jisuanke: '#7ee0a3', // 计蒜客品牌绿（暗色底可读版）
  qoj: '#b18cff', // QOJ / Universal Cup：暗色底可读的紫罗兰
}

export function platformName(id: PlatformId): string {
  return PLATFORMS.find((p) => p.id === id)?.name ?? id
}

/* ============================================================
   四、难度（CF rating 标尺）
   ============================================================ */

/** CF rating 段位。判断逻辑与配色分开，边界由单测直接覆盖 */
export type DifficultyTone =
  | 'unknown'
  | 'new'
  | 'pupil'
  | 'specialist'
  | 'expert'
  | 'candidate-master'
  | 'master'
  | 'grandmaster'

export function difficultyTone(d: number | null | undefined): DifficultyTone {
  if (d == null) return 'unknown'
  if (d < 1200) return 'new'
  if (d < 1400) return 'pupil'
  if (d < 1600) return 'specialist'
  if (d < 1900) return 'expert'
  if (d < 2100) return 'candidate-master'
  if (d < 2400) return 'master'
  return 'grandmaster'
}

const DIFFICULTY_VAR: Record<DifficultyTone, string> = {
  unknown: 'var(--text-3)',
  new: 'var(--cf-new)',
  pupil: 'var(--cf-pupil)',
  specialist: 'var(--cf-specialist)',
  expert: 'var(--cf-expert)',
  'candidate-master': 'var(--cf-cm)',
  master: 'var(--cf-master)',
  grandmaster: 'var(--cf-gm)',
}

/**
 * CF rating 段位配色（与 Codeforces 官方段位色同色相）。
 * 返回 CSS 变量表达式：亮/暗主题各自校准过对比度，色值定义在 index.css 的 `--cf-*`。
 */
export function difficultyColor(d: number | null | undefined): string {
  return DIFFICULTY_VAR[difficultyTone(d)]
}

/** 平台难度标度 → 展示用的平台名（标度名只在 shared/src/difficulty.ts 定义，这里只做中文名映射） */
const SCALE_PLATFORM_NAME: Record<string, string> = {
  'luogu-2026-06': '洛谷',
  'jisuanke-level-8': '计蒜客',
  'leetcode-tier': '力扣',
  'hydro-1-10': '代码源',
  'atcoder-kenkoooo-irt': 'AtCoder',
  'nowcoder-score': '牛客',
  'icpc-tier': 'ICPC 榜单', // QOJ 题的难度来自 ICPC/CCPC 公开榜单档位（金/银/铜/铁）
}

/**
 * 「平台确实给不出这道题难度」的空态文案（服务端负缓存 difficultyGap 为真时使用）。
 * 与默认的「难度未知」区分开：未知 = 还没查到，这句 = 查过且上游没有 —— 用户据此
 * 知道再点一次回填也不会有结果，而不是一以为是数据没同步。
 *
 * 末尾必须指向手动入口：这类题（已删除/私有/永久未评级/官方 Unrated）永远等不到上游给值，
 * 用户唯一的出路是自己在难度格上填（PATCH /api/problems/:platform/:key/difficulty）。
 */
export const OFFICIAL_NO_DIFFICULTY_TEXT =
  '平台无公开难度（回填已问过上游、上游未给该题评级；一个月内不再重复查询）。点击这一格可手动填写难度'

/**
 * 难度展示：CF 统一标尺数值 + 平台原生档位（题库未入库难度时给空态文案）。
 *
 * `difficulty` 是服务端映射到 CF rating 标尺后的值；`nativeLabel` 传服务端下发的
 * `difficultyLabel`（映射表只在 shared/src/difficulty.ts 一份，前端不再自行换算档位名）。
 * - 数值为空 → `emptyText`（默认「难度未知」），有原生档位也不显示；
 * - 有原生档位且标度有对应平台名 → `1800 · 洛谷 提高`；
 * - 其余（无原生档位、标度未知、cf-rating 的原生标签就是数值本身）→ 只给数值。
 */
export function formatDifficulty(
  difficulty: number | null | undefined,
  nativeLabel?: string | null,
  scale?: string | null,
  emptyText = '难度未知',
): string {
  if (difficulty == null) return emptyText
  const platformName = scale ? SCALE_PLATFORM_NAME[scale] : undefined
  return nativeLabel && platformName ? `${difficulty} · ${platformName} ${nativeLabel}` : String(difficulty)
}

/* ============================================================
   五、AC 率与弱项偏差
   ============================================================ */

/**
 * 百分数展示的唯一格式化入口。
 *
 * 约定：后端 `server/src/analysis/stats.ts` 的 `rate()` 以及由它派生的
 * `acRate` / `avgAcRate` / `gap`（`analysis/weakness.ts`）单位都是**百分数**
 * ——`14.3` 表示 14.3%，`gap` 是百分点差值。因此本函数**只补 '%'、不做比例换算**；
 * 曾出现的缺陷正是消费者误当 0–1 比例再乘 100（显示成 1430% / 4330.0%）。
 * 使用方一律走这里，避免再次各写一份。
 */
export function pct(v: number): string {
  return `${Math.round(v * 10) / 10}%`
}

/** AC 率档位。判断与配色分开，边界由单测覆盖 */
export type RateTone = 'good' | 'fair' | 'poor'

export function rateTone(rate: number): RateTone {
  if (rate >= 55) return 'good'
  if (rate >= 40) return 'fair'
  return 'poor'
}

const RATE_VAR: Record<RateTone, string> = {
  good: TONE_VAR.success,
  fair: TONE_VAR.warning,
  poor: TONE_VAR.danger,
}

/** AC 率文本配色（表格 / 统计用），返回 CSS 变量表达式 */
export function rateColor(rate: number): string {
  return RATE_VAR[rateTone(rate)]
}

/**
 * 弱项标签的 AC 率偏差（百分点，相对自身平均）→ 语义色。
 * 三段式：明显偏弱 / 偏弱 / 不弱。柱长本身已经编码了偏差大小，颜色只做强调，
 * 所以这里只保留 danger/warning/success 三个语义档（不再各写一份 hex）。
 */
export function gapColor(gap: number): string {
  if (gap > 15) return TONE_VAR.danger
  if (gap > 5) return TONE_VAR.warning
  return TONE_VAR.success
}

/* ============================================================
   六、知识点标签散列色
   ============================================================ */

/** 标签散列配色：同一标签永远取同一颜色（分类栏圆点标记用）。固定色板，不跟随主题 */
const TAG_PALETTE = [
  '#86a8ff',
  '#69d7a5',
  '#f2c46d',
  '#ff7b84',
  '#45d5e5',
  '#c080ff',
  '#ffbd61',
  '#58a3ff',
  '#8ee7c0',
  '#f29b66',
]

export function tagColor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_PALETTE[h % TAG_PALETTE.length]
}

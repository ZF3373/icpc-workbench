/**
 * 数值/难度/标签色的格式化与配色（原 ui.ts 第四~六节）。
 * 聚合入口仍是 ui.ts。
 */
import { TONE_VAR } from './uiTokens'

/** 字节数的人类可读格式化（Assistant 的 fmtBytes 与 Settings 的 formatBytes 两份实现精度不一） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
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
  'hydro-1-10': 'Hydro', // 代码源 / DashOJ 同为 Hydro 系，共用 1-10 站内难度标度
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
  // 第三方 clist.by 的「原生值」就是 rating 本身（没有平台档位名），只标来源、不重复数值：
  // 让用户一眼看出这不是平台官方难度（issue #57）
  if (scale === 'clist-rating') return `${difficulty} · clist.by 第三方`
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

/** 标签散列配色：同一标签永远取同一颜色（分类栏圆点标记用）。固定色板，不跟随主题。
 *  含 #9fb8d9（灰蓝）：原 #c080ff 紫在全站去紫时替换（UI 优化方案 §配色收敛），
 *  所有标签颜色 hash 重排一次是已知取舍 */
const TAG_PALETTE = [
  '#86a8ff',
  '#69d7a5',
  '#f2c46d',
  '#ff7b84',
  '#45d5e5',
  '#9fb8d9',
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


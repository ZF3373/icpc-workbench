/**
 * 刷题热力图配色（纯函数 + 常量，node:test 可测）。
 *
 * 为什么单独成文件：四档绿色是**唯一需要按主题各给一套**的图表配色，而
 * "够不够亮、相邻档分不分得开"是可以用 WCAG 相对亮度算出来的客观量，不该
 * 只靠肉眼在截图里判断。抽出来后 client/test/heatmapColors.test.ts 能把
 * "亮度单调 + 相邻档可辨 + 首档与空格可辨"锁成断言，改色时不会悄悄退化。
 *
 * 设计口径（issue #61「颜色更新完后感觉淡淡的」）：
 * - 亮度：按 WCAG 相对亮度近似等距地铺开，平均亮度亮色 0.41、暗色 0.56，
 *   高于修复前的 0.40 / 0.44（亮色那版饱和度只有 8~56%，所以看着发灰）。
 * - 饱和度：低档偏低、高档拉到 90% 上下，靠近 CF 那种"荧光绿"，而不是灰绿。
 * - 可辨性：相邻档对比度实测 ≥ 1.22（亮）/ ≥ 1.37（暗），首档对空格 1.22（亮）
 *   / 4.43（暗）——低于这些值时"今天练了没有""练多练少"就读不出来。
 *   这些值由 client/test/heatmapColors.test.ts 断言，不是随手记的数。
 */

export type HeatmapTheme = 'light' | 'dark'

export interface HeatmapPalette {
  /** 空白天（当天没有 AC）：必须与第一档拉开，否则"没练"和"练了一点"同色 */
  empty: string
  /** 四档实格，index 0 = 最浅（练得最少），3 = 最深（练得最多） */
  levels: readonly [string, string, string, string]
}

export const HEATMAP_PALETTES: Record<HeatmapTheme, HeatmapPalette> = {
  /**
   * 亮色：白卡上用**中高饱和的荧光绿**。上一版把饱和度压到 8~56% 想融入白底，
   * 结果四档挤成一片灰绿，反馈"颜色淡淡的"。这一版每档饱和度递增
   * （41→71→90→93%），最浅档也从灰绿改成能看出"绿"的薄荷绿。
   * 空格用 #f0f0f2（比最浅档淡一档且不带绿味），首档与它的对比度 1.22。
   */
  light: {
    empty: '#f0f0f2',
    levels: ['#8cefb4', '#3ed684', '#12ad62', '#086f40'],
  },
  /**
   * 暗色：深底（#1a1a1d）上继续走高亮荧光绿，并把最浅档从 #166b46 提到 #179f64
   * —— 旧首档相对亮度只有 0.11，和空格（#26262b）的对比度 2.31，几乎糊在一起。
   * 现在首档 0.26、对比度 4.43，最亮档对卡片底 14.4:1。
   */
  dark: {
    empty: '#26262b',
    levels: ['#179f64', '#2fd084', '#55f0a4', '#93ffc5'],
  },
}

export function heatmapPalette(theme: HeatmapTheme): HeatmapPalette {
  return HEATMAP_PALETTES[theme]
}

/** #rrggbb → [r, g, b]；非法输入返回 null（测试与对比度计算用） */
export function parseHexColor(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG 2.x 相对亮度 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHexColor(hex)
  if (!rgb) return Number.NaN
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/** WCAG 2.x 对比度（1~21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

import { PLATFORMS } from '../../shared/src/index.ts'
import type { PlatformId } from '../../shared/src/index.ts'

/**
 * 纯展示层工具：平台主题色 / 难度配色。
 * 只做视觉取值，不涉及任何业务逻辑与 API。
 */

/** 平台展示色（彩色圆点标识用，与后端无关） */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  codeforces: '#3b82f6',
  atcoder: '#f59e0b',
  luogu: '#06b6d4',
  nowcoder: '#10b981',
}

export function platformName(id: PlatformId): string {
  return PLATFORMS.find((p) => p.id === id)?.name ?? id
}

/** CF rating 风格的难度配色（数值越高颜色越"高阶"） */
export function difficultyColor(d: number | null | undefined): string {
  if (d == null) return '#9a9ab0'
  if (d < 1200) return '#9ca3af' // 新手灰
  if (d < 1400) return '#34a853' // pupil 绿
  if (d < 1600) return '#0fb5ae' // specialist 青
  if (d < 1900) return '#3b6ff6' // expert 蓝
  if (d < 2200) return '#a359e0' // candidate master 紫
  if (d < 2400) return '#f59e0b' // master 橙
  return '#ef4444' // grandmaster 红
}

/** AC 率文本配色（表格 / 统计用） */
export function rateColor(rate: number): string {
  if (rate >= 55) return '#10b981'
  if (rate >= 40) return '#f59e0b'
  return '#ef4444'
}

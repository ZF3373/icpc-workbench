import { PLATFORMS } from '../../shared/src/index.ts'
import type { PlatformId } from '../../shared/src/index.ts'

/**
 * 纯展示层工具：平台主题色 / 难度配色。
 * 只做视觉取值，不涉及任何业务逻辑与 API。
 */

/** 平台展示色（彩色圆点标识用，与后端无关；暗色底下的高可读版本） */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  codeforces: '#58a3ff',
  atcoder: '#f2b75b',
  luogu: '#45d5e5',
  nowcoder: '#69d7a5',
}

export function platformName(id: PlatformId): string {
  return PLATFORMS.find((p) => p.id === id)?.name ?? id
}

/** CF rating 段位配色（与 Codeforces 官方段位色一致的暗色底版本） */
export function difficultyColor(d: number | null | undefined): string {
  if (d == null) return '#8993a2'
  if (d < 1200) return '#aab6c2' // new
  if (d < 1400) return '#55d990' // pupil
  if (d < 1600) return '#45d5e5' // specialist
  if (d < 1900) return '#58a3ff' // expert
  if (d < 2100) return '#a887ff' // candidate master
  if (d < 2400) return '#ffbd61' // master
  return '#ff5d70' // grandmaster+
}

/** AC 率文本配色（表格 / 统计用） */
export function rateColor(rate: number): string {
  if (rate >= 55) return '#69d7a5'
  if (rate >= 40) return '#f2c46d'
  return '#ff7b84'
}

/** 标签散列配色：同一标签永远取同一颜色（分类栏圆点标记用） */
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

/**
 * 热力图网格构建（纯函数，node:test 可测）：
 * 把服务端返回的连续日序列排成「周一开头」的周列，并算出月份标签位置。
 */
import dayjs from 'dayjs'
import type { HeatmapDay } from './types'

export interface HeatmapCell {
  date: string
  attempts: number
  ac: number
  solved: number
}

/** null = 窗口起点之前的前导空白（首列对齐周一用），不渲染不交互 */
export type HeatmapGridCell = HeatmapCell | null

export interface HeatmapGrid {
  /** 每列一周，行 0 = 周一；除末列外每列 7 格 */
  weeks: HeatmapGridCell[][]
  /** 月份标签：该列第一个非空格子进入新月份时，在列上方标「N月」 */
  monthLabels: Array<{ col: number; label: string }>
}

export function buildHeatmapGrid(days: HeatmapDay[]): HeatmapGrid {
  if (days.length === 0) return { weeks: [], monthLabels: [] }

  // 首列前导空白：把第一天对齐到周一（dayjs day(): 0=周日 → 周一为行 0）
  const lead = (dayjs(days[0].date).day() + 6) % 7
  const weeks: HeatmapGridCell[][] = []
  let col: HeatmapGridCell[] = new Array(lead).fill(null)
  for (const d of days) {
    col.push({ ...d })
    if (col.length === 7) {
      weeks.push(col)
      col = []
    }
  }
  if (col.length > 0) weeks.push(col)

  const monthLabels: Array<{ col: number; label: string }> = []
  let prevMonth = -1
  weeks.forEach((week, i) => {
    const first = week.find((c): c is HeatmapCell => c !== null)
    if (!first) return
    const m = dayjs(first.date).month()
    if (m !== prevMonth) monthLabels.push({ col: i, label: `${m + 1}月` })
    prevMonth = m
  })

  return { weeks, monthLabels }
}

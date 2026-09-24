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

/**
 * 色阶分档阈值：取非零 AC 题数的四分位数（GitHub 同思路）。
 * 固定阈值（1/2/3-4/5+）在「每天 1~3 题」这类集中分布下大部分格子落在同一档；
 * 按实际数据分位数切档，色阶始终能拉开当前范围的刷题强度差异。
 */
export function solveLevelThresholds(days: HeatmapDay[]): [number, number, number] {
  const values = days
    .map((d) => d.solved)
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  if (values.length === 0) return [1, 2, 3]
  const q = (p: number) => values[Math.floor((values.length - 1) * p)]
  return [q(0.25), q(0.5), q(0.75)]
}

/** 当天 AC 去重题数 → 色阶档位（0=空，1~4 递深），thresholds 需非降序 */
export function levelFor(solved: number, thresholds: [number, number, number]): number {
  if (solved <= 0) return 0
  if (solved <= thresholds[0]) return 1
  if (solved <= thresholds[1]) return 2
  if (solved <= thresholds[2]) return 3
  return 4
}

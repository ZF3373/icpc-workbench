/**
 * buildHeatmapGrid 纯函数单元测试（node:test 运行）。
 * 覆盖：空输入、首列周一对齐（前导空白）、周列切分、跨月月份标签、格子数据透传。
 * 测试日期锚定 2026-09-24（周四）前后，星期几是确定的。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import { buildHeatmapGrid, levelFor, solveLevelThresholds } from '../src/heatmapGrid.ts'
import type { HeatmapDay } from '../src/types.ts'

const day = (date: string, solved = 0): HeatmapDay => ({ date, attempts: solved + 1, ac: solved, solved })

/** 从 from 起连续 n 天的日序列 */
const range = (from: string, n: number): HeatmapDay[] =>
  Array.from({ length: n }, (_, i) => day(dayjs(from).add(i, 'day').format('YYYY-MM-DD'), i))

describe('buildHeatmapGrid', () => {
  it('returns empty grid for empty input', () => {
    assert.deepEqual(buildHeatmapGrid([]), { weeks: [], monthLabels: [] })
  })

  it('pads the first column with leading nulls to align Monday', () => {
    // 2026-09-24 是周四：前导 3 格空白（周一/二/三）
    const g = buildHeatmapGrid(range('2026-09-24', 7))
    assert.equal(g.weeks.length, 2)
    const first = g.weeks[0]
    assert.deepEqual(first.slice(0, 3), [null, null, null])
    assert.equal(first[3]?.date, '2026-09-24')
    // 3 + 7 = 10 格 → 首列满 7，余 3 格落末列
    assert.equal(first.length, 7)
    assert.deepEqual(
      g.weeks[1].map((c) => c?.date),
      ['2026-09-28', '2026-09-29', '2026-09-30'],
    )
  })

  it('starts labels and chunks full weeks from a Monday', () => {
    // 2026-09-21 是周一：无前导空白，21 天恰好 3 整列
    const g = buildHeatmapGrid(range('2026-09-21', 21))
    assert.equal(g.weeks.length, 3)
    assert.ok(g.weeks.every((w) => w.length === 7))
    assert.equal(g.weeks[0][0]?.date, '2026-09-21')
    assert.deepEqual(g.monthLabels[0], { col: 0, label: '9月' })
  })

  it('labels a column only when it enters a new month', () => {
    // 09-21（周一）起 21 天 → 10-11：col0/col1 都是 9 月开头，col2 才进 10 月
    const g = buildHeatmapGrid(range('2026-09-21', 21))
    assert.deepEqual(g.monthLabels, [
      { col: 0, label: '9月' },
      { col: 2, label: '10月' },
    ])
  })

  it('carries per-day data through to cells', () => {
    const g = buildHeatmapGrid([day('2026-09-24', 3)])
    const cell = g.weeks[0][3]
    assert.equal(cell?.solved, 3)
    assert.equal(cell?.attempts, 4)
    assert.equal(cell?.ac, 3)
  })
})

describe('solveLevelThresholds / levelFor', () => {
  it('falls back to [1,2,3] when there is no active day', () => {
    assert.deepEqual(solveLevelThresholds([]), [1, 2, 3])
    assert.deepEqual(solveLevelThresholds([day('2026-09-24', 0)]), [1, 2, 3])
    assert.equal(levelFor(0, [1, 2, 3]), 0)
  })

  it('quantiles split the actual distribution so levels stay distinguishable', () => {
    // 集中分布 1~3 题（固定阈值下会挤在同一档）
    const days = [1, 1, 1, 2, 2, 3].map((s, i) => day(`2026-09-1${i}`, s))
    const t = solveLevelThresholds(days)
    assert.deepEqual(t, [1, 1, 2])
    assert.equal(levelFor(1, t), 1)
    assert.equal(levelFor(2, t), 3)
    assert.equal(levelFor(3, t), 4)
  })

  it('wider spread yields monotonic thresholds across all levels', () => {
    const days = [1, 2, 3, 4, 5, 6, 7, 8].map((s, i) => day(`2026-09-1${i}`, s))
    const t = solveLevelThresholds(days)
    assert.deepEqual(t, [2, 4, 6])
    // 阈值边界落在较浅一档（<= 分档）
    assert.equal(levelFor(1, t), 1)
    assert.equal(levelFor(2, t), 1)
    assert.equal(levelFor(3, t), 2)
    assert.equal(levelFor(4, t), 2)
    assert.equal(levelFor(5, t), 3)
    assert.equal(levelFor(6, t), 3)
    assert.equal(levelFor(7, t), 4)
  })
})

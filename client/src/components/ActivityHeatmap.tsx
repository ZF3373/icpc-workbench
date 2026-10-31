/**
 * 刷题热力图（GitHub contributions 风格）：
 * 周列 × 7 行格子，格子深浅 = 当天 AC 去重题数。分档阈值取非零日四分位数
 * （solveLevelThresholds），避免「每天 1~3 题」的集中分布挤在同一档；
 * 实格用 GitHub 同款四档绿色板（深/浅主题各一套），相邻档可分辨。
 * 格子尺寸随卡片宽度自适应（8~24px）尽量铺满，短范围整体居中。
 * 纯 CSS grid 实现，零新依赖。
 */
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Card, Empty, Segmented, Spin, Tooltip } from 'antd'
import { IconGrip } from './icons'
import dayjs from 'dayjs'
import { get } from '../api'
import type { AccountScope } from '../accountScope'
import { withScope } from '../accountScope'
import { useTheme } from '../themeCore'
import type { HeatmapResult } from '../types'
import { buildHeatmapGrid, levelFor, solveLevelThresholds, type HeatmapCell } from '../heatmapGrid'

const RANGES = [
  { label: '近3月', days: 90 },
  { label: '近半年', days: 183 },
  { label: '近1年', days: 365 },
] as const

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
/** 左侧星期标注：GitHub 同款只标一/三/五（行 0 = 周一） */
const WEEKDAY_LABELS: Record<number, string> = { 0: '一', 2: '三', 4: '五' }
/** 星期标注列宽 26px + 右距 4px */
const LABEL_COL = 30
const GAP = 3
const CELL_MIN = 8
const CELL_MAX = 24

/**
 * 实格四档配色（浅→深）；空格用主题 colorBorderSecondary。
 *
 * 亮色主题走**低饱和灰绿**：极简扁平化下热力图是唯一保留的彩色图表，
 * 但饱和度压到与白底融为一体的程度（色相 150° 左右，明度阶梯均匀），
 * 让"哪几天在练"的密度信息比颜色本身更突出；暗色保持 GitHub 同款亮绿。
 */
const LEVEL_COLORS = {
  /**
   * 亮色四档：低饱和灰绿，刻意**拉大深浅跨度**（明度从 0.92 一路压到 0.19），
   * 让"每天练了多少"一眼可辨 —— 旧版四档都挤在浅灰绿区间里，几乎分不出来。
   */
  light: ['#cfe2d6', '#9dc4ad', '#5f9678', '#2f6b4f'],
  /**
   * 暗色四档：**霓虹绿**。深底上低饱和绿会糊成一团，所以改用高饱和、高亮度的
   * 亮绿阶梯（明度 0.056 → 0.811，相邻档对比 ≥ 1.39:1，最亮档对卡片底 14.2:1）。
   * 第一档刻意压到很暗，与空格（--heatmap-empty #26262b）明确分开。
   */
  dark: ['#166b46', '#22a866', '#45dd97', '#8bffc6'],
} as const

function cellTitle(c: HeatmapCell): string {
  const wk = `周${WEEKDAY_NAMES[dayjs(c.date).day()]}`
  if (c.attempts === 0) return `${c.date} ${wk} · 无提交`
  return `${c.date} ${wk} · AC ${c.solved} 题 / 提交 ${c.attempts} 次`
}

export default function ActivityHeatmap({
  refreshKey = 0,
  scope,
  draggable,
}: {
  refreshKey?: number
  /** 账号视角（多账号统计隔离）：省略 = 全部账号 */
  scope?: AccountScope
  /** 数据概览模块拖拽：由 Dashboard 传入，把手渲染在标题前，mousedown 上抛 */
  draggable?: { onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void }
}) {
  const [days, setDays] = useState<number>(365)
  const [data, setData] = useState<HeatmapResult | null>(null)
  const [loading, setLoading] = useState(true)
  const { resolved } = useTheme()

  useEffect(() => {
    let alive = true
    setLoading(true)
    get<HeatmapResult>(withScope(`/api/stats/heatmap?days=${days}`, scope ?? {}))
      .then((r) => {
        if (alive) setData(r)
      })
      .catch((e: Error) => console.error(e))
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [days, refreshKey, scope])

  const grid = useMemo(() => buildHeatmapGrid(data?.days ?? []), [data])
  const thresholds = useMemo(() => solveLevelThresholds(data?.days ?? []), [data])

  // 格子尺寸自适应：观察内容区宽度，列数铺满可用宽度；上限 CELL_MAX，
  // 短范围（如近3月）算出的尺寸会顶到上限，由外层 fit-content + margin auto 居中。
  // 用 callback ref：观察目标在 loading 结束后才挂载，effect 只跑一次会扑空
  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null)
  const [plotWidth, setPlotWidth] = useState(0)
  useEffect(() => {
    if (!plotEl) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setPlotWidth(w)
    })
    ro.observe(plotEl)
    return () => ro.disconnect()
  }, [plotEl])

  const cell = useMemo(() => {
    const weeks = Math.max(grid.weeks.length, 1)
    if (plotWidth <= LABEL_COL) return CELL_MIN
    const avail = plotWidth - LABEL_COL - (weeks - 1) * GAP
    return Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor(avail / weeks)))
  }, [plotWidth, grid.weeks.length])

  const step = cell + GAP
  /* 热力方格统一小圆角：按格子尺寸取 1/5，下限 3px、上限 5px ——
     格子放大时不至于变成圆片，缩小时仍读得出"方块" */
  const radius = Math.max(3, Math.min(5, Math.round(cell / 5)))
  /**
   * 空格配色：必须比第一档绿**明显更淡/更暗**，否则"没练"和"练了一点"分不开。
   * 走 --heatmap-empty 这个语义 Token 而不是 antd 的 colorFillQuaternary ——
   * 后者在亮色下是 2% 黑，叠在白卡上几乎不可见，格子会像"掉了一块"。
   */
  const emptyColor = resolved === 'dark' ? '#26262b' : '#f0f0f2'
  const filledColors = LEVEL_COLORS[resolved]
  const cellColor = (solved: number) =>
    solved <= 0 ? emptyColor : filledColors[levelFor(solved, thresholds) - 1]

  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? ''

  return (
    <Card
      title={
        <>
          <IconGrip size={14} className="module-drag-handle" />
          刷题热力图
        </>
      }
      size="small"
      onMouseDown={draggable?.onMouseDown}
      extra={
        <Segmented
          size="small"
          value={days}
          onChange={(v) => setDays(v as number)}
          options={RANGES.map((r) => ({ label: r.label, value: r.days }))}
        />
      }
    >
      {loading ? (
        <Spin style={{ display: 'block', margin: '48px auto' }} />
      ) : !data || data.totalAttempts === 0 ? (
        <Empty description="所选范围内没有提交记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <>
          <div className="heatmap-summary">
            {rangeLabel}
            {rangeLabel ? '共 ' : ''}
            AC <strong>{data.totalSolved}</strong> 题 · 提交 <strong>{data.totalAttempts}</strong> 次
          </div>
          <div ref={setPlotEl} style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ width: 'fit-content', margin: '0 auto' }}>
              {/* 月份标签行 + 图例同处一行：左边是时间刻度，右边是"少→多"色阶。
                  两者同一基线（height 14 / line-height 14），视觉上是一条完整的表头。 */}
              <div className="heatmap-head" style={{ display: 'flex', alignItems: 'center', gap: 12, height: 14 }}>
                <div
                  className="heatmap-months"
                  style={{ position: 'relative', flex: '1 1 auto', height: 14, marginLeft: LABEL_COL }}
                >
                  {grid.monthLabels.map((m) => (
                    <span
                      key={`${m.col}-${m.label}`}
                      style={{
                        position: 'absolute',
                        left: m.col * step,
                        top: 0,
                        /* 月份标签压缩到 10px：它只是"时间刻度"，不该与数据争字号 */
                        fontSize: 10,
                        fontWeight: 500,
                        lineHeight: '14px',
                        letterSpacing: '0.04em',
                        color: 'var(--text-3)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
                {/* 图例：与月份行对齐（同一行的右端），方格与热力图同样是小圆角 */}
                <div
                  className="heatmap-legend"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flex: '0 0 auto',
                    gap: 4,
                    fontSize: 10,
                    fontWeight: 500,
                    lineHeight: '14px',
                    letterSpacing: '0.04em',
                    color: 'var(--text-3)',
                  }}
                >
                  <span>少</span>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: emptyColor }} />
                  {filledColors.map((c) => (
                    <span key={c} style={{ width: 11, height: 11, borderRadius: 3, background: c }} />
                  ))}
                  <span>多</span>
                </div>
              </div>
              <div style={{ display: 'flex' }}>
                {/* 星期标注列 */}
                <div
                  style={{
                    width: 26,
                    display: 'grid',
                    gridTemplateRows: `repeat(7, ${cell}px)`,
                    gap: GAP,
                    marginRight: 4,
                  }}
                >
                  {Array.from({ length: 7 }).map((_, row) => (
                    <span
                      key={row}
                      style={{ fontSize: 10, lineHeight: `${cell}px`, color: 'var(--text-3)' }}
                    >
                      {WEEKDAY_LABELS[row] ?? ''}
                    </span>
                  ))}
                </div>
                {/* 格子：grid-auto-flow=column，每列一周、行 0 = 周一 */}
                <div
                  style={{
                    display: 'inline-grid',
                    gridTemplateRows: `repeat(7, ${cell}px)`,
                    gridAutoFlow: 'column',
                    gridAutoColumns: `${cell}px`,
                    gap: GAP,
                  }}
                >
                  {grid.weeks.flatMap((week, ci) =>
                    week.map((c, ri) =>
                      c ? (
                        <Tooltip key={c.date} title={cellTitle(c)}>
                          <div
                            style={{
                              width: cell,
                              height: cell,
                              borderRadius: radius,
                              background: cellColor(c.solved),
                            }}
                          />
                        </Tooltip>
                      ) : (
                        <div key={`empty-${ci}-${ri}`} />
                      ),
                    ),
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

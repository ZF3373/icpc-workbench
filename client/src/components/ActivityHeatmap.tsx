/**
 * 刷题热力图（GitHub contributions 风格）：
 * 周列 × 7 行格子，格子深浅 = 当天 AC 去重题数。分档阈值取非零日四分位数
 * （solveLevelThresholds），避免「每天 1~3 题」的集中分布挤在同一档；
 * 实格四档绿色板见 heatmapColors.ts（深/浅主题各一套），相邻档可分辨。
 * 格子尺寸随卡片宽度自适应（8~20px）尽量铺满，短范围整体居中。
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
import { heatmapPalette } from '../heatmapColors'

const RANGES = [
  { label: '近3月', days: 90 },
  { label: '近半年', days: 183 },
  { label: '近1年', days: 365 },
] as const

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
/** 左侧星期标注：GitHub 同款只标一/三/五（行 0 = 周一） */
const WEEKDAY_LABELS: Record<number, string> = { 0: '一', 2: '三', 4: '五' }
/** 星期标注列宽 22px + 右距 4px（紧凑版收窄 4px） */
const LABEL_COL = 26
const GAP = 3
const CELL_MIN = 8
const CELL_MAX = 20

/* 四档配色与空格色统一由 heatmapColors.ts 提供（含可测的亮度/对比度口径） */

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
   * 用调色板自带的 empty 而不是 antd 的 colorFillQuaternary —— 后者在亮色下
   * 是 2% 黑，叠在白卡上几乎不可见，格子会像"掉了一块"。
   * 与 heatmapColors.ts 里四档同源，改色只需改那一处。
   */
  const palette = heatmapPalette(resolved)
  const emptyColor = palette.empty
  const filledColors = palette.levels
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
            <span>
              {rangeLabel}
              {rangeLabel ? '共 ' : ''}
              AC <strong>{data.totalSolved}</strong> 题 · 提交 <strong>{data.totalAttempts}</strong> 次
            </span>
            {/* 色阶图例挂到摘要行右端：原先挂在月份轴那一行，而月份标签是绝对定位的，
                末尾的「10月/11月」会被图例压住 —— 两段文字抢同一段宽度 */}
            <span
              className="heatmap-legend"
              style={{
                display: 'flex',
                alignItems: 'center',
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
            </span>
          </div>
          <div ref={setPlotEl} style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ width: 'fit-content', margin: '0 auto' }}>
              {/* 月份标签行：只放时间刻度，整行宽度留给月份标签（图例已上移到摘要行右端） */}
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

/**
 * 刷题热力图（GitHub contributions 风格）：
 * 周列 × 7 行格子，格子深浅 = 当天 AC 去重题数。分档阈值取非零日四分位数
 * （solveLevelThresholds），避免「每天 1~3 题」的集中分布挤在同一档；
 * 实格用 GitHub 同款四档绿色板（深/浅主题各一套），相邻档可分辨。
 * 格子尺寸随卡片宽度自适应（8~24px）尽量铺满，短范围整体居中。
 * 纯 CSS grid 实现，零新依赖。
 */
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Card, Empty, Segmented, Spin, Tooltip, theme } from 'antd'
import { HolderOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { get } from '../api'
import { useTheme } from '../themeContext'
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

/** 实格四档配色（浅→深，GitHub 贡献图同款）；空格用主题 colorBorderSecondary */
const LEVEL_COLORS = {
  light: ['#9be9a8', '#40c463', '#30a14e', '#216e39'],
  dark: ['#0e4429', '#006d32', '#26a641', '#39d353'],
} as const

function cellTitle(c: HeatmapCell): string {
  const wk = `周${WEEKDAY_NAMES[dayjs(c.date).day()]}`
  if (c.attempts === 0) return `${c.date} ${wk} · 无提交`
  return `${c.date} ${wk} · AC ${c.solved} 题 / 提交 ${c.attempts} 次`
}

export default function ActivityHeatmap({
  refreshKey = 0,
  draggable,
}: {
  refreshKey?: number
  /** 数据概览模块拖拽：由 Dashboard 传入，把手渲染在标题前，mousedown 上抛 */
  draggable?: { onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void }
}) {
  const [days, setDays] = useState<number>(365)
  const [data, setData] = useState<HeatmapResult | null>(null)
  const [loading, setLoading] = useState(true)
  const { resolved } = useTheme()
  const { token } = theme.useToken()

  useEffect(() => {
    let alive = true
    setLoading(true)
    get<HeatmapResult>(`/api/stats/heatmap?days=${days}`)
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
  }, [days, refreshKey])

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
  const radius = Math.max(3, Math.round(cell / 4))
  const emptyColor = token.colorBorderSecondary
  const filledColors = LEVEL_COLORS[resolved]
  const cellColor = (solved: number) =>
    solved <= 0 ? emptyColor : filledColors[levelFor(solved, thresholds) - 1]

  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? ''

  return (
    <Card
      title={
        <>
          <HolderOutlined className="module-drag-handle" />
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
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>
            {rangeLabel}
            {rangeLabel ? '共 ' : ''}
            AC <strong style={{ color: 'var(--green)' }}>{data.totalSolved}</strong> 题 · 提交{' '}
            <strong>{data.totalAttempts}</strong> 次
          </div>
          <div ref={setPlotEl} style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ width: 'fit-content', margin: '0 auto' }}>
              {/* 月份标签行（绝对定位到对应周列上方） */}
              <div style={{ position: 'relative', height: 16, marginLeft: LABEL_COL }}>
                {grid.monthLabels.map((m) => (
                  <span
                    key={`${m.col}-${m.label}`}
                    style={{
                      position: 'absolute',
                      left: m.col * step,
                      top: 0,
                      fontSize: 11,
                      lineHeight: '16px',
                      color: 'var(--text-3)',
                    }}
                  >
                    {m.label}
                  </span>
                ))}
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
              {/* 图例 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 4,
                  marginTop: 6,
                  fontSize: 11,
                  color: 'var(--text-3)',
                }}
              >
                <span>少</span>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: emptyColor }} />
                {filledColors.map((c) => (
                  <span key={c} style={{ width: 12, height: 12, borderRadius: 3, background: c }} />
                ))}
                <span>多</span>
              </div>
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

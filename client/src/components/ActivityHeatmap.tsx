/**
 * 刷题热力图（GitHub contributions 风格）：
 * 周列 × 7 行格子，格子深浅 = 当天 AC 去重题数（0/1/2/3-4/≥5 五档），
 * 悬停显示「日期 · AC N 题 / 提交 M 次」。纯 CSS grid 实现，零新依赖；
 * 色阶从主题 token（colorSuccess）生成，深浅色主题自动适配。
 */
import { useEffect, useMemo, useState } from 'react'
import { Card, Empty, Segmented, Spin, Tooltip, theme } from 'antd'
import dayjs from 'dayjs'
import { get } from '../api'
import type { HeatmapResult } from '../types'
import { buildHeatmapGrid, type HeatmapCell } from '../heatmapGrid'

const RANGES = [
  { label: '近3月', days: 90 },
  { label: '近半年', days: 183 },
  { label: '近1年', days: 365 },
] as const

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
/** 左侧星期标注：GitHub 同款只标一/三/五（行 0 = 周一） */
const WEEKDAY_LABELS: Record<number, string> = { 0: '一', 2: '三', 4: '五' }
const CELL = 12
const GAP = 3
const STEP = CELL + GAP

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** 色阶阈值（solved = 当天 AC 去重题数） */
function levelOf(solved: number): number {
  if (solved <= 0) return 0
  if (solved === 1) return 1
  if (solved === 2) return 2
  if (solved <= 4) return 3
  return 4
}

function cellTitle(c: HeatmapCell): string {
  const wk = `周${WEEKDAY_NAMES[dayjs(c.date).day()]}`
  if (c.attempts === 0) return `${c.date} ${wk} · 无提交`
  return `${c.date} ${wk} · AC ${c.solved} 题 / 提交 ${c.attempts} 次`
}

export default function ActivityHeatmap({ refreshKey = 0 }: { refreshKey?: number }) {
  const [days, setDays] = useState<number>(365)
  const [data, setData] = useState<HeatmapResult | null>(null)
  const [loading, setLoading] = useState(true)
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

  const levelColors = [
    token.colorBorderSecondary,
    hexToRgba(token.colorSuccess, 0.35),
    hexToRgba(token.colorSuccess, 0.55),
    hexToRgba(token.colorSuccess, 0.75),
    token.colorSuccess,
  ]

  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? ''

  return (
    <Card
      title="刷题热力图"
      size="small"
      style={{ marginTop: 16 }}
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
          <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ display: 'inline-block' }}>
              {/* 月份标签行（绝对定位到对应周列上方） */}
              <div style={{ position: 'relative', height: 16, marginLeft: 30 }}>
                {grid.monthLabels.map((m) => (
                  <span
                    key={`${m.col}-${m.label}`}
                    style={{
                      position: 'absolute',
                      left: m.col * STEP,
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
                    gridTemplateRows: `repeat(7, ${CELL}px)`,
                    gap: GAP,
                    marginRight: 4,
                  }}
                >
                  {Array.from({ length: 7 }).map((_, row) => (
                    <span
                      key={row}
                      style={{ fontSize: 10, lineHeight: `${CELL}px`, color: 'var(--text-3)' }}
                    >
                      {WEEKDAY_LABELS[row] ?? ''}
                    </span>
                  ))}
                </div>
                {/* 格子：grid-auto-flow=column，每列一周、行 0 = 周一 */}
                <div
                  style={{
                    display: 'inline-grid',
                    gridTemplateRows: `repeat(7, ${CELL}px)`,
                    gridAutoFlow: 'column',
                    gridAutoColumns: `${CELL}px`,
                    gap: GAP,
                  }}
                >
                  {grid.weeks.flatMap((week, ci) =>
                    week.map((cell, ri) =>
                      cell ? (
                        <Tooltip key={cell.date} title={cellTitle(cell)}>
                          <div
                            style={{
                              width: CELL,
                              height: CELL,
                              borderRadius: 3,
                              background: levelColors[levelOf(cell.solved)],
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
                {levelColors.map((c) => (
                  <span
                    key={c}
                    style={{ width: CELL, height: CELL, borderRadius: 3, background: c }}
                  />
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

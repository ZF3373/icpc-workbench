import type { ReactNode } from 'react'

export type StatTone = 'blue' | 'green' | 'amber' | 'violet'

export interface StatStripItem {
  label: string
  value: ReactNode
  icon: ReactNode
  tone: StatTone
}

/** cf-compass 风格统计带：单卡多格 + 竖线分隔 + 彩色图标块（仪表盘 / 日历共用） */
export default function StatStrip({ items }: { items: StatStripItem[] }) {
  return (
    <div className="stats-strip">
      {items.map((it) => (
        <div className="stat-item" key={it.label}>
          <span className={`stat-strip-icon stat-icon-${it.tone}`}>{it.icon}</span>
          <div className="stat-text">
            <span className="stat-label">{it.label}</span>
            <strong>{it.value}</strong>
          </div>
        </div>
      ))}
    </div>
  )
}

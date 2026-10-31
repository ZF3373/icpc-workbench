import type { ReactNode } from 'react'

export type StatTone = 'blue' | 'green' | 'amber' | 'violet' | 'cyan'

/**
 * 数值的语义色调（亮色极简版新增）：颜色只给"关键数据"用，不是装饰。
 * - core    核心强调（总提交等最重要的那个数）→ 品牌蓝
 * - positive正向（AC 率、已解题目、健康度）   → 低饱和绿
 * - warn    警示（补强缺口、待处理）           → 柔和橙
 * - neutral 普通统计（活跃平台数等）           → 深黑
 */
export type StatValueTone = 'core' | 'positive' | 'warn' | 'neutral'

export interface StatStripItem {
  label: string
  value: ReactNode
  icon: ReactNode
  tone: StatTone
  /** 数值配色，省略 = neutral（深黑） */
  valueTone?: StatValueTone
  /** 数值旁的语义徽章（如「+2.1%」「-3.4」），只在真的需要解读时给 */
  badge?: ReactNode
}

/**
 * 统计带：仪表盘 / 日历 / 模板库共用。
 * 亮色极简版把它渲染成一组独立白卡（见 index.css 的 .stats-strip 覆盖），
 * 数值按 valueTone 着色 —— 这是全页唯一的"用颜色读数据"的地方。
 */
export default function StatStrip({ items }: { items: StatStripItem[] }) {
  return (
    <div className="stats-strip">
      {items.map((it) => (
        <div className="stat-item" key={it.label} data-value-tone={it.valueTone ?? 'neutral'}>
          <span className={`stat-strip-icon stat-icon-${it.tone}`}>{it.icon}</span>
          <div className="stat-text">
            <span className="stat-label">{it.label}</span>
            <span className="stat-value-row">
              <strong>{it.value}</strong>
              {it.badge && <span className="stat-badge">{it.badge}</span>}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

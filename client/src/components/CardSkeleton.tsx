import { Skeleton } from 'antd'
import type { ReactNode } from 'react'

/**
 * 卡片级骨架屏：卡片内部局部加载用（模块卡片、复习库批次、题单摘要等）。
 *
 * 与 PageSkeleton 的分工：PageSkeleton 占「整页结构」，本组件占「单张卡的内容」。
 * 页面已有数据、只是某块在重新取数时用它，避免整页退回 Spin。
 */

export interface CardSkeletonProps {
  /** 内容形态：图表卡用 chart（大块留白），列表卡用 list，表格卡用 table */
  variant?: 'chart' | 'list' | 'table'
  /** chart 变体的占位高度 */
  height?: number
  /** list / table 变体的行数 */
  rows?: number
  /** 卡片标题占位；传 null 表示内容上方没有标题（如卡片自身已有 antd Card title） */
  title?: ReactNode | null
}

export default function CardSkeleton({
  variant = 'chart',
  height = 240,
  rows = 4,
  title = null,
}: CardSkeletonProps) {
  return (
    <div className="card-skeleton" aria-busy="true">
      {title}
      {variant === 'chart' && <div style={{ height }} />}
      {variant === 'list' && (
        <div className="card-skeleton-list">
          {Array.from({ length: rows }, (_, i) => (
            <div className="card-skeleton-row" key={i}>
              <Skeleton.Avatar active shape="square" size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Skeleton.Input active size="small" style={{ width: `${64 - (i % 3) * 8}%`, height: 13 }} />
              </div>
            </div>
          ))}
        </div>
      )}
      {variant === 'table' && <Skeleton active title={false} paragraph={{ rows, width: '100%' }} />}
    </div>
  )
}

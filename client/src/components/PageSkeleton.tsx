import { Skeleton } from 'antd'

/**
 * 页面级骨架屏：模拟「统计带 → 卡片行 → 表格/图表」三段结构。
 *
 * 为什么不用 `<Spin size="large" />`：全站居中 Spin 会把整页清空成一个转圈，
 * 首屏从「白屏 + 转圈」跳到「完整页面」时布局整体位移（CLS），等待感也更强。
 * 骨架屏提前占住真实结构的尺寸，数据落地时只有内容变化、没有布局跳动。
 *
 * 用法：页面在 `loading` 且尚无任何数据时渲染 `<PageSkeleton />`；已有数据后的
 * 局部刷新用 `<CardSkeleton />`（见同目录 CardSkeleton.tsx）。
 */

export interface PageSkeletonProps {
  /** 是否渲染顶部统计带占位（Dashboard / 日历等有统计带的页面） */
  stats?: boolean
  /** 主体占位块的高度，默认 280（图表卡高度） */
  blockHeight?: number
  /** 主体占位块的数量，默认 2（并排两张卡） */
  blocks?: number
  /** 是否渲染表格占位（题目管理 / 题单等列表页） */
  table?: boolean
  /** 表格占位行数 */
  rows?: number
}

export default function PageSkeleton({
  stats = true,
  blockHeight = 280,
  blocks = 2,
  table = false,
  rows = 6,
}: PageSkeletonProps) {
  const count = Math.max(1, blocks)
  return (
    <div className="page-skeleton" aria-busy="true" aria-live="polite">
      {/* 页头：标题 + 描述 + 右侧操作 */}
      <div className="page-skeleton-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Skeleton.Input active size="default" style={{ width: 180, height: 30 }} />
          <Skeleton.Input active size="small" style={{ width: 300, marginTop: 10, display: 'block' }} />
        </div>
        <Skeleton.Button active size="default" style={{ width: 120 }} />
      </div>

      {stats && (
        <div className="page-skeleton-strip">
          {Array.from({ length: 4 }, (_, i) => (
            <div className="page-skeleton-strip-cell" key={i}>
              <Skeleton.Avatar active shape="square" size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Skeleton.Input active size="small" style={{ width: 52, height: 12 }} />
                <Skeleton.Input active size="small" style={{ width: 76, height: 18, marginTop: 6, display: 'block' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {table ? (
        <div className="page-skeleton-block">
          <Skeleton active title={false} paragraph={{ rows, width: '100%' }} />
        </div>
      ) : (
        <div className="page-skeleton-grid">
          {Array.from({ length: count }, (_, i) => (
            <div className="page-skeleton-block" key={i}>
              <Skeleton.Input active size="small" style={{ width: 140, height: 16 }} />
              <div style={{ height: blockHeight - 46 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

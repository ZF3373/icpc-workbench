import { Button, Space } from 'antd'
import { CheckOutlined, DeleteOutlined, ReadOutlined } from '@ant-design/icons'

/**
 * 题目管理 · 批量操作条（UI 优化方案 §5.2 / P3-1）。
 *
 * 为什么单独抽一个组件：这条操作条是「纯展示 + 回调」，批量执行的重活（逐题串行请求、
 * 失败计数、清空选择、刷新列表）全部留在 `Problems.tsx` 里 —— 组件本身不认识题目数据，
 * 也就不可能悄悄发明新的后端接口，或与单条操作走出两套语义。
 *
 * 为什么按钮长这样：
 * - 「标记 AC / 加入复习队列」是高频、可批量、语义明确的操作；
 * - 「删除」是危险且不可逆的（服务端连带删提交与复习条目），用 `danger` 与其它按钮分开，
 *   二次确认由调用方（Modal.confirm）负责，这里只负责把动作抛出去；
 * - 「知识点 / 卡在哪」逐题语境强（要选知识点、要选卡点类型），批量做没有意义，故不入栏。
 *
 * 条本身 sticky：翻到表格下半屏时批量动作仍然可点，不用滚回表格顶部。
 */

export interface ProblemBatchActionsProps {
  /** 已选题目数（跨页保留的选择也算，由调用方给出） */
  count: number
  onMarkAc: () => void
  onAddToReview: () => void
  onDelete: () => void
  /** 取消选择（清空 selectedRowKeys） */
  onClear: () => void
  /** 批量执行中：禁用全部按钮，避免连点重复提交 */
  busy?: boolean
}

export default function ProblemBatchActions({
  count,
  onMarkAc,
  onAddToReview,
  onDelete,
  onClear,
  busy = false,
}: ProblemBatchActionsProps) {
  return (
    <div
      role="region"
      aria-label="批量操作"
      style={{
        position: 'sticky',
        top: 8,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
        background: 'var(--surface-2)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '8px 12px',
        marginBottom: 12,
      }}
    >
      <span style={{ fontSize: 13 }}>
        已选 <strong>{count}</strong> 题
      </span>
      <Space size={8} wrap>
        <Button size="small" icon={<CheckOutlined />} disabled={busy} onClick={onMarkAc}>
          标记 AC
        </Button>
        <Button size="small" icon={<ReadOutlined />} disabled={busy} onClick={onAddToReview}>
          加入复习队列
        </Button>
        <Button size="small" danger icon={<DeleteOutlined />} disabled={busy} onClick={onDelete}>
          删除
        </Button>
        <Button size="small" type="text" disabled={busy} onClick={onClear}>
          取消选择
        </Button>
      </Space>
    </div>
  )
}

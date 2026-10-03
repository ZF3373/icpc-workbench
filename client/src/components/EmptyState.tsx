import type { ReactNode } from 'react'
import { Button } from 'antd'

/**
 * 统一空态：标题 + 说明 + **至少一个下一步操作**。
 *
 * 约定的硬性要求（UI 优化方案 §6.3 / §9.1）：所有空态都必须给出下一步能做什么。
 * 旧实现大量使用 `<Empty description="暂无数据" />`，用户看到的是结论而不是出路；
 * 也有「去设置绑定账号」这类纯文字指引，要用户自己去侧边栏找「设置」。
 *
 * 因此本组件把 `action` 提升为语义核心：调用方要么给一个跳转按钮，要么给一个
 * 重新加载/新建按钮，`description` 只负责解释「为什么是空的」。
 */

export interface EmptyStateAction {
  label: string
  onClick: () => void
  /** 主操作用 primary；次要动作用 default */
  type?: 'primary' | 'default'
  icon?: ReactNode
}

export interface EmptyStateProps {
  /** 一句话结论，如「暂无刷题数据」 */
  title: string
  /** 解释原因与下一步，如「绑定平台账号后点右上角『同步数据』即可」 */
  description?: ReactNode
  /** 下一步操作：单个按钮 */
  action?: EmptyStateAction
  /** 多个操作（主操作放第一个） */
  actions?: EmptyStateAction[]
  icon?: ReactNode
  /** 上下留白，默认 40 */
  padding?: number
  /** 紧凑模式：用于卡片内 / 表格 empty 插槽 */
  compact?: boolean
}

export default function EmptyState({
  title,
  description,
  action,
  actions,
  icon,
  padding = 40,
  compact = false,
}: EmptyStateProps) {
  const list = actions ?? (action ? [action] : [])
  return (
    <div
      className={`empty-state${compact ? ' is-compact' : ''}`}
      style={{ padding: `${compact ? 20 : padding}px 16px` }}
    >
      {icon && <div className="empty-state-icon">{icon}</div>}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-desc">{description}</div>}
      {list.length > 0 && (
        <div className="empty-state-actions">
          {list.map((a) => (
            <Button key={a.label} type={a.type ?? 'default'} icon={a.icon} onClick={a.onClick}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

import { Button } from 'antd'
import { ReloadOutlined, WarningOutlined } from '@ant-design/icons'

/**
 * 局部错误 + 重试。
 *
 * 与空态严格区分：**加载失败 ≠ 没有数据**。曾出现的缺陷正是两者合并成同一个空态，
 * 结果「弱项统计超时」被渲染成「你还没绑定账号 —— 去绑定吧」，有数千条提交的用户
 * 被告知没有数据，屏幕上也没有任何报错。凡是可能失败的局部（表格、图表、抽屉内容）
 * 都用本组件，把失败原因与重试按钮一起交给用户。
 */

export interface InlineErrorProps {
  /** 失败原因（通常是接口返回的 message） */
  message: string
  /** 补一句「这块本来应该显示什么」，帮助用户判断影响范围 */
  hint?: string
  /** 重试回调；不传则不渲染重试按钮 */
  onRetry?: () => void
  /** 重试中：按钮进 loading，避免连点 */
  retrying?: boolean
  /** 紧凑模式：表格 empty 插槽等窄空间用 */
  compact?: boolean
}

export default function InlineError({
  message,
  hint,
  onRetry,
  retrying = false,
  compact = false,
}: InlineErrorProps) {
  return (
    <div
      className={`inline-error${compact ? ' is-compact' : ''}`}
      style={{ padding: compact ? '20px 16px' : '28px 16px' }}
      role="alert"
    >
      <WarningOutlined className="inline-error-icon" />
      <div className="inline-error-title">加载失败</div>
      <div className="inline-error-message">{message}</div>
      {hint && <div className="inline-error-hint">{hint}</div>}
      {onRetry && (
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={retrying}
          onClick={onRetry}
          style={{ marginTop: 12 }}
        >
          重试
        </Button>
      )}
    </div>
  )
}

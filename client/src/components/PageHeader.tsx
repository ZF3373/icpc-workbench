import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  extra?: ReactNode
}

/** 可复用页面标题：渐变紫大标题 + 灰色描述 + 右侧操作区 */
export default function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        gap: 12,
        marginBottom: 24,
      }}
    >
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {extra && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{extra}</div>}
    </div>
  )
}

import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { MENU_GROUPS } from '../menuConfig'

interface PageHeaderProps {
  title: string
  description?: string
  extra?: ReactNode
  /**
   * 面包屑（当前位置感知，§4.2）。不传时按当前路由**自动推断**所处任务组
   * （训练 / 题库 / 赛事 / 数据），因为分组信息本来就只存在于 menuConfig 一处 ——
   * 让 13 个页面各自再传一遍「我在哪一组」既重复又会分叉。
   * 从详情页返回列表页这类真实父子关系，用 `breadcrumb` 显式传入覆盖。
   */
  breadcrumb?: string[]
}

/** 可复用页面标题：面包屑 + 渐变紫大标题 + 灰色描述 + 右侧操作区 */
export default function PageHeader({ title, description, extra, breadcrumb }: PageHeaderProps) {
  const loc = useLocation()
  const group = MENU_GROUPS.find((g) => g.items.includes(loc.pathname))
  const crumbs = breadcrumb ?? (group ? [group.label] : [])

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        gap: 12,
        marginBottom: crumbs.length > 0 ? 16 : 24,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {crumbs.length > 0 && (
          <nav className="page-breadcrumb" aria-label="当前位置">
            {crumbs.map((c, i) => (
              <span key={`${c}-${i}`} className="page-breadcrumb-item">
                {i > 0 && <span className="page-breadcrumb-sep">/</span>}
                {c}
              </span>
            ))}
          </nav>
        )}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {extra && (
        // minWidth: 0 让操作区可以收缩到内容宽度以下。flex 项默认 min-width:auto（= min-content），
        // 内含 nowrap 的 Space 时 min-content 就是整排按钮的总宽，窄窗口下会把整页撑出横向滚动条。
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          {extra}
        </div>
      )}
    </div>
  )
}

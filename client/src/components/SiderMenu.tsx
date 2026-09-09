/**
 * 可拖拽排序的侧边栏导航。替换 antd Menu，保留分组结构，组内拖拽重排。
 * 使用原生 HTML5 DnD（与 Assistant 会话拖拽一致，无新依赖），
 * 顺序持久化到 localStorage（见 menuConfig.tsx）。
 */
import { useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import {
  MENU_GROUPS,
  MENU_FIXED_BOTTOM,
  MENU_FIXED_TOP,
  menuIcon,
  menuLabel,
  reorderInGroup,
  useMenuOrder,
  type MenuOrder,
} from '../menuConfig'

interface SiderMenuProps {
  selected: string
  collapsed: boolean
  onNavigate: (key: string) => void
}

interface DragTarget {
  /** 拖拽落点的菜单项 key */
  key: string
  /** 插入位置：before = 落点项上方，after = 落点项下方 */
  pos: 'before' | 'after'
}

export default function SiderMenu({ selected, collapsed, onNavigate }: SiderMenuProps) {
  const order = useMenuOrder()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DragTarget | null>(null)
  /** 记录拖拽源所属组，落点只允许在同一组内 */
  const dragGroupRef = useRef<string | null>(null)

  const handleDragStart = (e: DragEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    setDragKey(key)
    dragGroupRef.current = groupKey
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 需要 setData 才能触发拖拽
    e.dataTransfer.setData('text/plain', key)
  }

  const handleDragOver = (e: DragEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    // 只允许同一组内拖放
    if (dragGroupRef.current !== groupKey || dragKey === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const isAfter = e.clientY > rect.top + rect.height / 2
    const pos = isAfter ? 'after' : 'before'
    // 避免拖到自身原位产生闪烁
    if (dragOver?.key === key && dragOver?.pos === pos) return
    setDragOver({ key, pos })
  }

  const handleDrop = (e: DragEvent<HTMLButtonElement>, groupKey: string) => {
    e.preventDefault()
    if (dragKey !== null && dragOver && dragGroupRef.current === groupKey) {
      reorderInGroup(groupKey as keyof MenuOrder, dragKey, dragOver.key, dragOver.pos)
    }
    clearDrag()
  }

  const clearDrag = () => {
    setDragKey(null)
    setDragOver(null)
    dragGroupRef.current = null
  }

  const renderNavItem = (key: string, groupKey: string | null) => {
    const isSelected = selected === key
    const isDragging = dragKey === key
    const dropTarget = dragOver?.key === key
    const draggable = !collapsed && groupKey !== null

    const classNames = [
      'sider-nav-item',
      isSelected ? 'is-selected' : '',
      isDragging ? 'is-dragging' : '',
      dropTarget && dragOver?.pos === 'before' ? 'is-drag-over-before' : '',
      dropTarget && dragOver?.pos === 'after' ? 'is-drag-over-after' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <button
        key={key}
        type="button"
        role="menuitem"
        className={classNames}
        draggable={draggable}
        title={collapsed ? menuLabel(key) : undefined}
        onClick={() => onNavigate(key)}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => e.key === 'Enter' && onNavigate(key)}
        onDragStart={draggable ? (e) => handleDragStart(e, key, groupKey!) : undefined}
        onDragOver={draggable ? (e) => handleDragOver(e, key, groupKey!) : undefined}
        onDrop={draggable ? (e) => handleDrop(e, groupKey!) : undefined}
        onDragEnd={clearDrag}
      >
        <span className="sider-nav-icon">{menuIcon(key)}</span>
        <span className="sider-nav-label">{menuLabel(key)}</span>
      </button>
    )
  }

  return (
    <nav className="sider-nav sider-menu" role="menu" aria-orientation="vertical">
      {/* 固定项：数据概览 */}
      {renderNavItem(MENU_FIXED_TOP, null)}

      {MENU_GROUPS.map((group) => (
        <div key={group.key} className="sider-nav-group">
          <div className="sider-nav-group-title">
            <span>{group.label}</span>
          </div>
          {order[group.key as keyof MenuOrder].map((key) => renderNavItem(key, group.key))}
        </div>
      ))}

      {/* 固定项：设置 */}
      {renderNavItem(MENU_FIXED_BOTTOM, null)}
    </nav>
  )
}

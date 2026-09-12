/**
 * 可拖拽排序的侧边栏导航。替换 antd Menu，保留分组结构，组内拖拽重排。
 * 使用 mouse 事件方案（与 Assistant 会话拖拽一致，兼容 WebView2/WKWebView；
 * HTML5 DnD 在 WebView2 中不工作），顺序持久化到 localStorage（见 menuConfig.tsx）。
 */
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, KeyboardEvent } from 'react'
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
  /** 拖拽源 key（ref 即时读写，不依赖 state 异步更新） */
  const dragKeyRef = useRef<string | null>(null)
  /** 记录拖拽源所属组，落点只允许在同一组内 */
  const dragGroupRef = useRef<string | null>(null)

  const clearDrag = () => {
    dragKeyRef.current = null
    dragGroupRef.current = null
    setDragKey(null)
    setDragOver(null)
  }

  // 拖拽中松手在列表外时清除状态（mouse 事件方案，兼容 WebView2/WKWebView）
  useEffect(() => {
    if (dragKey === null) return
    document.addEventListener('mouseup', clearDrag)
    return () => document.removeEventListener('mouseup', clearDrag)
  }, [dragKey])

  const handleMouseDown = (e: ReactMouseEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    // 折叠状态不启动拖拽
    if (collapsed) return
    e.stopPropagation() // 阻止冒泡到 onClick（防止按下即导航）
    e.preventDefault() // 阻止默认行为避免选中文本
    dragKeyRef.current = key
    dragGroupRef.current = groupKey
    setDragKey(key)
  }

  const handleMouseEnter = (e: ReactMouseEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    // 只在拖拽中且同组内处理
    if (dragKeyRef.current === null || dragGroupRef.current !== groupKey) return
    if (dragKeyRef.current === key) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pos: 'before' | 'after' = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
    // 避免拖到自身原位产生闪烁
    if (dragOver?.key === key && dragOver?.pos === pos) return
    setDragOver({ key, pos })
  }

  const handleMouseUp = (groupKey: string) => {
    if (dragKeyRef.current !== null && dragOver && dragGroupRef.current === groupKey) {
      reorderInGroup(groupKey as keyof MenuOrder, dragKeyRef.current, dragOver.key, dragOver.pos)
    }
    clearDrag()
  }

  const renderNavItem = (key: string, groupKey: string | null) => {
    const isSelected = selected === key
    const isDragging = dragKey === key
    const dropTarget = dragOver?.key === key
    const canDrag = !collapsed && groupKey !== null

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
        title={collapsed ? menuLabel(key) : undefined}
        onClick={() => onNavigate(key)}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => e.key === 'Enter' && onNavigate(key)}
        onMouseDown={canDrag ? (e) => handleMouseDown(e, key, groupKey!) : undefined}
        onMouseEnter={canDrag ? (e) => handleMouseEnter(e, key, groupKey!) : undefined}
        onMouseUp={canDrag ? () => handleMouseUp(groupKey!) : undefined}
      >
        <span className="sider-nav-icon">{menuIcon(key)}</span>
        <span className="sider-nav-label">{menuLabel(key)}</span>
      </button>
    )
  }

  return (
    <nav className="sider-nav sider-menu" role="menu" aria-orientation="vertical" style={{ userSelect: dragKey !== null ? 'none' : undefined }}>
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

      {/* 固定项：底部（设置、关于） */}
      {MENU_FIXED_BOTTOM.map((key) => renderNavItem(key, null))}
    </nav>
  )
}

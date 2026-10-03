/**
 * 可拖拽排序的侧边栏导航。替换 antd Menu，保留分组结构，组内拖拽重排。
 *
 * 两条并行的排序路径（UI 优化方案 §6.2）：
 * 1. mouse 事件拖拽（默认路径，兼容 WebView2/WKWebView；HTML5 DnD 在 WebView2 中不工作）；
 * 2. **键盘路径**：每个组内条目在鼠标 hover 或自身获得焦点时显现「上移/下移」按钮
 *    （opacity:0 不会移除 Tab 焦点，所以 Tab 到按钮时 :focus-within 会让它显形）。
 *    这条路径不改动拖拽代码，纯增量。
 *
 * 两条路径落盘后都给 3 秒「撤销」提示，误操作可回退。
 * 顺序持久化在 localStorage（见 menuConfig.tsx），折叠态保留分组分隔线。
 */
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, KeyboardEvent } from 'react'
import { App as AntdApp, Button, Tooltip } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, UndoOutlined } from '@ant-design/icons'
import {
  MENU_GROUPS,
  MENU_FIXED_BOTTOM,
  MENU_FIXED_TOP,
  menuIcon,
  menuLabel,
  moveInGroup,
  reorderInGroup,
  resetMenuOrder,
  setMenuOrder,
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
  const { message } = AntdApp.useApp()
  const order = useMenuOrder()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DragTarget | null>(null)
  /** 拖拽源 key（ref 即时读写，不依赖 state 异步更新） */
  const dragKeyRef = useRef<string | null>(null)
  /** 记录拖拽源所属组，落点只允许在同一组内 */
  const dragGroupRef = useRef<string | null>(null)
  /** 拖拽开始前的顺序快照：撤销提示要用它回滚 */
  const orderBeforeRef = useRef<MenuOrder | null>(null)
  /** 撤销提示的 key：连续排序时先销毁上一条，避免提示堆叠刷屏 */
  const msgKeyRef = useRef(0)

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

  /** 当前各组顺序的快照（撤销用）。取渲染期读到的 order，不重新读 localStorage */
  const snapshot = (): MenuOrder => {
    const out: MenuOrder = {}
    for (const g of MENU_GROUPS) out[g.key] = [...(order[g.key] ?? [])]
    return out
  }

  /**
   * 排序落盘后的「撤销」提示（§6.2 验收标准：3 秒内可撤销）。
   * before 是本次操作前的顺序；撤销时整份写回 —— 只有被操作的那组会变，
   * 但整份恢复更简单，也不会漏掉连续操作产生的中间态。
   */
  const showUndo = (before: MenuOrder | null) => {
    if (!before) return
    const key = `menu-order-${(msgKeyRef.current += 1)}`
    // 先销毁上一条：同一 tick 连续 open 会叠成一摞
    message.destroy()
    message.open({
      key,
      type: 'success',
      duration: 3,
      content: (
        <span>
          已调整导航顺序
          <Button
            type="link"
            size="small"
            icon={<UndoOutlined />}
            onClick={() => {
              message.destroy(key)
              setMenuOrder(before)
              message.info('已恢复排序前的顺序')
            }}
          >
            撤销
          </Button>
        </span>
      ),
    })
  }

  const handleMouseDown = (e: ReactMouseEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    // 折叠状态不启动拖拽
    if (collapsed) return
    e.stopPropagation() // 阻止冒泡到 onClick（防止按下即导航）
    e.preventDefault() // 阻止默认行为避免选中文本
    dragKeyRef.current = key
    dragGroupRef.current = groupKey
    orderBeforeRef.current = snapshot()
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
      reorderInGroup(groupKey, dragKeyRef.current, dragOver.key, dragOver.pos)
      showUndo(orderBeforeRef.current)
    }
    orderBeforeRef.current = null
    clearDrag()
  }

  /** 键盘排序：上移/下移一格 */
  const handleMove = (groupKey: string, key: string, delta: -1 | 1) => {
    const before = snapshot()
    if (moveInGroup(groupKey, key, delta)) showUndo(before)
  }

  const renderNavItem = (key: string, groupKey: string | null, index: number, groupLength: number) => {
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

    const label = menuLabel(key)
    const item = (
      <button
        type="button"
        role="menuitem"
        className={classNames}
        aria-current={isSelected ? 'page' : undefined}
        onClick={() => onNavigate(key)}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => e.key === 'Enter' && onNavigate(key)}
        onMouseDown={canDrag ? (e) => handleMouseDown(e, key, groupKey) : undefined}
        onMouseEnter={canDrag ? (e) => handleMouseEnter(e, key, groupKey) : undefined}
        onMouseUp={canDrag ? () => handleMouseUp(groupKey) : undefined}
      >
        <span className="sider-nav-icon">{menuIcon(key)}</span>
        <span className="sider-nav-label">{label}</span>
      </button>
    )

    return (
      <div className={`sider-nav-row${canDrag ? ' reorder-host' : ''}`} key={key}>
        {collapsed ? (
          <Tooltip title={label} placement="right">
            {item}
          </Tooltip>
        ) : (
          item
        )}
        {canDrag && (
          <span className="reorder-controls">
            <button
              type="button"
              className="reorder-btn"
              disabled={index === 0}
              title={`上移「${label}」`}
              aria-label={`上移「${label}」`}
              onClick={() => handleMove(groupKey, key, -1)}
            >
              <ArrowUpOutlined />
            </button>
            <button
              type="button"
              className="reorder-btn"
              disabled={index === groupLength - 1}
              title={`下移「${label}」`}
              aria-label={`下移「${label}」`}
              onClick={() => handleMove(groupKey, key, 1)}
            >
              <ArrowDownOutlined />
            </button>
          </span>
        )}
      </div>
    )
  }

  /** 当前顺序是否已偏离默认（决定「恢复默认排序」是否显示） */
  const customized = MENU_GROUPS.some(
    (g) => (order[g.key] ?? []).join('\u0000') !== g.items.join('\u0000'),
  )

  return (
    <nav
      className="sider-nav sider-menu"
      role="menu"
      aria-orientation="vertical"
      style={{ userSelect: dragKey !== null ? 'none' : undefined }}
    >
      {/* 固定项：数据概览 */}
      {renderNavItem(MENU_FIXED_TOP, null, 0, 1)}

      {MENU_GROUPS.map((group) => {
        const items = order[group.key] ?? group.items
        return (
          <div key={group.key} className="sider-nav-group">
            <div className="sider-nav-group-title">
              <span>{group.label}</span>
            </div>
            {items.map((key, i) => renderNavItem(key, group.key, i, items.length))}
          </div>
        )
      })}

      {/* 固定项：底部（设置、关于） */}
      {MENU_FIXED_BOTTOM.map((key) => renderNavItem(key, null, 0, 1))}

      {/* 恢复默认排序：只在用户确实排过顺序时出现，避免常态占用视觉权重 */}
      {customized && !collapsed && (
        <div className="sider-nav-reset">
          <Button
            type="text"
            size="small"
            icon={<UndoOutlined />}
            onClick={() => {
              resetMenuOrder()
              message.success('已恢复默认导航排序')
            }}
          >
            恢复默认排序
          </Button>
        </div>
      )}
    </nav>
  )
}

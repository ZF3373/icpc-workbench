/**
 * AI 助手会话记录侧栏的单行（memo 化）。memo 的动机：流式生成期间 store 的
 * sessions 每次攒批都换引用，但只有正在生成的那个会话对象在变——其余几十行
 * 会话的 props 完全相同，memo 后它们全部跳过重渲染。
 */
import { memo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Button, Dropdown, Input, Tooltip } from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  LoadingOutlined,
  MoreOutlined,
  PushpinFilled,
  PushpinOutlined,
} from '@ant-design/icons'
import { relTime } from '../../formatTime.ts'
import type { ChatSession } from '../../pages/chatStore'

export interface SessionRowProps {
  s: ChatSession
  isActive: boolean
  isDragging: boolean
  isDragOver: boolean
  /** 任意行正在被拖拽（行间互斥样式与 userSelect 用） */
  anyDragging: boolean
  renaming: boolean
  sending: boolean
  onActivate: (id: string) => void
  onHandleDown: (id: string) => void
  onEnter: (e: ReactMouseEvent<HTMLDivElement>, id: string, isActive: boolean) => void
  onLeave: (e: ReactMouseEvent<HTMLDivElement>, isActive: boolean) => void
  onDrop: (id: string) => void
  onRename: (id: string, title: string) => void
  onStartRename: (id: string) => void
  onCancelRename: () => void
  onPin: (id: string) => void
  onDelete: (id: string) => void
}

/**
 * 会话记录侧栏的单行。memo 化的动机：流式生成期间 store 的 sessions 每次攒批
 * 都换引用，但只有正在生成的那个会话对象在变——其余几十行会话的 props 完全相同，
 * memo 后它们全部跳过重渲染（此前每 50ms 全列表重建一次）。
 */
export const SessionRow = memo(function SessionRow({
  s,
  isActive,
  isDragging,
  isDragOver,
  anyDragging,
  renaming,
  sending,
  onActivate,
  onHandleDown,
  onEnter,
  onLeave,
  onDrop,
  onRename,
  onStartRename,
  onCancelRename,
  onPin,
  onDelete,
}: SessionRowProps) {
  return (
    <div
      className="reorder-host"
      onClick={() => onActivate(s.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px',
        borderRadius: 8,
        cursor: 'pointer',
        marginBottom: 2,
        background: isActive ? 'var(--brand-soft)' : 'transparent',
        opacity: isDragging ? 0.4 : 1,
        borderTop: isDragOver ? '2px solid var(--brand)' : '2px solid transparent',
        transition: 'background var(--dur-2) var(--ease-standard)',
        userSelect: anyDragging ? 'none' : undefined,
      }}
      onMouseEnter={(e) => onEnter(e, s.id, isActive)}
      onMouseLeave={(e) => onLeave(e, isActive)}
      onMouseUp={() => onDrop(s.id)}
    >
      <HolderOutlined
        style={{ fontSize: 12, color: 'var(--text-dim)', flexShrink: 0, cursor: 'grab' }}
        onMouseDown={(e) => {
          // 在手柄上按下鼠标：启动拖拽（阻止默认行为避免选中文本）
          e.stopPropagation()
          e.preventDefault()
          onHandleDown(s.id)
        }}
      />
      {/* 行内只留拖拽手柄 + ⋯ 菜单：↑↓ 排序与拖拽功能重复，重命名/置顶/删除
          是低频操作，收进菜单把宽度还给标题。⋯ 是真实按钮，键盘和触屏都够得着。 */}
      <div style={{ flex: 1, minWidth: 0 }} onDoubleClick={() => onStartRename(s.id)}>
        {renaming ? (
          <Input
            size="small"
            autoFocus
            defaultValue={s.title}
            onClick={(e) => e.stopPropagation()}
            onPressEnter={(e) => {
              onRename(s.id, (e.target as HTMLInputElement).value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelRename()
            }}
            onBlur={(e) => {
              onRename(s.id, e.target.value)
            }}
            style={{ fontSize: 13, height: 24 }}
          />
        ) : (
          <>
            {/* 双击重命名的提示：原生 title 悬停约 1 秒才出、无样式、键盘聚焦也不显示；
                换成 Tooltip 后与行内「⋯ → 重命名」的入口保持同一套提示形态
                （键盘用户的主路径是 ⋯ 菜单，这里是鼠标路径的提示） */}
            <Tooltip title="双击重命名">
              <div
                style={{
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: s.pinned ? 'var(--amber)' : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {sending && (
                  <LoadingOutlined style={{ fontSize: 11, color: 'var(--brand)', flexShrink: 0 }} />
                )}
                {s.pinned && (
                  <PushpinFilled style={{ fontSize: 11, color: 'var(--amber)', flexShrink: 0 }} />
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || '新会话'}</span>
              </div>
            </Tooltip>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{relTime(s.updatedAt)}</div>
          </>
        )}
      </div>
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        menu={{
          items: [
            { key: 'rename', icon: <EditOutlined />, label: '重命名' },
            {
              key: 'pin',
              icon: s.pinned ? <PushpinFilled /> : <PushpinOutlined />,
              label: s.pinned ? '取消置顶' : '置顶',
            },
            { type: 'divider' },
            { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation() // 不能顺带切换会话
            if (key === 'rename') onStartRename(s.id)
            else if (key === 'pin') onPin(s.id)
            else if (key === 'delete') onDelete(s.id)
          },
        }}
      >
        <Button
          size="small"
          type="text"
          icon={<MoreOutlined />}
          aria-label={`会话操作：「${s.title || '新会话'}」`}
          onClick={(e) => e.stopPropagation()}
          style={{ flexShrink: 0, padding: '0 4px' }}
        />
      </Dropdown>
    </div>
  )
})

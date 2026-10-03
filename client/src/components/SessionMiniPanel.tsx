import { Button, Dropdown, Input } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  LoadingOutlined,
  MoreOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
} from '@ant-design/icons'

/**
 * 折叠态侧栏的会话浮层（P3-5 / §5.3）。
 *
 * 背景：AI 助手侧栏收起后只剩 64px 一条窄边，会话列表、上下文、能力值全部消失 ——
 * 用户在展开之前无法判断「现在在哪个会话、要不要切」。这里给出折叠态可用的会话入口：
 * 鼠标悬停或键盘聚焦窄边时，浮出完整会话列表，点击即可切换，无需先展开侧栏。
 *
 * 为什么单独一个组件：它只吃「已经算好的展示数据」与动作回调，不认识 ChatSession 的
 * 存储结构，也就不可能顺手去改会话的持久化格式（那部分逻辑集中在 Assistant.tsx，
 * 有既有测试覆盖）。
 *
 * 结构说明（P7）：每一行是 `<div class="mini-session-item reorder-host">`，
 * 内部才是 `<button class="mini-session-btn">` —— 因为加了键盘排序按钮。
 * HTML 不允许按钮嵌套按钮，所以行容器不能继续是 `<button>`；切换会话的点击区
 * 交给内层按钮（`flex: 1` 铺满行）。
 *
 * 会话操作（重命名 / 置顶 / 删除）与展开侧行共用同一套 ⋯ 菜单：菜单渲染在 portal 里，
 * 鼠标移过去会离开 rail 触发区 —— 调用方必须监听 `onActionsOpenChange` 并在打开期间
 * 锁定浮层显隐（见 Assistant.tsx 的 is-flyout-locked），否则浮层带着触发按钮一起消失。
 */

export interface MiniSessionItem {
  id: string
  title: string
  pinned: boolean
  /** 该会话的轮数（用于让用户判断会话大小） */
  turns: number
  /** 是否正在流式生成（多会话可并行） */
  streaming: boolean
}

export interface SessionMiniPanelProps {
  sessions: MiniSessionItem[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  /**
   * 键盘排序（拖拽的无障碍替代，§6.2）：上移/下移一格。
   * 不传则整个排序控件不渲染 —— 让本组件在「只读展示」场景下仍是纯展示组件。
   */
  onMove?: (id: string, delta: -1 | 1) => void
  /** 会话操作三件套：与展开侧行的 ⋯ 菜单同源；都不传则行内不出 ⋯ */
  renamingId?: string | null
  onRenameStart?: (id: string) => void
  onRenameCommit?: (id: string, title: string) => void
  onRenameCancel?: () => void
  onTogglePin?: (id: string) => void
  /** 删除不在这里确认：确认弹窗由调用方（有 modal 上下文的一侧）负责 */
  onDeleteRequest?: (id: string) => void
  /** ⋯ 菜单开合上报：调用方据此在菜单打开期间锁定浮层，防止 portal 菜单够不着 */
  onActionsOpenChange?: (open: boolean) => void
}

export default function SessionMiniPanel({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onMove,
  renamingId,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onTogglePin,
  onDeleteRequest,
  onActionsOpenChange,
}: SessionMiniPanelProps) {
  const hasActions = Boolean(onRenameStart && onTogglePin && onDeleteRequest)
  return (
    <div className="mini-session-panel">
      <div className="mini-session-head">
        <span>会话记录</span>
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={onCreate}>
          新建
        </Button>
      </div>
      {sessions.length === 0 ? (
        <div className="mini-session-empty">
          还没有会话
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            开始第一次对话
          </Button>
        </div>
      ) : (
        <div className="mini-session-list">
          {sessions.map((s, index) => {
            const label = s.title || '新会话'
            const renaming = renamingId === s.id
            return (
              <div
                key={s.id}
                className={`mini-session-item reorder-host${s.id === activeId ? ' is-active' : ''}`}
              >
                {renaming ? (
                  <Input
                    size="small"
                    autoFocus
                    defaultValue={s.title}
                    className="mini-session-rename"
                    onPressEnter={(e) => onRenameCommit?.(s.id, (e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') onRenameCancel?.()
                    }}
                    onBlur={(e) => onRenameCommit?.(s.id, e.target.value)}
                    style={{ fontSize: 12, height: 24, margin: '0 8px' }}
                  />
                ) : (
                  <button
                    type="button"
                    className="mini-session-btn"
                    aria-current={s.id === activeId ? 'true' : undefined}
                    onClick={() => onSelect(s.id)}
                  >
                    <span className="mini-session-title">{label}</span>
                    {s.streaming && <LoadingOutlined className="mini-session-stream" />}
                    {s.pinned && <PushpinFilled className="mini-session-pin" />}
                    <span className="mini-session-turns">{s.turns} 轮</span>
                  </button>
                )}
                {onMove && !renaming && (
                  /* 与侧栏/Dashboard/题单同一套 .reorder-controls：hover 或 Tab 聚焦时显现，首尾禁用 */
                  <span className="reorder-controls">
                    <button
                      type="button"
                      className="reorder-btn"
                      disabled={index === 0}
                      title={`上移「${label}」`}
                      aria-label={`上移「${label}」`}
                      onClick={() => onMove(s.id, -1)}
                    >
                      <ArrowUpOutlined />
                    </button>
                    <button
                      type="button"
                      className="reorder-btn"
                      disabled={index === sessions.length - 1}
                      title={`下移「${label}」`}
                      aria-label={`下移「${label}」`}
                      onClick={() => onMove(s.id, 1)}
                    >
                      <ArrowDownOutlined />
                    </button>
                  </span>
                )}
                {hasActions && !renaming && (
                  <Dropdown
                    trigger={['click']}
                    placement="bottomRight"
                    onOpenChange={onActionsOpenChange}
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
                        domEvent.stopPropagation()
                        if (key === 'rename') onRenameStart?.(s.id)
                        else if (key === 'pin') onTogglePin?.(s.id)
                        else if (key === 'delete') onDeleteRequest?.(s.id)
                      },
                    }}
                  >
                    <button type="button" className="mini-session-more" aria-label={`会话操作：「${label}」`}>
                      <MoreOutlined />
                    </button>
                  </Dropdown>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

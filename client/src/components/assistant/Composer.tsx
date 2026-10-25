/**
 * AI 助手的输入区：文本框 + `/` 快捷指令候选 + 待发附件预览 + 附加/发送/停止按钮。
 *
 * 单独成组件的原因（性能）：击键只更新 store 的 input 字段，主页面订阅的是不含
 * input 的视图快照（见 chatStore），因此每次击键只有这里重渲染，而不是整页。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, Input, Tag, Tooltip } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import {
  CloseOutlined,
  LoadingOutlined,
  PaperClipOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { formatBytes as fmtBytes } from '../../ui'
import { matchChatCommands, type ChatCommand } from '../../chatCommands'
import { getInputSnapshot, setChatState, subscribeChat, type PendingAtt } from '../../pages/chatStore'
import type { RefObject } from 'react'

export interface ComposerProps {
  sending: boolean
  /** 正文输出完但 AI 仍在跑工具时的进度文案（不属于当前会话则不传） */
  toolStatusText?: string
  pendingAtts: PendingAtt[]
  uploadingAtts: boolean
  inputRef: RefObject<TextAreaRef | null>
  fileInputRef: RefObject<HTMLInputElement | null>
  onPaste: (e: React.ClipboardEvent) => void
  onPickFiles: (files: FileList | null) => void | Promise<void>
  onSend: () => void
  onStop: () => void
  onRemovePendingAtt: (index: number) => void
  runCommand: (cmd: ChatCommand) => void
}

/**
 * 输入区：文本框 + `/` 快捷指令候选 + 待发附件预览 + 附加/发送/停止按钮。
 * 单独成组件的原因（性能）：击键只更新 store 的 input 字段，主页面订阅的是不含
 * input 的视图快照（见 chatView），因此每次击键只有这里重渲染，而不是整页。
 */
export function Composer({
  sending,
  toolStatusText,
  pendingAtts,
  uploadingAtts,
  inputRef,
  fileInputRef,
  onPaste,
  onPickFiles,
  onSend,
  onStop,
  onRemovePendingAtt,
  runCommand,
}: ComposerProps) {
  const input = useSyncExternalStore(subscribeChat, getInputSnapshot)
  /**
   * `/` 快捷指令（P3-5）：输入框以 `/` 开头时在它上方浮出候选，↑↓ 选择、Enter 执行、Esc 忽略。
   * 菜单只在「确实是命令」时出现 —— 解析不出来就照常当普通消息发出去，绝不静默吞掉输入。
   */
  const cmdCandidates = useMemo(() => matchChatCommands(input), [input])
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const cmdMenuOpen = cmdCandidates.length > 0 && !cmdDismissed
  // 候选变了就把高亮收回范围，避免停在一个已经不存在的项上
  useEffect(() => {
    setCmdIndex((i) => (i < cmdCandidates.length ? i : 0))
  }, [cmdCandidates.length])
  // 输入不再是命令态时，重新允许弹出菜单（Esc 只忽略当前这一次）
  useEffect(() => {
    if (cmdCandidates.length === 0) setCmdDismissed(false)
  }, [cmdCandidates.length])
  return (
    <div className="plan-chat-input" style={{ position: 'relative' }}>
      {/* `/` 快捷指令候选（P3-5）：浮在输入框上方，不挤压消息区高度 */}
      {cmdMenuOpen && (
        <div className="chat-cmd-menu" role="listbox" aria-label="快捷指令">
          {cmdCandidates.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === cmdIndex}
              className={`chat-cmd-item${i === cmdIndex ? ' is-active' : ''}`}
              onMouseEnter={() => setCmdIndex(i)}
              // mousedown 而不是 click：click 之前输入框会先失焦，菜单已经被关掉
              onMouseDown={(e) => {
                e.preventDefault()
                runCommand(c)
              }}
            >
              <span className="chat-cmd-name">
                /{c.name}
                {c.arg ? <span className="chat-cmd-arg"> {c.arg}</span> : null}
              </span>
              <span className="chat-cmd-hint">{c.hint}</span>
            </button>
          ))}
        </div>
      )}
      {pendingAtts.length > 0 && (
        <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {pendingAtts.map((a, i) =>
            a.previewUrl ? (
              /* 图片附件：缩略图预览（对齐主流聊天产品的粘贴样式），悬停出移除钮 */
              <div key={`${a.fileId}-${i}`} className="pending-att-thumb">
                <img src={a.previewUrl} alt={a.filename || '图片附件'} />
                <button
                  type="button"
                  className="pending-att-remove"
                  aria-label={`移除图片 ${a.filename || ''}`}
                  title={a.filename || '图片附件'}
                  onClick={() => onRemovePendingAtt(i)}
                >
                  <CloseOutlined />
                </button>
              </div>
            ) : (
              <Tag
                key={`${a.fileId}-${i}`}
                closable
                onClose={() => onRemovePendingAtt(i)}
              >
                <PaperClipOutlined /> {a.filename || a.fileId}
                {a.bytes !== undefined ? `（${fmtBytes(a.bytes)}）` : ''}
                {a.textContent !== undefined ? ' · 文本' : ''}
              </Tag>
            ),
          )}
        </div>
      )}
      <Input.TextArea
        ref={inputRef}
        value={input}
        onChange={(e) => setChatState((prev) => ({ ...prev, input: e.target.value }))}
        placeholder="向 AI 教练提问…（可粘贴截图/代码，拖入或附加图片/代码文件；输入 / 查看快捷指令）Enter 发送，Shift+Enter 换行"
        onPaste={onPaste}
        autoSize={{ minRows: 1, maxRows: 6 }}
        onKeyDown={(e) => {
          // 菜单打开时先吃掉方向键/Enter/Esc，避免同时触发「发送」
          if (!cmdMenuOpen) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setCmdIndex((i) => (i + 1) % cmdCandidates.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCmdIndex((i) => (i - 1 + cmdCandidates.length) % cmdCandidates.length)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setCmdDismissed(true)
          }
        }}
        onPressEnter={(e) => {
          if (e.shiftKey) return
          e.preventDefault()
          if (cmdMenuOpen) {
            runCommand(cmdCandidates[cmdIndex])
            return
          }
          onSend()
        }}
      />
      <Tooltip title="附加图片或代码文件（图片走 Files API 上传，文本/代码文件读取内容到输入框）">
        <Button
          icon={uploadingAtts ? <LoadingOutlined /> : <PaperClipOutlined />}
          aria-label="附加图片或代码文件"
          disabled={uploadingAtts || sending}
          onClick={() => fileInputRef.current?.click()}
          tabIndex={-1}
        />
      </Tooltip>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.xlsx,.pptx,.html,.htm,.csv,.json,.xml,.epub,.txt,.md,.py,.cpp,.c,.cc,.cxx,.h,.hpp,.java,.kt,.rs,.go,.js,.ts,.jsx,.tsx,.rb,.php,.sh,.bash,.zsh,.sql,.yaml,.yml,.toml,.tsv,.css,.scss,.less,.vue,.svelte,.swift,.m,.scala,.clj,.ex,.exs,.erl,.hs,.lua,.pl,.r,.dart,.groovy,.gradle,.cmake,.ini,.cfg,.conf,.properties"
        hidden
        onChange={(e) => void onPickFiles(e.target.files)}
      />
      {sending ? (
        <>
          {/* 正文输出完但 AI 还在跑工具（检索/抓网页）时，说明为什么按钮仍是「停止」 */}
          {toolStatusText && (
            <span style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
              {toolStatusText}
            </span>
          )}
          <Tooltip title="停止本次生成（已输出的内容会保留）">
            <Button danger onClick={onStop} tabIndex={-1}>
              停止
            </Button>
          </Tooltip>
        </>
      ) : (
        <Button
          type="primary"
          icon={<SendOutlined />}
          disabled={(!input.trim() && pendingAtts.length === 0) || uploadingAtts}
          onClick={() => onSend()}
          tabIndex={-1}
        />
      )}
    </div>
  )
}


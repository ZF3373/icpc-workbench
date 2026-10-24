/**
 * 笔记查看卡片弹窗：仿「赛事中心 → 赛事分析」的单场弹窗
 * （antd Modal + footer={null} + width=860），点击后弹出卡片展示笔记全文，
 * 正文支持「笔记文字」字号缩放（见 ZoomControl + index.css 的 .note-card 段 + appZoom 的 [data-note-zoom]）。
 * 复习库 / 模板库 / 计划任务备注共用这同一个卡片，标题带类型区分。
 */
import type { ReactNode } from 'react'
import { Button, Modal } from 'antd'
import { EditOutlined } from '@ant-design/icons'
import Markdown from './Markdown'
import ZoomControl from './ZoomControl'
import { noteKindLabel, type NoteKind } from '../noteView'

export interface NoteCardModalProps {
  /** 笔记归属：决定类型标签与 Markdown/纯文本渲染 */
  kind: NoteKind
  /** 归属主体：题号+题名 / 模板名 / 任务标题 */
  subject?: string | null
  /** 笔记正文 */
  text: string
  /** 可选：标题下的归属补充（平台、到期、计划名等） */
  meta?: ReactNode
  /** 可选：卡片右上角「编辑」入口；点击后由外层接管（关闭卡片并打开编辑器） */
  onEdit?: () => void
  onClose: () => void
}

export default function NoteCardModal({ kind, subject, text, meta, onEdit, onClose }: NoteCardModalProps) {
  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnHidden
      className="note-card-modal"
      title={
        <div className="note-card-head">
          <div className="note-card-title" title={subject ? `${noteKindLabel(kind)} · ${subject}` : noteKindLabel(kind)}>
            <span className="note-card-kind">{noteKindLabel(kind)}</span>
            {subject ? <span className="note-card-subject">{subject}</span> : null}
          </div>
          <div className="note-card-tools">
            <ZoomControl kind="note" />
            {onEdit ? (
              <Button size="small" icon={<EditOutlined />} onClick={() => { onClose(); onEdit() }}>
                编辑
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {meta ? <div className="note-card-meta">{meta}</div> : null}
      {/* data-note-zoom 是 appZoom 里 Ctrl+滚轮缩放笔记字号的锚点；卡片头、meta、按钮都不在其中，
          所以标题栏和操作区不参与缩放 */}
      <div className="note-card-body" data-note-zoom>
        {kind === 'task'
          ? <p className="note-card-plain">{text}</p>
          : <Markdown text={text} />}
      </div>
    </Modal>
  )
}
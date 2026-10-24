/**
 * 笔记查看入口按钮：自带弹窗状态，点击弹出 NoteCardModal（仿赛事中心「赛事分析」入口）。
 * 两种形态：
 *   - entry（默认）：紧凑入口行「图标 + 查看笔记 + 摘要」
 *   - text：笔记正文本身可点（.note-text-open，外观沿用原任务备注样式），任务备注用它。
 * 笔记为空时返回 null（不渲染空入口）。
 */
import { useState, type ReactNode } from 'react'
import { ReadOutlined } from '@ant-design/icons'
import NoteCardModal from './NoteCardModal'
import { hasNoteText, noteKindLabel, noteSummary, type NoteKind } from '../noteView'

export interface NoteCardButtonProps {
  /** 笔记归属种类 */
  kind: NoteKind
  /** 笔记正文；为空时组件不渲染 */
  text: string
  /** 归属主体（题号+题名 / 模板名 / 任务标题） */
  subject?: string | null
  /** 可选归属补充，随卡片标题展示 */
  meta?: ReactNode
  /** 可选编辑入口：点击先关卡片再回调（避免两层 Modal 叠着） */
  onEdit?: () => void
  /** entry | text；默认 entry */
  variant?: 'entry' | 'text'
  className?: string
  /** 入口文案；默认「查看笔记」 */
  label?: string
}

export default function NoteCardButton({
  kind, text, subject, meta, onEdit, variant = 'entry', className, label = '查看笔记',
}: NoteCardButtonProps) {
  const [open, setOpen] = useState(false)
  // 空/纯空白笔记不渲染入口，避免出现点了没内容的按钮
  if (!hasNoteText(text)) return null

  const openCard = () => setOpen(true)
  const closeCard = () => setOpen(false)

  if (variant === 'text') {
    return (
      <>
        <button
          type="button"
          className="note-text-open"
          aria-haspopup="dialog"
          aria-label={`${noteKindLabel(kind)}：${text}`}
          title="查看笔记"
          onClick={openCard}
        >
          {text}
        </button>
        {open ? (
          <NoteCardModal kind={kind} subject={subject} text={text} meta={meta}
            onEdit={onEdit ? () => { closeCard(); onEdit() } : undefined} onClose={closeCard} />
        ) : null}
      </>
    )
  }

  const summary = noteSummary(text)
  return (
    <>
      <button
        type="button"
        className={`note-entry${className ? ` ${className}` : ''}`}
        aria-haspopup="dialog"
        aria-label={`${noteKindLabel(kind)}${subject ? ` · ${subject}` : ''}：${label}`}
        title="查看笔记"
        onClick={openCard}
      >
        <ReadOutlined className="note-entry-icon" />
        <span className="note-entry-label">{label}</span>
        {summary ? <span className="note-entry-summary">{summary}</span> : null}
      </button>
      {open ? (
        <NoteCardModal kind={kind} subject={subject} text={text} meta={meta}
          onEdit={onEdit ? () => { closeCard(); onEdit() } : undefined} onClose={closeCard} />
      ) : null}
    </>
  )
}
/**
 * 笔记查看卡片弹窗：仿「赛事中心 → 赛事分析」的单场弹窗
 * （antd Modal + footer={null}），点击后弹出卡片展示笔记全文。
 *
 * 两种形态（issue #52 反馈「笔记太小、查看复习不方便」）：
 *   - 卡片态（默认）：860px 定宽 + 正文最高 62vh，看完就 Esc 关掉；
 *   - 全屏态（沉浸阅读）：铺满整个应用窗口，**去掉标题栏 / meta / 编辑入口**，
 *     只留正文与一个「退出全屏」按钮，Esc 退出（issue 回复里选定的方案 B）。
 * 两种形态共用同一个正文容器，Ctrl+滚轮的「笔记文字」缩放始终生效
 * （见 ZoomControl + index.css 的 .note-card 段 + appZoom 的 [data-note-zoom]）。
 * 复习库 / 模板库 / 计划任务备注共用这同一个卡片，标题带类型区分。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from 'antd'
import { CompressOutlined, EditOutlined, ExpandOutlined } from '@ant-design/icons'
import Markdown from './Markdown'
import ZoomControl from './ZoomControl'
import { noteCardWidth, noteKindLabel, type NoteKind } from '../noteView'

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
  const [fullscreen, setFullscreen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const exitRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 记录「上一次是不是全屏」，用来区分初次挂载与真正的「退出全屏」，避免开卡就抢焦点 */
  const wasFullscreen = useRef(false)

  const exitFullscreen = useCallback(() => setFullscreen(false), [])

  /*
   * Esc 分两层：全屏时第一下只退出全屏（读者还在读，不该一下把卡片也关掉），
   * 回到卡片态后再按一次才关卡片（那一层交给 antd Modal 自己处理）。
   * 必须走捕获阶段并 stopPropagation：否则同一次按键会继续冒泡到 rc-dialog，
   * 变成「一按 Esc 既退全屏又关卡片」。
   */
  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      setFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [fullscreen])

  /* 焦点跟着形态走：进全屏把焦点交给「退出全屏」（键盘/读屏用户立刻有出口），
     退出全屏再还给「全屏查看」，不让焦点掉回 body。初次挂载不抢焦点。 */
  useEffect(() => {
    if (fullscreen) {
      wasFullscreen.current = true
      exitRef.current?.focus()
    } else if (wasFullscreen.current) {
      wasFullscreen.current = false
      toggleRef.current?.focus()
    }
  }, [fullscreen])

  /* 切换形态时正文回到顶部：全屏与卡片态的行长、可视高度都变了，
     沿用旧的滚动位置会落在半句话上。 */
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 })
  }, [fullscreen])

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      width={noteCardWidth(fullscreen)}
      destroyOnHidden
      className={`note-card-modal${fullscreen ? ' is-fullscreen' : ''}`}
      /* 全屏态下 antd 自带的 X 与 Esc 都禁用：X 会直接关掉整张卡片（读者只想退出全屏），
         Esc 由上面那层捕获监听接管。卡片态保持 antd 默认行为。 */
      closable={!fullscreen}
      keyboard={!fullscreen}
      /* 全屏态也要给 title：rc-dialog 用 aria-labelledby 指向标题节点，
         真删掉它，全屏弹窗在屏幕阅读器里就是「一个没有名字的对话框」。
         所以全屏只留一行纯文本标题，由 CSS 视觉隐藏（见 index.css 的 .is-fullscreen .ant-modal-header）。 */
      title={fullscreen ? (
        <span className="note-card-fs-title">
          {noteKindLabel(kind)}{subject ? ` · ${subject}` : ''}
        </span>
      ) : (
        <div className="note-card-head">
          <div className="note-card-title" title={subject ? `${noteKindLabel(kind)} · ${subject}` : noteKindLabel(kind)}>
            <span className="note-card-kind">{noteKindLabel(kind)}</span>
            {subject ? <span className="note-card-subject">{subject}</span> : null}
          </div>
          <div className="note-card-tools">
            <ZoomControl kind="note" />
            <Button
              ref={toggleRef}
              size="small"
              icon={<ExpandOutlined />}
              aria-label="全屏阅读笔记"
              title="全屏阅读笔记（Esc 退出）"
              onClick={() => setFullscreen(true)}
            >
              <span className="note-card-fs-btn-label">全屏</span>
            </Button>
            {onEdit ? (
              <Button size="small" icon={<EditOutlined />} onClick={() => { onClose(); onEdit() }}>
                编辑
              </Button>
            ) : null}
          </div>
        </div>
      )}
    >
      {fullscreen ? (
        /* 沉浸阅读：只有一条退出通道，不放标题/meta/编辑 —— 读的时候不需要它们 */
        <div className="note-card-fsbar">
          <button
            ref={exitRef}
            type="button"
            className="note-card-exit"
            aria-label={`退出全屏阅读（${noteKindLabel(kind)}${subject ? ` · ${subject}` : ''}）`}
            onClick={exitFullscreen}
          >
            <CompressOutlined />
            <span>退出全屏</span>
            <kbd>Esc</kbd>
          </button>
        </div>
      ) : meta ? (
        <div className="note-card-meta">{meta}</div>
      ) : null}
      {/* data-note-zoom 是 appZoom 里 Ctrl+滚轮缩放笔记字号的锚点；卡片头、meta、按钮都不在其中，
          所以标题栏和操作区不参与缩放。全屏态同样只包正文，退出的按钮不跟着变大 */}
      <div className="note-card-body" data-note-zoom ref={bodyRef}>
        {kind === 'task'
          ? <p className="note-card-plain">{text}</p>
          : <Markdown text={text} />}
      </div>
    </Modal>
  )
}

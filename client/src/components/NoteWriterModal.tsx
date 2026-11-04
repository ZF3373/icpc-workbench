/**
 * 笔记写作弹窗：把模板库「阅读卡片 / 全屏三栏写作 / 视图持久化」那套写作体验，
 * 复刻给复习库（以及模板库自己的学习笔记），issue #52 后续反馈：
 * 「复习库的复习笔记编辑编写时貌似还没有相关功能，只能扩大查看」。
 *
 * 两种形态：
 *   - 卡片态（默认）：760px 定宽，正文吃满一屏，页脚常驻「取消 / 保存」；
 *   - 全屏三栏（沉浸写作）：铺满整个应用窗口，隐藏标题栏，三栏从左到右依次是
 *     「实时预览 / 写作上下文 / MD 写作」—— 写作区在最右侧，右手边写、左边看渲染结果。
 *     Esc 分两层退出。
 * 两种形态用的是两套排版（卡片态一栏、全屏态三栏），切换时 NoteEditor 会重新挂载；
 * 但正文由外层受控（value/onChange），所以未保存的内容不会丢 —— 只是光标归位、
 * 撤销栈清空，与改动前「切到预览再切回来」的表现一致。
 *
 * 与阅读卡片（NoteCardModal）刻意保持同一套交互语汇：右上角工具组、
 * 「笔记文字」缩放（Ctrl+滚轮 / 加减按钮，50%–200% 独立持久化）、
 * Esc 第一下退全屏、第二下才关卡片。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from 'antd'
import { CompressOutlined, ExpandOutlined } from '@ant-design/icons'
import Markdown from './Markdown'
import NoteEditor from './NoteEditor'
import ZoomControl from './ZoomControl'
import { noteKindLabel, type NoteKind } from '../noteView'
import { BP, useMediaQuery } from '../useMediaQuery'
import {
  noteCharCount,
  noteLineCount,
  noteWriterWidth,
  readNoteWriterViewState,
  writeNoteWriterViewState,
  type NoteWriterMode,
} from '../noteWriterView'

export interface NoteWriterModalProps {
  /** 笔记归属：决定标题文案与纯文本/Markdown 渲染 */
  kind: NoteKind
  /** 归属主体：题号+题名 / 模板名 / 任务标题 */
  subject?: string | null
  /** 笔记正文（受控） */
  value: string
  onChange: (value: string) => void
  /** 归属补充信息，卡片态展示在标题下；全屏态收进右栏「这篇笔记」 */
  meta?: ReactNode
  /** 保存中：按钮进 loading，期间取消 / 关闭都挡住（避免半截内容落盘或重复提交） */
  saving?: boolean
  onSave: () => void
  onClose: () => void
  /** 编辑区占位文案 */
  placeholder?: string
  maxLength?: number
  /**
   * 全屏右栏「写作上下文」：复习库传复习节奏、模板库传大纲要点。
   * 只在全屏态展示 —— 卡片态宽度有限，塞进来会把正文挤没。
   */
  context?: ReactNode
  /** 全屏右栏给阅读用：Markdown 渲染的参考正文（模板库的大纲等）；省略则不渲染 */
  reference?: { title: string; text: string }
}

export default function NoteWriterModal({
  kind,
  subject,
  value,
  onChange,
  meta,
  saving = false,
  onSave,
  onClose,
  placeholder,
  maxLength = 20000,
  context,
  reference,
}: NoteWriterModalProps) {
  /** 上次的形态与编辑模式（挂载时读一次；之后由本地 state 跟上并落盘） */
  const [saved] = useState(readNoteWriterViewState)
  const [fullscreen, setFullscreen] = useState(saved?.fullscreen ?? false)
  const [mode, setMode] = useState<NoteWriterMode>(saved?.mode ?? 'split')
  const toggleRef = useRef<HTMLButtonElement>(null)
  const exitRef = useRef<HTMLButtonElement>(null)
  /** 记录「上一次是不是全屏」，用来区分初次挂载与真正的「退出全屏」，避免开弹窗就抢焦点 */
  const wasFullscreen = useRef(false)

  const kindLabel = noteKindLabel(kind)

  // 形态与模式落盘：下次打开同一处笔记直接回到上次的写作姿势
  useEffect(() => {
    writeNoteWriterViewState({ fullscreen, mode })
  }, [fullscreen, mode])

  /*
   * Esc 分两层：全屏时第一下只退出全屏（还在写，不该一下把弹窗关掉、更不该丢掉草稿），
   * 回到卡片态后再按一次才关弹窗（那一层交给 antd Modal 自己处理）。
   * 必须走捕获阶段并 stopPropagation：否则同一次按键会继续冒泡到 rc-dialog，
   * 变成「一按 Esc 既退全屏又关弹窗」。
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
     退出全屏再还给「全屏写作」，不让焦点掉回 body。初次挂载不抢焦点。 */
  useEffect(() => {
    if (fullscreen) {
      wasFullscreen.current = true
      exitRef.current?.focus()
    } else if (wasFullscreen.current) {
      wasFullscreen.current = false
      toggleRef.current?.focus()
    }
  }, [fullscreen])

  /* 点按钮退出全屏时，焦点会跟着被隐藏的那个按钮一起掉到 body（Esc 那条路是键盘事件，
     焦点本来就还在，所以不受影响）。这里在形态切换后补一次兜底：焦点若已不在弹窗内，
     交还给「全屏写作」，键盘用户不会一下子失去落点。 */
  useEffect(() => {
    if (fullscreen) return
    const modal = document.querySelector('.note-writer-modal')
    if (!modal) return
    const timer = window.setTimeout(() => {
      const active = document.activeElement
      if (active && active !== document.body && modal.contains(active)) return
      toggleRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [fullscreen])

  const exitFullscreen = useCallback(() => setFullscreen(false), [])

  /**
   * ≤640px：卡片态不再提供「分栏」—— 760px 的弹窗里两栏各只有 ~190px，
   * 编辑器和预览都读不了。这里按 JS 断点直接换一套模式集合（不是纯样式问题：
   * 分段控件的档位数量变了，只能由 JS 决定），窄屏下退回「编辑 / 预览」二选一。
   */
  const narrow = useMediaQuery(BP.smDown)
  const availableModes: NoteWriterMode[] = narrow ? ['edit', 'preview'] : ['edit', 'split', 'preview']
  /** 窄屏 + 快照里存的是「分栏」时降级成「编辑」：分栏这一档在当前宽度下不可选 */
  const cardMode: NoteWriterMode = narrow && mode === 'split' ? 'edit' : mode

  const charCount = noteCharCount(value)
  const lineCount = noteLineCount(value)
  /** 全屏态隐藏分段控件，编辑模式固定成三栏里的「左栏编辑」 */
  const editorMode: NoteWriterMode = fullscreen ? 'edit' : cardMode

  const saveAndClose = () => {
    if (saving) return
    onSave()
  }

  const footer = (
    <div className="note-writer-footer">
      <Button
        ref={toggleRef}
        type="text"
        className="note-writer-toggle"
        icon={fullscreen ? <CompressOutlined /> : <ExpandOutlined />}
        onClick={() => setFullscreen((v) => !v)}
        aria-pressed={fullscreen}
        title={fullscreen ? '回到卡片（Esc）' : '全屏三栏写作（正文吃满整屏）'}
      >
        {fullscreen ? '退出全屏' : '全屏写作'}
      </Button>
      <span className="note-writer-footer-meta" role="status">
        {charCount} 字{lineCount > 0 ? ` · ${lineCount} 行` : ''}
      </span>
      <span className="note-writer-footer-actions">
        <Button onClick={onClose} disabled={saving}>取消</Button>
        <Button type="primary" onClick={saveAndClose} loading={saving}>保存</Button>
      </span>
    </div>
  )

  return (
    <Modal
      open
      onCancel={() => { if (!saving) onClose() }}
      width={noteWriterWidth(fullscreen)}
      destroyOnHidden
      className={`note-writer-modal${fullscreen ? ' is-fullscreen' : ''}`}
      /* 全屏态下 antd 自带的 X 与 Esc 都禁用：X 会直接关掉整个弹窗（还在写的时候很致命），
         Esc 由上面那层捕获监听接管。卡片态保持 antd 默认行为。 */
      closable={!fullscreen}
      keyboard={!fullscreen}
      maskClosable={false}
      footer={footer}
      /* 全屏态也要给 title：rc-dialog 用 aria-labelledby 指向标题节点，
         真删掉它，全屏弹窗在屏幕阅读器里就是「一个没有名字的对话框」。
         所以全屏只留一行纯文本标题，由 CSS 视觉隐藏（见 index.css 的 .is-fullscreen .ant-modal-header）。 */
      title={
        fullscreen ? (
          <span className="note-writer-fs-title">
            {kindLabel}{subject ? ` · ${subject}` : ''}
          </span>
        ) : (
          <div className="note-writer-head">
            <div className="note-writer-heading" title={subject ? `${kindLabel} · ${subject}` : kindLabel}>
              <span className="note-writer-kicker">{kindLabel}</span>
              {subject ? <span className="note-writer-subject">{subject}</span> : null}
            </div>
          </div>
        )
      }
    >
      {fullscreen ? (
        <div className="note-writer-fs">
          <div className="note-writer-fsbar">
            <span className="note-writer-fsbar-title">
              {kindLabel}{subject ? ` · ${subject}` : ''}
            </span>
            <span className="note-writer-fsbar-tools">
              <ZoomControl kind="note" />
              <button
                ref={exitRef}
                type="button"
                className="note-card-exit"
                aria-label={`退出全屏写作（${kindLabel}${subject ? ` · ${subject}` : ''}）`}
                onClick={exitFullscreen}
              >
                <CompressOutlined />
                <span>退出全屏</span>
                <kbd>Esc</kbd>
              </button>
            </span>
          </div>

          <div className="note-writer-grid">
            <section className="note-writer-pane is-preview" aria-label={`${kindLabel}实时渲染预览`}>
              <div className="note-writer-pane-head">
                <span className="note-writer-pane-title">
                  <span className="note-writer-pane-index">01</span>
                  实时预览
                </span>
                <span className="note-writer-live"><i aria-hidden />跟随改动</span>
              </div>
              <div className="note-writer-preview-scroll" data-note-zoom>
                {value.trim() ? <Markdown text={value} /> : <p className="note-writer-preview-empty">还没有内容 —— 右边写下的每一句都会实时渲染在这里。</p>}
              </div>
            </section>

            <aside className="note-writer-pane is-side" aria-label={`${kindLabel}写作上下文`}>
              <div className="note-writer-pane-head">
                <span className="note-writer-pane-title">
                  <span className="note-writer-pane-index">02</span>
                  写作上下文
                </span>
              </div>
              <div className="note-writer-side-scroll">
                {meta ? <div className="note-writer-side-meta">{meta}</div> : null}
                {context ? <div className="note-writer-side-block">{context}</div> : null}
                {reference && reference.text.trim() ? (
                  <div className="note-writer-side-block">
                    <div className="note-writer-side-label">{reference.title}</div>
                    <div className="note-writer-side-doc" data-note-zoom>
                      <Markdown text={reference.text} />
                    </div>
                  </div>
                ) : null}
                <div className="note-writer-side-block">
                  <div className="note-writer-side-label">写作提示</div>
                  <ul className="note-writer-side-tips">
                    <li>Ctrl / ⌘ + B 粗体、+ I 斜体；截图直接 Ctrl + V 粘贴上传。</li>
                    <li>Ctrl + 滚轮在正文或预览上可放大笔记文字（50%–200%）。</li>
                    <li>写作区在最右侧；Esc 第一下退出全屏、第二下关闭弹窗，未保存内容会随弹窗一起丢弃。</li>
                    <li>形态与编辑模式会被记住，下次打开直接回到这个姿势。</li>
                  </ul>
                </div>
              </div>
            </aside>

            <section className="note-writer-pane is-writer" aria-label={`${kindLabel} Markdown 写作区`}>
              <div className="note-writer-pane-head">
                <span className="note-writer-pane-title">
                  <span className="note-writer-pane-index">03</span>
                  MD 写作
                </span>
                <span className="note-writer-pane-meta">{charCount} 字</span>
              </div>
              <div className="note-writer-pane-body">
                <NoteEditor
                  value={value}
                  onChange={onChange}
                  mode={editorMode}
                  hideModeSwitch
                  fill
                  maxLength={maxLength}
                  placeholder={placeholder}
                />
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="note-writer-card">
          {meta ? <div className="note-writer-meta">{meta}</div> : null}
          <NoteEditor
            value={value}
            onChange={onChange}
            mode={cardMode}
            onModeChange={setMode}
            availableModes={availableModes}
            readingZoom
            height={420}
            maxLength={maxLength}
            placeholder={placeholder}
          />
          {/* 编辑模式的分段控件在 NoteEditor 工具栏里（受控），这里只补一句去全屏的指引 */}
          <p className="note-writer-card-hint">
            需要更大的写作面？点左下角「全屏写作」——三栏并排：左实时预览、中上下文、右写作。
          </p>
        </div>
      )}
    </Modal>
  )
}

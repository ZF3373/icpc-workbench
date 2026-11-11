import { readJson, writeJson } from './persistence.ts'

/**
 * 笔记写作的视图快照：记住上次是不是全屏写、以及卡内「编辑 / 分栏 / 预览」停在哪一档。
 *
 * 背景（issue #52 后续反馈）：模板库的「全屏三栏写作」用起来顺手，复习库的笔记编辑
 * 却还是一张固定 880px 的小卡片 —— 每次打开都要重新拉一次全屏、重新点一次分栏。
 * 这里只存「视图状态」，不碰笔记正文本身。
 *
 * 读取时做结构归一化：localStorage 是用户可以手改、也可能残留旧版本的，
 * 非法字段直接丢弃而不是让页面崩在恢复逻辑里（与 templateView.ts 同一套口径）。
 */

export const NOTE_WRITER_VIEW_KEY = 'icpc-note-writer-view-v1'

/** 写作模式：与 NoteEditor 工具栏的分段控件一一对应 */
export type NoteWriterMode = 'edit' | 'split' | 'preview'

export const NOTE_WRITER_MODES: readonly NoteWriterMode[] = ['edit', 'split', 'preview']

export interface NoteWriterViewState {
  /** 上次是否停在全屏三栏写作；默认关（弹卡是「随手记一句」的主路径） */
  fullscreen: boolean
  /** 上次的编辑模式；默认分栏（与 NoteEditor 的默认值保持一致） */
  mode: NoteWriterMode
}

export const DEFAULT_NOTE_WRITER_VIEW: NoteWriterViewState = { fullscreen: false, mode: 'split' }

export function isNoteWriterMode(value: unknown): value is NoteWriterMode {
  return typeof value === 'string' && (NOTE_WRITER_MODES as readonly string[]).includes(value)
}

/**
 * 归一化：
 * - 非对象 / 数组 / 没有可识别字段 → null（调用方用默认值）
 * - fullscreen 只认真正的布尔值，字符串 "false" 之类一律丢弃（JSON 手改很容易写错）
 * - mode 只认三个已知档位
 * - 两个字段都缺失时返回 null，避免把「空对象」当成一份有效快照
 */
export function normalizeNoteWriterViewState(raw: unknown): NoteWriterViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as { fullscreen?: unknown; mode?: unknown }
  const hasFullscreen = typeof value.fullscreen === 'boolean'
  const hasMode = isNoteWriterMode(value.mode)
  if (!hasFullscreen && !hasMode) return null
  return {
    fullscreen: hasFullscreen ? (value.fullscreen as boolean) : DEFAULT_NOTE_WRITER_VIEW.fullscreen,
    mode: hasMode ? (value.mode as NoteWriterMode) : DEFAULT_NOTE_WRITER_VIEW.mode,
  }
}

export function readNoteWriterViewState(): NoteWriterViewState | null {
  return normalizeNoteWriterViewState(readJson<unknown>(NOTE_WRITER_VIEW_KEY))
}

export function writeNoteWriterViewState(state: NoteWriterViewState): void {
  writeJson(NOTE_WRITER_VIEW_KEY, state)
}

/**
 * 写作弹窗的两种尺寸（对应 index.css 的 .note-writer-modal 与 .is-fullscreen）：
 * - card：默认弹卡，760px 定宽（与模板库写作弹窗的卡片态同宽）
 * - fullscreen：铺满整个应用窗口的三栏工作台
 *
 * 宽度的真源放在这里而不是组件里，是为了能直接单测 —— 全屏态一旦被写成
 * 固定像素，整页缩放（--app-zoom）后就会溢出视口（与 noteView.noteCardWidth 同一教训）。
 */
export function noteWriterWidth(fullscreen: boolean): number | string {
  return fullscreen ? 'var(--app-viewport-width)' : 760
}

/**
 * 全屏三栏的列宽比例，顺序即**视觉顺序**：实时预览 / 写作上下文 / MD 写作。
 * 写作区放在最右侧（反馈：右手边写、左边看渲染结果更顺手），并且给到最宽的一列。
 * 单测会拿这份顺序去比对 index.css 的 .note-writer-grid，两处不会漂移。
 */
export const NOTE_WRITER_COLUMNS = ['minmax(0, 1fr)', 'minmax(0, 0.9fr)', 'minmax(0, 1.25fr)'] as const

/**
 * 「笔记文字」缩放（`--note-text-zoom`）覆盖到全屏三栏的哪些栏。
 *
 * 背景（issue #62）：原来的 Ctrl+滚轮 / 加减按钮只认 `[data-note-zoom]` 锚点，
 * 而全屏三栏里只有 01 实时预览、以及 02 里的模板大纲渲染块打了这个标记 ——
 * 于是 02「写作上下文」的正文与 03「MD 写作」的编辑器**都不响应**缩放。
 * 用户看到的是「缩放面板的百分数在涨（截图里的『笔记已放大 140%』），
 * 但这两栏的字号纹丝不动」。
 *
 * 这三栏读的都是同一篇笔记，字号理应同进同退，所以三栏全部纳入缩放范围：
 * - 01 实时预览：Markdown 渲染，已有 `[data-note-zoom] ` 那套字号规则；
 * - 02 写作上下文：正文、标签与提示，按正文基准 12px 乘同一个系数；
 * - 03 MD 写作：CodeMirror 编辑器，字号走 `--note-text-zoom` 而不是硬编码 12.5px。
 *
 * 只作用于**正文**：栏头（01/02/03 标题、字数）、缩放控件与「退出全屏」按钮
 * 都不缩放 —— 与卡片态「缩放读长笔记的正文，而不是整张 UI」同一口径。
 * 单测会比对 index.css，确认这三个锚点真实存在且三栏都在作用域内。
 */
export const NOTE_WRITER_ZOOM_PANES = ['01', '02', '03'] as const
/**
 * 字数统计：剥掉空白后的字符数（中文按字、英文按字母，跟「写了多少内容」的直觉一致）。
 * 空格与换行不计入，避免「敲了一堆空行」被当成写了很多。
 */
export function noteCharCount(text: string | null | undefined): number {
  if (typeof text !== 'string') return 0
  return text.replace(/\s+/g, '').length
}

/** 行数：空文本算 0 行（编辑器里那一个空行不是「一行内容」） */
export function noteLineCount(text: string | null | undefined): number {
  if (typeof text !== 'string' || text === '') return 0
  return text.split(/\r?\n/).length
}

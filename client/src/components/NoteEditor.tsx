import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { App as AntdApp, Button, Segmented, Tooltip } from 'antd'
import {
  BoldOutlined,
  CodeOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  StrikethroughOutlined,
  TableOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { EditorSelection } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import CodeEditor from './CodeEditor'
import Markdown from './Markdown'
import ZoomControl from './ZoomControl'
import { uploadImage } from '../api'

/**
 * 笔记编辑器（复习笔记 / 学习笔记共用）：洛谷题解式排版体验 ——
 *
 * - 工具栏：标题分级（H1/H2/H3）、粗斜体、行内代码、代码块、列表、引用、
 *   表格、链接、图片上传；点击即改写 CodeMirror 文档，不引入第二套编辑内核。
 * - 粘贴 / 拖拽图片：截图后 Ctrl+V 直接上传到 /api/uploads，先插入
 *   `![uploading-xxx]()` 占位、成功后原地替换成正式引用，失败移除占位并提示 ——
 *   上传期间可以继续打字，光标不会被抢走。
 * - 编辑 / 分栏 / 预览：预览复用 AI 回复同一套 Markdown 渲染（GFM 表格、
 *   KaTeX 公式、代码卡），所见即所得。
 *
 * 切到「预览」时编辑器整体卸载：value 由父组件完全受控，重新切回时内容无损，
 * 只是光标归位 —— 工具栏操作以 viewRef 是否存活作守卫，不触碰已销毁的视图。
 */

interface NoteEditorProps {
  value: string
  onChange: (value: string) => void
  /** 编辑区高度（px），预览面板同高 */
  height?: number
  placeholder?: string
  maxLength?: number
  /** 模板学习笔记的预览区复用笔记阅读字号，不改变编辑器和工具栏。 */
  readingZoom?: boolean
}

/** 服务端 /api/uploads 的格式白名单（仅 PNG/JPEG/GIF/WebP） */
const IMAGE_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

function isUploadableImage(blob: Blob): boolean {
  return blob.type.split(';')[0].trim().toLowerCase() in IMAGE_TYPE_EXT
}

/** 从剪贴板里取全部图片文件（截图 / 复制的图片） */
function imageBlobsFromDataTransfer(dt: DataTransfer | null): Blob[] {
  if (!dt) return []
  const out: Blob[] = []
  for (const item of Array.from(dt.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/** 工具栏小按钮：文本字形的（H1 / ❝ / </>）与图标按钮共用这一层 */
function ToolButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip title={title}>
      <Button type="text" size="small" className="note-tool-btn" onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        {children}
      </Button>
    </Tooltip>
  )
}

export default function NoteEditor({ value, onChange, height = 400, placeholder, maxLength = 20000, readingZoom = false }: NoteEditorProps) {
  const { message } = AntdApp.useApp()
  const viewRef = useRef<EditorView | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split')

  /** 编辑操作一律过这个守卫：预览态编辑器已卸载，viewRef 为空时忽略点击 */
  const withView = useCallback((fn: (view: EditorView) => void) => {
    if (viewRef.current) fn(viewRef.current)
  }, [])

  /** 包裹选区：`**x**` / `*x*` / `` `x` `` / `[x](url)`；已包裹则解开（再点一次还原）。
   *  返回是否实际处理（view 不存活时 false，供 CodeMirror Command 使用） */
  const wrap = useCallback((before: string, after: string): boolean => {
    const view = viewRef.current
    if (!view) return false
    const state = view.state
    const tr = state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to)
      if (
        selected.length >= before.length + after.length &&
        selected.startsWith(before) &&
        selected.endsWith(after)
      ) {
        return {
          changes: { from: range.from, to: range.to, insert: selected.slice(before.length, selected.length - after.length) },
          range: EditorSelection.range(range.from, range.to - before.length - after.length),
        }
      }
      return {
        changes: { from: range.from, to: range.to, insert: before + selected + after },
        range: selected
          ? EditorSelection.range(range.from + before.length, range.from + before.length + selected.length)
          : EditorSelection.cursor(range.from + before.length),
      }
    })
    view.dispatch(tr)
    view.focus()
    return true
  }, [])

  /** 行首前缀开关：标题 / 列表 / 引用；已带同款前缀的行去掉，其余加上 */
  const linePrefix = useCallback(
    (prefix: string) =>
      withView((view) => {
        const state = view.state
        const byLine = new Map<number, { from: number; to?: number; insert?: string }>()
        for (const range of state.selection.ranges) {
          const fromLine = state.doc.lineAt(range.from)
          const toLine = state.doc.lineAt(range.to)
          for (let ln = fromLine.number; ln <= toLine.number; ln++) {
            const line = state.doc.line(ln)
            if (byLine.has(ln)) continue // 多选区落在同一行时只处理一次
            if (line.text.startsWith(prefix)) {
              byLine.set(ln, { from: line.from, to: line.from + prefix.length, insert: '' })
            } else {
              byLine.set(ln, { from: line.from, insert: prefix })
            }
          }
        }
        const changes = Array.from(byLine.values()).sort((a, b) => a.from - b.from)
        if (changes.length > 0) view.dispatch({ changes })
        view.focus()
      }),
    [withView],
  )

  /** 光标处插入文本（表格骨架、代码块语言标记等） */
  const insertAtCursor = useCallback(
    (text: string) =>
      withView((view) => {
        view.dispatch(view.state.replaceSelection(text))
        view.focus()
      }),
    [withView],
  )

  const replaceText = useCallback((view: EditorView, search: string, replace: string) => {
    const idx = view.state.doc.toString().indexOf(search)
    if (idx === -1) return
    view.dispatch({ changes: { from: idx, to: idx + search.length, insert: replace } })
  }, [])

  /** 上传并在光标处落引用；占位符先占位、成功后原地替换，失败撤除。
   *  光标不在空行时先另起一段：避免图片引用紧跟表格/文字行，被 GFM 解析进上一行结构（洛谷同款问题） */
  const uploadAndInsert = useCallback(
    async (blobs: Blob[]) => {
      for (const blob of blobs) {
        if (!isUploadableImage(blob)) {
          message.error(`不支持的图片格式：${blob.type || '未知'}（仅 PNG / JPEG / GIF / WebP）`)
          continue
        }
        if (blob.size > 5 * 1024 * 1024) {
          message.error(`图片超过 5 MiB 上限（${(blob.size / 1024 / 1024).toFixed(1)} MiB）`)
          continue
        }
        const token = `uploading-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        const ph = `![${token}]()`
        withView((view) => {
          const line = view.state.doc.lineAt(view.state.selection.main.head)
          const lead = line.text.trim() === '' ? '' : '\n\n'
          view.dispatch(view.state.replaceSelection(lead + ph))
        })
        try {
          const { url } = await uploadImage(blob)
          withView((view) => replaceText(view, ph, `![图片](${url})`))
        } catch (e) {
          withView((view) => replaceText(view, ph, ''))
          message.error(`图片上传失败：${(e as Error).message}`)
        }
      }
    },
    [message, replaceText, withView],
  )

  // 粘贴 / 拖拽图片：挂进 CodeMirror 的 DOM 事件扩展；无图片时返回 false 放行普通粘贴。
  // 顺带绑 Ctrl/Cmd+B 粗体、Ctrl/Cmd+I 斜体，与工具栏提示一致。
  const eventExtensions = useMemo(
    () => [
      keymap.of([
        { key: 'Mod-b', run: () => wrap('**', '**') },
        { key: 'Mod-i', run: () => wrap('*', '*') },
      ]),
      EditorView.domEventHandlers({
        paste: (event) => {
          const blobs = imageBlobsFromDataTransfer(event.clipboardData)
          if (blobs.length === 0) return false
          event.preventDefault()
          void uploadAndInsert(blobs)
          return true
        },
        drop: (event) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(isUploadableImage)
          if (files.length === 0) return false
          event.preventDefault()
          void uploadAndInsert(files)
          return true
        },
      }),
    ],
    [uploadAndInsert, wrap],
  )

  const pickImages = useCallback(() => fileRef.current?.click(), [])

  const onFilesPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = '' // 允许重复选择同一文件
      if (files.length > 0) void uploadAndInsert(files)
    },
    [uploadAndInsert],
  )

  return (
    <div className="note-editor">
      <div className="note-editor-toolbar">
        <ToolButton title="一级标题" onClick={() => linePrefix('# ')}>
          <span className="note-tool-glyph">H1</span>
        </ToolButton>
        <ToolButton title="二级标题" onClick={() => linePrefix('## ')}>
          <span className="note-tool-glyph">H2</span>
        </ToolButton>
        <ToolButton title="三级标题" onClick={() => linePrefix('### ')}>
          <span className="note-tool-glyph">H3</span>
        </ToolButton>
        <span className="note-tool-divider" />
        <ToolButton title="粗体（Ctrl+B）" onClick={() => wrap('**', '**')}>
          <BoldOutlined />
        </ToolButton>
        <ToolButton title="斜体" onClick={() => wrap('*', '*')}>
          <ItalicOutlined />
        </ToolButton>
        <ToolButton title="删除线" onClick={() => wrap('~~', '~~')}>
          <StrikethroughOutlined />
        </ToolButton>
        <ToolButton title="行内代码" onClick={() => wrap('`', '`')}>
          <CodeOutlined />
        </ToolButton>
        <ToolButton title="代码块（C++）" onClick={() => wrap('```cpp\n', '\n```')}>
          <span className="note-tool-glyph">{'</>'}</span>
        </ToolButton>
        <span className="note-tool-divider" />
        <ToolButton title="无序列表" onClick={() => linePrefix('- ')}>
          <UnorderedListOutlined />
        </ToolButton>
        <ToolButton title="有序列表" onClick={() => linePrefix('1. ')}>
          <OrderedListOutlined />
        </ToolButton>
        <ToolButton title="引用" onClick={() => linePrefix('> ')}>
          <span className="note-tool-glyph">❝</span>
        </ToolButton>
        <ToolButton
          title="表格"
          onClick={() => insertAtCursor('\n| 项目 | 内容 |\n| --- | --- |\n|  |  |\n')}
        >
          <TableOutlined />
        </ToolButton>
        <ToolButton title="链接" onClick={() => wrap('[', '](url)')}>
          <LinkOutlined />
        </ToolButton>
        <span className="note-tool-divider" />
        <ToolButton title="插入图片（也可直接粘贴 / 拖入截图）" onClick={pickImages}>
          <PictureOutlined />
        </ToolButton>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={onFilesPicked}
        />
        <span className="note-editor-spacer" />
        {readingZoom && <ZoomControl kind="note" />}
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as 'edit' | 'split' | 'preview')}
          options={[
            { label: '编辑', value: 'edit' },
            { label: '分栏', value: 'split' },
            { label: '预览', value: 'preview' },
          ]}
        />
      </div>
      {mode !== 'preview' ? (
        <div className="note-editor-body">
          <div className="note-editor-pane">
            <CodeEditor
              language="markdown"
              value={value}
              onChange={onChange}
              height={height}
              placeholder={placeholder}
              maxLength={maxLength}
              onCreateEditor={(view) => {
                viewRef.current = view
              }}
              extraExtensions={eventExtensions}
            />
          </div>
          {mode === 'split' && (
            <div className="note-editor-preview" data-note-zoom={readingZoom ? true : undefined} style={{ height }}>
              <Markdown text={value} />
            </div>
          )}
        </div>
      ) : (
        <div className="note-editor-preview note-editor-preview-full" data-note-zoom={readingZoom ? true : undefined} style={{ height }}>
          <Markdown text={value} />
        </div>
      )}
    </div>
  )
}

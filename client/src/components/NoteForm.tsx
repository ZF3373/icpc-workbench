import { useRef, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { App as AntdApp, Button, Input, Select, Tooltip } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CodeOutlined,
  DeleteOutlined,
  FileMarkdownOutlined,
  LoadingOutlined,
  PaperClipOutlined,
  PictureOutlined,
} from '@ant-design/icons'
import CodeEditor from './CodeEditor'
import NoteEditor from './NoteEditor'
import { uploadAttachment, uploadImage } from '../api'
import {
  CODE_LANGUAGE_OPTIONS,
  formatFileSize,
  MAX_NOTE_LABELS,
  moveBlock,
  newBlock,
  NOTE_LABEL_OPTIONS,
  type DraftBlock,
  type NoteBlockType,
  type NoteDraft,
  type NoteDraftUpdate,
} from '../problemNotes'

const MAX_BLOCK_TEXT = 100_000
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

const BLOCK_META: Record<NoteBlockType, { label: string; icon: ReactNode }> = {
  markdown: { label: 'Markdown', icon: <FileMarkdownOutlined /> },
  code: { label: '代码', icon: <CodeOutlined /> },
  image: { label: '图片', icon: <PictureOutlined /> },
  attachment: { label: '附件', icon: <PaperClipOutlined /> },
}
const ADD_ORDER: NoteBlockType[] = ['markdown', 'code', 'image', 'attachment']

const FRAME: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }
const FRAME_HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px 4px 12px',
  borderBottom: '1px solid var(--line)',
  color: 'var(--text-2)',
  fontSize: 12,
}
const DROP_ZONE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '28px 12px',
  textAlign: 'center',
  border: '1px dashed var(--line)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
}

/**
 * 笔记结构编辑器：笔记由独立的框组成，框的类型、数量、顺序都由用户决定；
 * 默认的 Markdown 框和其它框一样可以删除。空框保存时略去。
 *
 * onChange 收更新函数而不是新值：文件上传是异步的，完成时用户可能已改了别的框，
 * 按旧快照写回会把这些修改覆盖掉。
 */
export default function NoteForm({ value, onChange }: { value: NoteDraft; onChange: (update: NoteDraftUpdate) => void }) {
  const { message } = AntdApp.useApp()

  const patchBlock = (key: string, patch: Partial<DraftBlock>): void => {
    onChange((d) => ({ ...d, blocks: d.blocks.map((b) => (b.key === key ? ({ ...b, ...patch } as DraftBlock) : b)) }))
  }
  const removeBlock = (key: string): void => {
    onChange((d) => ({ ...d, blocks: d.blocks.filter((b) => b.key !== key) }))
  }

  /** 第一个文件填进当前框，其余各占一个新框，紧跟在当前框之后 */
  const upload = (key: string, type: 'image' | 'attachment', files: File[]): void => {
    if (files.length === 0) return
    const extras = files.slice(1).map(() => newBlock(type))
    const targets = [key, ...extras.map((b) => b.key)]
    onChange((d) => {
      const at = d.blocks.findIndex((b) => b.key === key)
      const blocks = [...d.blocks]
      blocks.splice(at + 1, 0, ...extras)
      return { ...d, blocks: blocks.map((b) => (targets.includes(b.key) ? ({ ...b, uploading: true } as DraftBlock) : b)) }
    })
    files.forEach((file, i) => {
      const target = targets[i]
      const job =
        type === 'image'
          ? uploadImage(file).then(({ url }) => ({ url, name: file.name, uploading: false }))
          : uploadAttachment(file).then((r) => ({ ...r, uploading: false }))
      job
        .then((patch) => patchBlock(target, patch))
        .catch((e: Error) => {
          message.error(`${file.name} 上传失败：${e.message}`)
          patchBlock(target, { uploading: false })
        })
    })
  }

  return (
    <div>
      <Select
        mode="tags"
        allowClear
        maxCount={MAX_NOTE_LABELS}
        style={{ width: '100%', marginBottom: 12 }}
        placeholder="标注（可选，可自定义，如 思路 / 踩坑 / 待回看）"
        aria-label="笔记标注"
        options={NOTE_LABEL_OPTIONS}
        value={value.labels}
        onChange={(labels: string[]) => onChange((d) => ({ ...d, labels }))}
      />
      {value.blocks.length === 0 && (
        <div style={{ ...DROP_ZONE, cursor: 'default', marginBottom: 12 }}>笔记还是空的，从下面选择要增加的条目</div>
      )}
      {value.blocks.map((block, index) => (
        <div key={block.key} style={FRAME} data-note-block={block.type}>
          <div style={FRAME_HEAD}>
            {BLOCK_META[block.type].icon}
            <span>{BLOCK_META[block.type].label}</span>
            {block.type === 'code' && (
              <Select
                size="small"
                variant="borderless"
                style={{ width: 120 }}
                aria-label="代码语言"
                options={CODE_LANGUAGE_OPTIONS}
                value={block.language}
                onChange={(language: string) => patchBlock(block.key, { language })}
              />
            )}
            <span style={{ flex: 1 }} />
            <Tooltip title="上移">
              <Button type="text" size="small" aria-label="上移" icon={<ArrowUpOutlined />} disabled={index === 0}
                onClick={() => onChange((d) => ({ ...d, blocks: moveBlock(d.blocks, block.key, -1) }))} />
            </Tooltip>
            <Tooltip title="下移">
              <Button type="text" size="small" aria-label="下移" icon={<ArrowDownOutlined />} disabled={index === value.blocks.length - 1}
                onClick={() => onChange((d) => ({ ...d, blocks: moveBlock(d.blocks, block.key, 1) }))} />
            </Tooltip>
            <Tooltip title="删除这个框">
              <Button type="text" size="small" danger aria-label="删除这个框" icon={<DeleteOutlined />} onClick={() => removeBlock(block.key)} />
            </Tooltip>
          </div>
          <div style={{ padding: block.type === 'code' ? 0 : 8 }}>
            {block.type === 'markdown' && (
              <NoteEditor
                readingZoom
                value={block.text}
                onChange={(text) => patchBlock(block.key, { text })}
                height={220}
                maxLength={MAX_BLOCK_TEXT}
                placeholder="思路、踩过的坑、与哪些题联系紧密……（Markdown 语法，可直接粘贴 / 拖入截图）"
              />
            )}
            {block.type === 'code' && (
              <CodeEditor
                language={block.language === 'cpp' || block.language === 'c' ? 'cpp' : 'plain'}
                value={block.code}
                onChange={(code) => patchBlock(block.key, { code })}
                height={240}
                maxLength={MAX_BLOCK_TEXT}
                placeholder="粘贴或输入代码"
              />
            )}
            {block.type === 'image' && (
              <FileBox accept={IMAGE_ACCEPT} hint="点击选择图片，或拖入 / 粘贴截图（PNG / JPEG / GIF / WebP，单张 5 MiB 内）" uploading={block.uploading}
                onFiles={(files) => upload(block.key, 'image', files)}>
                {block.url && (
                  <>
                    <img src={block.url} alt={block.caption || block.name} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, margin: '0 auto 8px', borderRadius: 4 }} />
                    <Input
                      size="small"
                      maxLength={500}
                      placeholder="图片说明（可选）"
                      aria-label="图片说明"
                      value={block.caption}
                      onChange={(e) => patchBlock(block.key, { caption: e.target.value })}
                    />
                  </>
                )}
              </FileBox>
            )}
            {block.type === 'attachment' && (
              <FileBox hint="点击选择文件，或拖入文件（任意类型，单个 50 MiB 内）" uploading={block.uploading}
                onFiles={(files) => upload(block.key, 'attachment', files)}>
                {block.url && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PaperClipOutlined />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{block.name}</span>
                    <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatFileSize(block.size)}</span>
                  </div>
                )}
              </FileBox>
            )}
          </div>
        </div>
      ))}
      <div style={{ position: 'sticky', bottom: 0, display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0', background: 'var(--surface-2)' }}>
        {ADD_ORDER.map((type) => (
          <Button key={type} size="small" icon={BLOCK_META[type].icon}
            onClick={() => onChange((d) => ({ ...d, blocks: [...d.blocks, newBlock(type)] }))}>
            增加{BLOCK_META[type].label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** 图片/附件框：没有文件时是上传区；有文件时显示内容（children），不再占用上传区 */
function FileBox({ accept, hint, uploading, onFiles, children }: {
  accept?: string
  hint: string
  uploading?: boolean
  onFiles: (files: File[]) => void
  children: ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  if (uploading) {
    return <div style={{ ...DROP_ZONE, cursor: 'default' }}><LoadingOutlined /> 正在上传…</div>
  }
  if (children) return <>{children}</>
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    onFiles(Array.from(e.dataTransfer.files))
  }
  const onPaste = (e: ClipboardEvent): void => {
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      onFiles(files)
    }
  }
  return (
    <>
      <button type="button" style={DROP_ZONE} onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPaste={onPaste}>
        {hint}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={accept}
        aria-label={hint}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          onFiles(files)
        }}
      />
    </>
  )
}

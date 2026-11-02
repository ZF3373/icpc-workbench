import { App as AntdApp, Button, Image } from 'antd'
import { DownloadOutlined, PaperClipOutlined } from '@ant-design/icons'
import Markdown from './Markdown'
import { saveUrlAsFile } from '../download'
import { codeFence, formatFileSize, type NoteBlock } from '../problemNotes'

/** 按用户排好的结构展示笔记；代码沿用 Markdown 的代码卡，附件走下载（不在页面内打开） */
export default function NoteBlocksView({ blocks }: { blocks: readonly NoteBlock[] }) {
  const { message } = AntdApp.useApp()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'markdown':
            return <div key={i} data-note-zoom><Markdown text={block.text} /></div>
          case 'code':
            return <div key={i} data-note-zoom><Markdown text={codeFence(block.language, block.code)} /></div>
          case 'image':
            return (
              <figure key={i} style={{ margin: 0 }}>
                <Image src={block.url} alt={block.caption || block.name} style={{ maxWidth: '100%', maxHeight: 360 }} />
                {block.caption && <figcaption style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 4 }}>{block.caption}</figcaption>}
              </figure>
            )
          case 'attachment':
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 6 }}>
                <PaperClipOutlined />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={block.name}>{block.name}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatFileSize(block.size)}</span>
                <Button
                  type="text"
                  size="small"
                  aria-label={`下载 ${block.name}`}
                  icon={<DownloadOutlined />}
                  onClick={() => void saveUrlAsFile({
                    url: block.url,
                    filename: block.name,
                    mime: 'application/octet-stream',
                    binary: true,
                    successText: false,
                    message,
                  })}
                />
              </div>
            )
        }
      })}
    </div>
  )
}

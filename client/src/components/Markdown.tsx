import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 用户写入的 Markdown 渲染（模板思路 / 笔记等）：默认转义 HTML，支持 GFM 表格与删除线 */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

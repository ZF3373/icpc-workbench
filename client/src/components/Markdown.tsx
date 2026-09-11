import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { preprocessMath } from './markdownMath'

/** 用户写入的 Markdown 渲染（模板思路 / 笔记等）：默认转义 HTML，支持 GFM 表格、删除线与数学公式 */
export default function Markdown({ text }: { text: string }) {
  const processed = preprocessMath(text)
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

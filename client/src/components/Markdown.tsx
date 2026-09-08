import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

/**
 * 剥离 AI 输出中误加的外层代码围栏：当整段文本被 ```markdown / ```json 等围栏包裹时，
 * ReactMarkdown 会将其渲染为 <pre><code> 而非解析内部 markdown。此处提取围栏内的正文。
 */
function stripOuterCodeFence(text: string): string {
  const m = text.match(/^```[a-zA-Z]*\n([\s\S]*)\n?```\s*$/)
  return m ? m[1] : text
}

/** 用户写入的 Markdown 渲染（模板思路 / 笔记等）：默认转义 HTML，支持 GFM 表格、删除线与数学公式 */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {stripOuterCodeFence(text)}
      </ReactMarkdown>
    </div>
  )
}

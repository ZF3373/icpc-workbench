import { memo, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import type { Element, Root } from 'hast'
import 'katex/dist/katex.min.css'
import { CaretRightOutlined, CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { preprocessMath } from './markdownMath.ts'
import { normalizeLang } from './markdownCode.ts'
import { repairStreamingMarkdown, findStableBlockSplit } from './markdownStream.ts'
import { reportMathIssues } from './markdownDiag.ts'
import { rehypeBrAllowlist } from './markdownBr.ts'

/**
 * Markdown 渲染（AI 回复 / 模板思路 / 笔记 / 题单描述）：
 * 默认转义 HTML，支持 GFM 表格、任务列表、删除线、数学公式与代码语法高亮。
 *
 * 三类内容分开渲染，视觉上必须一眼可辨：
 *   · 代码 —— 代码卡：语言标签 + 语法高亮 + 悬停复制 + 超长内容折叠（等宽字体、缩进底）
 *   · 公式 —— KaTeX：块级公式居中并带横向滚动，行内公式与正文基线对齐
 *   · 文字 —— 常规排版：标题层级、列表、引用、表格
 * 「代码 / 公式 / 文字」的身份判定在 preprocessMath + markdownCode 中完成，
 * 本组件只负责把它们渲染成对应的外观。
 *
 * 流式输出时（`streaming`）做两件事：
 *   1. 经 markdownStream 补上未闭合的定界符、截掉写了一半的链接 ——
 *      否则每一帧屏幕末尾都会闪出字面的 `**`、`` ` ``、`$$`、`](https://…`；
 *   2. 按「已写定的块 / 还在增长的块」切成两段渲染（见 findStableBlockSplit），
 *      前段字符串没变化就被 memo 整段跳过，只有尾段每帧重解析 ——
 *      这是长回复流式输出时避免重复渲染与抖动的关键。
 *
 * 安全：不引入 rehype-raw，AI 输出里的 HTML 一律按纯文本转义 —— 唯一例外是
 * 无属性无内容的 `<br>`（GFM 表格单元格内换行的唯一写法，见 markdownBr.ts）；
 * 链接再经 urlTransform 过滤协议；KaTeX 关闭 trust（禁掉 \href 等可跳转命令）。
 */

/** 代码卡内超过该行数时折叠，避免 AI 贴几百行代码把消息撑爆 */
const COLLAPSE_LINES = 24

/**
 * 超过该字符数的代码块不做语法高亮。
 * 高亮是 O(n) 且流式期间每帧都要重跑一次，给超长块兜底，避免长回复卡住主线程。
 */
const HIGHLIGHT_MAX_CHARS = 20_000

/**
 * 是否开启 KaTeX 失败诊断（仅 vite dev）。生产构建里 `import.meta.env.DEV` 为常量
 * false，整个诊断分支被静态消除；静态渲染（node 里跑本组件）时 `import.meta.env`
 * 不存在，可选链会安全地取到 undefined。
 */
const DEV_DIAG = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true

/* ============================ hast 辅助（超大代码块兜底） ============================ */

/** 只取用到的字段，避免在组件里展开 hast 的完整联合类型 */
interface HastLike {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastLike[]
}

function hastText(node: HastLike): number {
  if (node.type === 'text') return node.value?.length ?? 0
  let n = 0
  for (const child of node.children ?? []) n += hastText(child)
  return n
}

function addHastClass(node: HastLike, cls: string): void {
  const properties = (node.properties ??= {})
  const list: unknown[] = Array.isArray(properties.className) ? [...properties.className] : []
  if (!list.includes(cls)) list.push(cls)
  properties.className = list
}

/**
 * 给过大的代码块打上 `no-highlight`：rehype-highlight 见到这个 class 会整块跳过，
 * 于是超长代码退回纯文本渲染，而不是把主线程耗在高亮上。
 */
function rehypeHighlightGuard() {
  const mark = (node: HastLike): void => {
    if (node.tagName === 'pre') {
      for (const child of node.children ?? []) {
        if (child.tagName === 'code' && hastText(child) > HIGHLIGHT_MAX_CHARS) {
          addHastClass(child, 'no-highlight')
        }
      }
    }
    for (const child of node.children ?? []) mark(child)
  }
  return (tree: Root): void => {
    mark(tree as unknown as HastLike)
  }
}

/* ============================ React 子节点辅助 ============================ */

interface MaybeElement {
  props?: { className?: unknown; children?: ReactNode }
}

/** 从 react-markdown 注入的 className（language-xxx）里取语言标记 */
function langFromClassName(className?: string): string {
  const m = /language-([\w+#.-]+)/.exec(className ?? '')
  return m ? normalizeLang(m[1]!) : ''
}

/**
 * 在 React 子树里找语言标记。
 * 高亮后 `<pre>` 的子节点是带 `hljs-*` span 的 `<code>` 元素，不能拼成纯文本再取，
 * 只能顺着 props 往下找。
 */
function langOf(node: ReactNode): string {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = langOf(child)
      if (found) return found
    }
    return ''
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as MaybeElement).props
    const className = props?.className
    const found = langFromClassName(typeof className === 'string' ? className : undefined)
    return found || langOf(props?.children)
  }
  return ''
}

/**
 * 递归取子树的纯文本（用于复制）。
 * 高亮把代码切成了一堆 span，直接显示用子树本身，复制时必须拼回原始文本。
 */
function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (typeof node === 'object' && 'props' in node) return collectText((node as MaybeElement).props?.children)
  return ''
}

/* ============================ 代码卡 ============================ */

/** 代码卡：语言标签 + 语法高亮 + 复制按钮 + 超长折叠 */
function CodeCard({ lang, code, children }: { lang: string; code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lineCount = code ? code.split('\n').length : 0
  const collapsible = lineCount > COLLAPSE_LINES

  const copy = useCallback(() => {
    const p = navigator.clipboard?.writeText(code)
    if (!p) return
    p.then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }).catch(() => {
      /* 剪贴板不可用（非安全上下文/权限拒绝）：静默忽略，用户仍可手动选择复制 */
    })
  }, [code])

  return (
    <div className={`md-code-card${expanded ? ' is-expanded' : ''}`}>
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button type="button" className="md-code-copy" onClick={copy} title="复制代码">
          {copied ? <CheckOutlined /> : <CopyOutlined />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="md-code-pre" data-collapsible={collapsible ? 'true' : undefined}>
        {children}
      </pre>
      {collapsible && (
        <button
          type="button"
          className="md-code-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          <CaretRightOutlined rotate={expanded ? 90 : 0} />
          {expanded ? '收起' : `展开全部 ${lineCount} 行`}
        </button>
      )}
    </div>
  )
}

/* ============================ 渲染体 ============================ */

/** 组件属性：`streaming` 表示这条消息**正在流式输出**（内容还会继续追加） */
interface MarkdownProps {
  text: string
  /**
   * 是否处于流式输出中。只有流式时才做「未闭合语法补全」：
   * 一段已经写完的文本里出现单个 `*`/`_`/`$` 是正常写法（`2 * 3`、`价格 $5`、
   * `push_back`），补符号会改变原意；而流式的每一帧本来就是半成品。
   */
  streaming?: boolean
}

/**
 * 渲染链接/图片地址：在 react-markdown 默认的协议过滤之上再收一道。
 * 只放行 http(s) / mailto / tel / 锚点 / 相对路径，
 * `javascript:`、`data:`、`vbscript:` 一律丢弃 —— AI 输出不可信，不能靠"它大概不会输出"。
 */
function safeUrlTransform(url: string, _key: string, _node: Element): string | null | undefined {
  const safe = defaultUrlTransform(url)
  if (!safe) return undefined
  if (/^(?:https?:\/\/|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(safe)) return safe
  // 不放行的协议：返回 undefined 让 react-markdown 直接不写 href/src，
  // 而不是写个空串（空 href 会跳回当前页，空 src 会让浏览器重新拉一次页面）
  return undefined
}

function MarkdownBody({ text, streaming = false }: MarkdownProps) {
  // 流式：先补上未闭合的定界符，再走公式预处理管线
  // （补全必须在 preprocessMath **之前**：管线按 `$…$`/`` `…` `` 定界符切分区域，
  //   定界符不配对时整段内容的身份判定都会跟着错）
  const source = streaming ? repairStreamingMarkdown(text) : text
  const processed = preprocessMath(source)

  // dev-only：把 KaTeX 解析失败的公式报到控制台（生产构建里不执行）
  useEffect(() => {
    if (DEV_DIAG) reportMathIssues(processed)
  }, [processed])

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // `<br>` 白名单：GFM 表格单元格内换行的唯一写法，零注入面（见 markdownBr）；
          // 必须在任何 rehype 插件里跑在 react-markdown 的 raw→文本转义之前，放最前
          rehypeBrAllowlist,
          // KaTeX：
          // - `throwOnError: false` —— 公式写错时退回源码文本，不整段崩掉；
          // - `trust: false` —— 禁掉 `\href`/`\url`/`\includegraphics` 等可跳转/外链命令；
          // - `maxExpand` / `maxSize` —— 挡住 `\def` 递归展开、超大 `\rule` 这类能把渲染拖死的输入。
          [rehypeKatex, { throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 100 }],
          // 高亮前先把过大的代码块标成 no-highlight（见 rehypeHighlightGuard）
          rehypeHighlightGuard,
          // 语法高亮：
          // - `detect: false` —— 不给没有语言标记的围栏猜语言。自动探测要把所有语法跑一遍，
          //   流式期间每帧一次太贵，且猜错会把说明文字涂成代码色；没标记就保持纯文本。
          [rehypeHighlight, { detect: false }],
        ]}
        urlTransform={safeUrlTransform}
        components={{
          // 代码块统一走代码卡（header 在 <pre> 之外，所以必须整体替换 <pre>）。
          // 子节点原样透传 —— 里面已经是 rehype-highlight 产出的带色 span，
          // 拼成纯文本再渲染会把高亮抹掉；复制用的纯文本另外用 collectText 取。
          pre: ({ children }) => <CodeCard lang={langOf(children)} code={collectText(children)}>{children}</CodeCard>,
          // 行内代码走 .markdown-body code 的内联样式，不替换
          // 表格：外层包裹以便窄屏横向滚动，不破坏表格自身布局
          table: ({ children, node: _node, ...rest }) => (
            <div className="md-table-wrap">
              <table {...rest}>{children}</table>
            </div>
          ),
          a: ({ href, children, node: _node, ...rest }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

/**
 * memo 化的渲染体：AI 流式输出时每一帧都会重渲染，而「已写定的历史块」文本不变，
 * memo 按 text 值比较即可整段跳过 Markdown 解析、KaTeX 排版与语法高亮。
 */
const MarkdownCore = memo(MarkdownBody)

/* ============================ 入口 ============================ */

/**
 * 流式时把「已写定的块」和「还在增长的块」拆成两个 memo 组件：
 * 前段的 text 每次都是同一个字符串 → memo 命中 → 完全不重新解析；
 * 只有尾段（通常就是正在打字的那一段/那个代码块）每帧重来。
 * 文档太短时 findStableBlockSplit 返回 -1，走原来的整体渲染，行为完全不变。
 */
function MarkdownStreaming({ text }: { text: string }) {
  const cut = findStableBlockSplit(text)
  if (cut <= 0) return <MarkdownCore text={text} streaming />
  return (
    <>
      <MarkdownCore text={text.slice(0, cut)} />
      <MarkdownCore text={text.slice(cut)} streaming />
    </>
  )
}

function MarkdownInner({ text, streaming = false }: MarkdownProps) {
  return streaming ? <MarkdownStreaming text={text} /> : <MarkdownCore text={text} />
}

/**
 * 导出即 memo：AI 流式输出时每一帧都会重渲染，而历史消息内容不变，
 * memo 按 text 值比较即可跳过全部历史消息的解析与排版。
 */
const Markdown = memo(MarkdownInner)

export default Markdown

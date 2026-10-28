import type { ReactNode } from 'react'
import { App as AntdApp, Button, Tag } from 'antd'
import { CopyOutlined, LinkOutlined } from '@ant-design/icons'
import { templateTierLabel } from '../../../shared/src/templateTiers.ts'
import CodeEditor from './CodeEditor'
import Markdown from './Markdown'
import { tagColor } from '../ui'
import type { TemplateContentInfo, TemplateStatus } from '../types'

/**
 * 模板正文的连续渲染体（模板阅读卡片 / 全屏写作的实时预览共用）。
 *
 * 刻意不拆成「大纲区 / 思路区 / 代码区」三块卡片：阅读时从上到下一镜到底，
 * 中间只有轻分隔线。写作预览也复用同一套排版，所见即所得。
 */

const STATUS_LABEL: Record<TemplateStatus, string> = {
  todo: '未学',
  learning: '学习中',
  mastered: '已掌握',
}

export interface TemplateDocumentProps {
  name: string
  custom?: boolean
  tags?: string[]
  difficulty?: number
  status?: TemplateStatus
  outline?: string | null
  content: TemplateContentInfo
  /** 写作预览中隐藏「开始写」空态引导；阅读卡片里由调用方给操作按钮 */
  preview?: boolean
  /** 隐藏文档自己的标题头（阅读卡片把标题放在弹窗标题栏时用） */
  showHead?: boolean
  emptyAction?: ReactNode
}

/** 只读代码的高度按行数展开：让外层容器负责连续滚动，不在代码块里再套一层滚动条 */
function readonlyCodeHeight(code: string): number {
  return Math.max(120, code.split('\n').length * 20 + 12)
}

export default function TemplateDocument({
  name,
  custom = false,
  tags = [],
  difficulty,
  status,
  outline,
  content,
  preview = false,
  showHead = true,
  emptyAction,
}: TemplateDocumentProps) {
  const { message } = AntdApp.useApp()
  const idea = content.idea?.trim() ?? ''
  const code = content.code?.trim() ?? ''
  const complexity = content.complexity?.trim() ?? ''
  const url = content.url?.trim() ?? ''
  const hasContent = Boolean(idea || code)
  const codeLines = code ? code.split('\n').length : 0

  const copyCode = () => {
    if (!code) return
    navigator.clipboard
      ?.writeText(code)
      .then(() => message.success('代码已复制'))
      .catch(() => message.warning('复制失败，请手动选择复制'))
  }

  return (
    <article className={`template-doc${preview ? ' is-preview' : ''}`}>
      {showHead && (
        <header className="template-doc-head">
          <div className="template-doc-title-row">
            <h2 className="template-doc-title">{name}</h2>
            {difficulty !== undefined && (
              <>
                <span className="template-stars" title={`难度 ${difficulty}/5`}>
                  {'★'.repeat(difficulty)}
                </span>
                <span className="template-tier">{templateTierLabel(difficulty)}</span>
              </>
            )}
            {status && <Tag className="template-doc-status">{STATUS_LABEL[status]}</Tag>}
            {custom && <Tag color="geekblue">自建</Tag>}
          </div>
          {tags.length > 0 && (
            <div className="template-doc-tags">
              {tags.map((tag) => (
                <Tag key={tag} color={tagColor(tag)}>
                  {tag}
                </Tag>
              ))}
            </div>
          )}
        </header>
      )}

      {outline && (
        <section className="template-doc-section template-doc-outline">
          <div className="template-doc-label">大纲要点</div>
          <p className="template-doc-outline-text">{outline}</p>
        </section>
      )}

      {(complexity || url) && (
        <div className="template-doc-meta">
          {complexity && <span className="template-chip">{complexity}</span>}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="template-example">
              <LinkOutlined /> {custom ? '模板出处' : '参考链接'} ↗
            </a>
          )}
        </div>
      )}

      {idea && (
        <section className="template-doc-section">
          <div className="template-doc-label">{custom ? '思路与备注' : '我的思路'}</div>
          <div className="template-doc-prose">
            <Markdown text={idea} breaks />
          </div>
        </section>
      )}

      {code && (
        <section className="template-doc-section">
          <div className="template-doc-label">
            <span>
              {custom ? '模板代码' : '我的模板'}
              <span className="template-doc-count">{codeLines} 行</span>
            </span>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={copyCode}>
              复制
            </Button>
          </div>
          <CodeEditor language="cpp" readOnly height={readonlyCodeHeight(code)} value={code} />
        </section>
      )}

      {!hasContent && (
        <div className="template-doc-empty">
          <span>{preview ? '左边写思路，右边写代码，中间会实时渲染成这个样子。' : '这个模板位还没写入内容 —— 模板由你自己写才有用。'}</span>
          {emptyAction}
        </div>
      )}
    </article>
  )
}

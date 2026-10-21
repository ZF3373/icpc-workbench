/**
 * 笔记查看的纯函数层：供笔记卡片入口生成摘要、判断是否渲染入口。
 * 抽成纯函数是为了能直接单测（node:test），组件里只做拼装不做字符串处理。
 */

/** 笔记归属种类：复习库 / 模板库 / 计划任务备注，决定默认标题与渲染方式 */
export type NoteKind = 'review' | 'template' | 'task'

/** 各类笔记在界面上的名称：标题、无障碍标签、入口文案共用同一份真源 */
export function noteKindLabel(kind: NoteKind): string {
  switch (kind) {
    case 'review': return '复习笔记'
    case 'template': return '学习笔记'
    case 'task': return '任务备注'
  }
}

/** 笔记是否「有内容」：空串 / 只有空白都算没有，这种条目不渲染入口 */
export function hasNoteText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().length > 0
}

/**
 * 生成入口摘要：取首个非空行，并剥掉行首的 Markdown 装饰，避免入口里出现
 * 字面的 `#`、`>`、`-`、`[x]`、`**`；图片与链接只保留可读语义。返回单行文本。
 */
export function noteSummary(text: string, max = 60): string {
  // max 过低会截得没法看，给个下限兜底
  const limit = Math.max(8, max)
  const raw = (text ?? '').trim()
  if (!raw) return ''

  // 首个非空行是入口的第一印象，多行备忘录只取这一行
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''

  // 装饰剥离顺序：先换掉图片与链接（它们可能包含括起来的原始 Markdown），再剥行首语法
  let line = firstLine.trim()
  // 图片 → [图片]（alt 可能包含 Markdown，保留 alt 原文会被误当正文）
  line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图片]')
  // 链接 → 只留文字
  line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 行首块级装饰：标题、引用、无序/有序列表、任务框
  line = line.replace(/^\s{0,3}(#{1,6})\s+/, '')
  line = line.replace(/^\s{0,3}>\s?/, '')
  line = line.replace(/^\s{0,3}[-*+]\s+/, '')
  line = line.replace(/^\s{0,3}\d+[.)]\s+/, '')
  line = line.replace(/^\s{0,3}\[\s*x?\s*\]\s*/i, '')
  // 行内强调：`**` / `*` / `~~` / `==` / 反引号全部剥掉，只留可见文字
  line = line.replace(/(\*\*|__|\*|_|~~|==|`)/g, '')
  // 压缩连续空白为单个空格（Markdown 里多空格往往是排版伪需求，入口摘要不需要）
  line = line.replace(/\s+/g, ' ').trim()

  if (!line) return ''
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}
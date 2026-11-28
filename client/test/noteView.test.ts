import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasNoteText, noteCardWidth, noteKindLabel, noteSummary } from '../src/noteView'

test('noteKindLabel: 五类笔记各有独立名称', () => {
  assert.equal(noteKindLabel('review'), '复习笔记')
  assert.equal(noteKindLabel('template'), '学习笔记')
  assert.equal(noteKindLabel('task'), '任务备注')
  assert.equal(noteKindLabel('problem'), '题目笔记')
  assert.equal(noteKindLabel('contest'), '比赛笔记')
})

test('hasNoteText: 空串 / 纯空白不算有内容，普通文本算', () => {
  assert.equal(hasNoteText(null), false)
  assert.equal(hasNoteText(undefined), false)
  assert.equal(hasNoteText(''), false)
  assert.equal(hasNoteText('   '), false)
  assert.equal(hasNoteText('\n\t  \n'), false)
  assert.equal(hasNoteText('有一个字'), true)
})

test('noteSummary: 取首个非空行并剥掉 Markdown 装饰', () => {
  const cases: Array<[string, string]> = [
    ['# 标题内容', '标题内容'],
    ['## 二级标题', '二级标题'],
    ['> 引用内容', '引用内容'],
    ['- 列表项', '列表项'],
    ['* 列表项二', '列表项二'],
    ['+ 列表项三', '列表项三'],
    ['1. 有序项', '有序项'],
    ['- [x] 已完成任务', '已完成任务'],
    ['- [ ] 待办任务', '待办任务'],
    ['**加粗**文本', '加粗文本'],
    ['*斜体*文本', '斜体文本'],
    ['~~删除~~文本', '删除文本'],
    ['==高亮==文本', '高亮文本'],
    ['`code`片段', 'code片段'],
    ['![alt](https://example.com/x.png)', '[图片]'],
    ['[链接文字](https://example.com)', '链接文字'],
    // 多行：只取首个非空行
    ['任务别看第一行\n第二行\n第三行', '任务别看第一行'],
    // 多余空白压缩为单个空格
    ['多个   空白   中间', '多个 空白 中间'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(noteSummary(input), expected, `input=${JSON.stringify(input)}`)
  }
})

test('noteSummary: 空输入返回空串', () => {
  assert.equal(noteSummary(''), '')
  assert.equal(noteSummary('  \n  '), '')
  assert.equal(noteSummary(undefined as unknown as string), '')
})

test('noteSummary: 超长截断为 max-1 + …', () => {
  const long = '这是一段足够长的文字'.repeat(10)
  const result = noteSummary(long, 20)
  assert.equal(result.length, 20)
  assert.ok(result.endsWith('…'))
  // 不超长不截断
  assert.equal(noteSummary('短内容', 20), '短内容')
})

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css')
const css = readFileSync(cssPath, 'utf8')

/** 取某条规则第一次出现时的声明块 */
function cssBlock(selector: string): string {
  const start = css.indexOf(selector)
  assert.ok(start > 0, `index.css 里找不到 ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

/** 正则元字符转义，用于把 CSS 选择器原文塞进断言正则 */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('noteCardWidth: 卡片态 860 定宽，全屏态用视口比例变量', () => {
  // 卡片态是固定像素：宽屏下读长笔记的字行长度已经够用，再宽反而不好读
  assert.equal(noteCardWidth(false), 860)
  // 全屏态引用 CSS 变量而不是写死数值，也不是 100vw：
  // 比例真源在 index.css 的 --note-fs-ratio，整页缩放（--app-zoom）由 --app-viewport-* 兜住
  assert.equal(noteCardWidth(true), 'var(--note-fs-width)')
  assert.notEqual(noteCardWidth(true), noteCardWidth(false))
})

/* ---------- issue #52 后续反馈：「全屏查看有点大了（因为字体还是小的）」 ----------
 * 用户要的是 80% 屏幕 + 全屏时字体放大一档。下面几条钉住的是最终落到屏幕上的
 * 那两个值，而不是某个组件里的写法 —— 尺寸与字号都只有 index.css 一处真源。 */

test('index.css: 全屏阅读约占视口 80%，而不是铺满', () => {
  const ratio = /--note-fs-ratio:\s*([\d.]+)/.exec(css)?.[1]
  assert.equal(ratio, '0.8', '全屏阅读应占视口 80%（issue #52 反馈「铺满太大」）')
  // 宽高都由这个比例推导，不能再有绕过它的 100vw/100vh
  assert.match(css, /--note-fs-width: calc\(var\(--app-viewport-width\) \* var\(--note-fs-ratio\)\)/)
  assert.match(css, /--note-fs-height: calc\(var\(--app-viewport-height\) \* var\(--note-fs-ratio\)\)/)
  const block = cssBlock('.note-card-modal.is-fullscreen {')
  assert.match(block, /width: var\(--note-fs-width\)/)
  assert.match(block, /height: var\(--note-fs-height\)/)
  assert.doesNotMatch(block, /100v[wh]/, '全屏尺寸不该绕过 --app-zoom 直接用视口单位')
  // 悬浮居中需要上边距与横向 auto margin，否则 80% 的窗口会贴在左上角
  assert.match(block, /top: calc\(\(var\(--app-viewport-height\) - var\(--note-fs-height\)\)/)
  assert.match(block, /margin: 0 auto/)
})

test('index.css: 全屏阅读的正文字号放大一档，且仍与手动缩放叠乘', () => {
  assert.match(cssBlock('.note-card-modal.is-fullscreen {'), /--note-fs-font-scale: 1\.25/)
  // 13px × 1.25 ≈ 16px（Typora 默认正文），同时保留 --note-text-zoom 的手动调节
  for (const selector of [
    '.markdown-body',
    '.markdown-body h1',
    '.markdown-body h2',
    '.markdown-body h3',
    '.markdown-body h4',
    '.markdown-body code',
    '.md-code-pre code',
  ]) {
    const re = new RegExp(`\\[data-note-zoom\\] ${escapeRe(selector)}[^{]*\\{[^}]*--note-text-zoom[^}]*--note-fs-font-scale`)
    assert.match(css, re, `${selector} 未同时乘 --note-text-zoom 与 --note-fs-font-scale`)
  }
  // 任务备注是纯文本，不在 .markdown-body 里，同样要跟着放大
  assert.match(cssBlock('.note-card-plain {'), /--note-text-zoom[^}]*--note-fs-font-scale/)
})

test('index.css: 字号放大只作用于全屏阅读，卡片态与写作弹窗不受影响', () => {
  // 系数只在 .note-card-modal.is-fullscreen 上声明一次；写作弹窗与卡片态取默认 1
  assert.equal((css.match(/--note-fs-font-scale:/g) ?? []).length, 1)
  // 写作弹窗是三栏工作台，仍然铺满（收进 80% 会把三栏挤窄）——这里确认改动没有外溢
  const writer = cssBlock('.note-writer-modal.is-fullscreen {')
  assert.doesNotMatch(writer, /--note-fs-font-scale/)
  assert.match(writer, /width: var\(--app-viewport-width\)/)
})

test('index.css: 窄屏把占屏比例放回 1（小窗再打八折就没意义了）', () => {
  const narrowBlocks = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/g) ?? []
  assert.ok(
    narrowBlocks.some((block) => /--note-fs-ratio:\s*1\s*;/.test(block)),
    '窄屏档位没有把 --note-fs-ratio 放回 1',
  )
})

test('noteSummary: max 下限保护，不会截到 <1', () => {
  const result = noteSummary('一二三四五六七八九十', 1)
  assert.equal(result.length, 8)
  assert.ok(result.endsWith('…'))
})
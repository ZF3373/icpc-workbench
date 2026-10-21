import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasNoteText, noteKindLabel, noteSummary } from '../src/noteView'

test('noteKindLabel: 三类笔记各有独立名称', () => {
  assert.equal(noteKindLabel('review'), '复习笔记')
  assert.equal(noteKindLabel('template'), '学习笔记')
  assert.equal(noteKindLabel('task'), '任务备注')
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

test('noteSummary: max 下限保护，不会截到 <1', () => {
  const result = noteSummary('一二三四五六七八九十', 1)
  assert.equal(result.length, 8)
  assert.ok(result.endsWith('…'))
})
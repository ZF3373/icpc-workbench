import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_NOTE_WRITER_VIEW,
  NOTE_WRITER_COLUMNS,
  NOTE_WRITER_MODES,
  NOTE_WRITER_ZOOM_PANES,
  isNoteWriterMode,
  noteCharCount,
  noteLineCount,
  normalizeNoteWriterViewState,
  noteWriterWidth,
} from '../src/noteWriterView'

test('normalizeNoteWriterViewState: 接受合法快照', () => {
  assert.deepEqual(
    normalizeNoteWriterViewState({ fullscreen: true, mode: 'preview' }),
    { fullscreen: true, mode: 'preview' },
  )
  assert.deepEqual(
    normalizeNoteWriterViewState({ fullscreen: false, mode: 'edit' }),
    { fullscreen: false, mode: 'edit' },
  )
})

test('normalizeNoteWriterViewState: 非对象 / 数组 / 空对象一律视为无快照', () => {
  for (const raw of [null, undefined, 0, 'split', [], true, {}]) {
    assert.equal(normalizeNoteWriterViewState(raw), null)
  }
})

test('normalizeNoteWriterViewState: 非法字段丢弃并回落默认值', () => {
  // fullscreen 只认真正的布尔：字符串 "false" 是最容易手改错的写法
  assert.deepEqual(
    normalizeNoteWriterViewState({ fullscreen: 'false', mode: 'split' }),
    { fullscreen: DEFAULT_NOTE_WRITER_VIEW.fullscreen, mode: 'split' },
  )
  // 未知模式回落 split（编辑器默认档）
  assert.deepEqual(
    normalizeNoteWriterViewState({ fullscreen: true, mode: 'zen' }),
    { fullscreen: true, mode: 'split' },
  )
  // 只坏一个字段时保留另一个
  assert.deepEqual(
    normalizeNoteWriterViewState({ fullscreen: true, mode: 42 }),
    { fullscreen: true, mode: 'split' },
  )
})

test('normalizeNoteWriterViewState: 只认三个编辑模式', () => {
  for (const mode of NOTE_WRITER_MODES) {
    assert.equal(isNoteWriterMode(mode), true)
  }
  for (const mode of ['zen', 'EDIT', '', null, undefined, 1]) {
    assert.equal(isNoteWriterMode(mode), false)
  }
})

test('noteWriterWidth: 卡片态 760 定宽，全屏态跟随视口变量（不随整页缩放溢出）', () => {
  assert.equal(noteWriterWidth(false), 760)
  assert.equal(noteWriterWidth(true), 'var(--app-viewport-width)')
  assert.notEqual(noteWriterWidth(true), noteWriterWidth(false))
})
test('noteCharCount: 不计空白，中文按字计', () => {
  assert.equal(noteCharCount(''), 0)
  assert.equal(noteCharCount(null), 0)
  assert.equal(noteCharCount(undefined), 0)
  assert.equal(noteCharCount('   \n\t '), 0)
  assert.equal(noteCharCount('二分答案'), 4)
  assert.equal(noteCharCount('二分 答案\n再写一行'), 8)
})

test('noteLineCount: 空文本算 0 行，其余按换行计', () => {
  assert.equal(noteLineCount(''), 0)
  assert.equal(noteLineCount(null), 0)
  assert.equal(noteLineCount('一行'), 1)
  assert.equal(noteLineCount('一行\n两行'), 2)
  assert.equal(noteLineCount('一行\r\n两行'), 2)
})

test('NOTE_WRITER_COLUMNS: 写作区在最右（顺序即视觉顺序），且给到最宽的一列', () => {
  // 反馈：右手边写更顺手 —— 顺序必须是「预览 / 上下文 / 写作」
  assert.equal(NOTE_WRITER_COLUMNS.length, 3)
  const writer = NOTE_WRITER_COLUMNS[2]
  const ratio = (value: string) => Number(/\*?\s*([\d.]+)fr/.exec(value)?.[1] ?? 0)
  assert.ok(ratio(writer) > ratio(NOTE_WRITER_COLUMNS[0]), '写作区应比预览列宽')
  assert.ok(ratio(writer) > ratio(NOTE_WRITER_COLUMNS[1]), '写作区应比上下文列宽')
})

test('index.css 的 .note-writer-grid 列顺序与 NOTE_WRITER_COLUMNS 一致（两处不漂移）', () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css')
  const css = readFileSync(cssPath, 'utf8')
  // 只取基础规则（第一条），媒体查询里的收窄档位单独存在、不参与顺序比对
  const start = css.indexOf('.note-writer-grid {')
  assert.ok(start > 0, 'index.css 里找不到 .note-writer-grid')
  const block = css.slice(start, css.indexOf('}', start))
  const declared = /grid-template-columns:\s*([^;]+);/.exec(block)?.[1]?.trim()
  assert.equal(declared, NOTE_WRITER_COLUMNS.join(' '))
})

/* ---------- issue #62：全屏三栏的「笔记文字」缩放覆盖到 02 / 03 两栏 ----------
 * 用户报的是「复习笔记区的 2、3 模块希望字体放大，或者增加调节功能」，并补充
 * 「目前的放大是只要 1 版块的笔记查看的能放大」。
 * 也就是说缩放入口本来就有（顶栏 ZoomControl），缺的是作用范围。
 * 这几条钉住的是「三栏都在作用域内」，不是某一处的写法。 */

test('NOTE_WRITER_ZOOM_PANES: 全屏三栏全部参与「笔记文字」缩放', () => {
  assert.deepEqual([...NOTE_WRITER_ZOOM_PANES], ['01', '02', '03'])
})

test('NoteWriterModal: 01/02/03 三栏正文都挂了 data-note-zoom 锚点', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/NoteWriterModal.tsx'), 'utf8')
  // 01 实时预览、02 上下文、03 编辑器各一处；缺任何一处都会退回「只有部分能放大」。
  // 只数真正的 JSX 属性（`data-note-zoom>` 这种布尔简写），注释里提到这个词不算。
  const anchors = src.match(/data-note-zoom>/g) ?? []
  assert.equal(anchors.length, 3, `三栏各需要一个 data-note-zoom，实际 ${anchors.length} 处`)
  for (const className of ['note-writer-preview-scroll', 'note-writer-side-scroll', 'note-writer-pane-editor']) {
    const re = new RegExp(`className="${className}"[^>]*data-note-zoom`)
    assert.match(src, re, `${className} 未挂 data-note-zoom，该栏不会跟着缩放`)
  }
})

test('index.css: 02 / 03 两栏的字号真的乘了 --note-text-zoom', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css'), 'utf8')
  // 02 栏：各块的覆盖规则都要带缩放系数
  for (const selector of [
    'note-writer-side-meta',
    'note-writer-side-label',
    'note-writer-side-tips',
    'note-writer-context-lead',
    'note-writer-context-foot',
  ]) {
    const re = new RegExp(`\\[data-note-zoom\\] \\.${selector} \\{[^}]*--note-text-zoom`)
    assert.match(css, re, `.${selector} 没有按 --note-text-zoom 缩放`)
  }
  // 03 栏：CodeMirror 正文与行号栏
  assert.match(css, /\[data-note-zoom\] \.cm-editor \{[^}]*--note-text-zoom/)
  // 栏头（01/02/03 编号、标题、字数）不参与缩放 —— 缩放的是正文，不是整张 UI
  assert.doesNotMatch(css, /\.note-writer-pane-title \{[^}]*--note-text-zoom/)
  assert.doesNotMatch(css, /\.note-writer-pane-meta \{[^}]*--note-text-zoom/)
})

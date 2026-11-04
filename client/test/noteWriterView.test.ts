import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NOTE_WRITER_VIEW,
  NOTE_WRITER_MODES,
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

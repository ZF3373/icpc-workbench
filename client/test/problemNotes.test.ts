import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeFence, draftPayload, isBlankNote, isNoteDirty, moveBlock, newBlock, newDraft, toDraft, type ProblemNote } from '../src/problemNotes.ts'

const note = (blocks: ProblemNote['blocks'], labels: string[] = []): ProblemNote => ({
  id: 1, problemId: 1, taskId: null, labels, content: '', blocks, createdAt: '', updatedAt: '', taskTitle: null, taskDate: null, planTitle: null,
})

test('默认一个 Markdown 框可删除；全空或没有框都算空笔记', () => {
  const d = newDraft()
  assert.deepEqual(d.blocks.map((b) => b.type), ['markdown'])
  assert.equal(isBlankNote(d), true)
  assert.equal(isBlankNote({ ...d, blocks: [] }), true)
  assert.equal(isBlankNote({ ...d, blocks: [{ ...newBlock('code'), code: 'x' } as never] }), false)
})

test('发送时去掉空框和前端字段，保留顺序', () => {
  const code = { ...newBlock('code'), code: 'x' }
  const payload = draftPayload({ blocks: [newBlock('markdown'), code as never, newBlock('image')], labels: ['思路'] })
  assert.deepEqual(payload, { blocks: [{ type: 'code', language: 'cpp', code: 'x' }], labels: ['思路'] })
})

test('移动框：边界不越界', () => {
  const [a, b] = [newBlock('markdown'), newBlock('code')]
  assert.deepEqual(moveBlock([a, b], b.key, -1).map((x) => x.key), [b.key, a.key])
  assert.deepEqual(moveBlock([a, b], a.key, -1).map((x) => x.key), [a.key, b.key])
  assert.deepEqual(moveBlock([a, b], b.key, 1).map((x) => x.key), [a.key, b.key])
})

test('改顺序、改内容、改标注都算修改；未改不算', () => {
  const n = note([{ type: 'markdown', text: 'a' }, { type: 'code', language: 'cpp', code: 'b' }], ['思路'])
  const d = toDraft(n)
  assert.equal(isNoteDirty(d, n), false)
  assert.equal(isNoteDirty({ ...d, labels: [] }, n), true)
  assert.equal(isNoteDirty({ ...d, blocks: [...d.blocks].reverse() }, n), true)
})

test('代码围栏比内容里的反引号更长', () => {
  assert.equal(codeFence('cpp', 'x'), '```cpp\nx\n```')
  assert.equal(codeFence('', 'a ``` b'), '````\na ``` b\n````')
})

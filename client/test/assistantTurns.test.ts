/**
 * issue 36 回归：AI 助手会话历史的送出前清洗与生成状态文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeOutgoingTurns,
  describeToolStatus,
  EMPTY_REPLY_NOTICE,
} from '../src/pages/assistantTurns.ts'

test('sanitizeOutgoingTurns: 丢掉空 content 的 assistant 轮次（issue 36 的根因）', () => {
  const turns = [
    { role: 'user' as const, content: '问题' },
    { role: 'assistant' as const, content: '' }, // 模型零输出留下的空轮次
    { role: 'user' as const, content: '追问' },
  ]
  assert.deepEqual(sanitizeOutgoingTurns(turns), [
    { role: 'user', content: '问题' },
    { role: 'user', content: '追问' },
  ])
})

test('sanitizeOutgoingTurns: 空白字符（空格/换行）同样视为空', () => {
  const turns = [
    { role: 'user' as const, content: '问题' },
    { role: 'assistant' as const, content: '  \n\n ' },
  ]
  assert.equal(sanitizeOutgoingTurns(turns).length, 1)
})

test('sanitizeOutgoingTurns: 纯附件提问（content 为空但有附件）必须保留', () => {
  const turns = [
    { role: 'user' as const, content: '', attachments: [{ fileId: 'file-api-1' }] },
    { role: 'assistant' as const, content: '看这张图' },
  ]
  const kept = sanitizeOutgoingTurns(turns)
  assert.equal(kept.length, 2)
  assert.equal(kept[0]!.role, 'user')
})

test('sanitizeOutgoingTurns: 空 content 且无附件的 user 轮次也丢弃', () => {
  const turns = [
    { role: 'user' as const, content: '' },
    { role: 'user' as const, content: '真实问题' },
  ]
  assert.deepEqual(sanitizeOutgoingTurns(turns), [{ role: 'user', content: '真实问题' }])
})

test('sanitizeOutgoingTurns: 正常历史原样保留且不改动对象', () => {
  const turns = [
    { role: 'user' as const, content: 'a' },
    { role: 'assistant' as const, content: 'b' },
  ]
  const out = sanitizeOutgoingTurns(turns)
  assert.equal(out.length, 2)
  assert.equal(out[0], turns[0]) // 不复制、不改写消息对象（流式期间引用缓存依赖同一引用）
})

test('sanitizeOutgoingTurns: 容忍旧版本地存储里缺失 content 的消息', () => {
  const turns = [
    { role: 'assistant' as const, content: undefined as unknown as string },
    { role: 'user' as const, content: 'hi' },
  ]
  assert.deepEqual(sanitizeOutgoingTurns(turns), [{ role: 'user', content: 'hi' }])
})

test('describeToolStatus: 已知工具出中文文案，未知工具回退', () => {
  assert.equal(describeToolStatus('web_search', 'ICPC 赛制'), '正在联网检索：ICPC 赛制')
  assert.equal(describeToolStatus('fetch_url', 'https://qoj.ac/problem/1'), '正在读取网页：https://qoj.ac/problem/1')
  assert.equal(describeToolStatus('fetch_editorial'), '正在查找题解…')
  assert.equal(describeToolStatus('mystery_tool'), '正在执行 mystery_tool…')
  assert.equal(describeToolStatus(''), '正在处理…')
})

test('describeToolStatus: 超长详情被截断（长 URL 不撑破输入栏）', () => {
  const long = `https://example.com/${'x'.repeat(200)}`
  const out = describeToolStatus('fetch_url', long)
  assert.ok(out.length < 100, `文案不能过长：${out.length}`)
  assert.match(out, /…$/)
})

test('EMPTY_REPLY_NOTICE: 提示非空且说明不影响后续对话', () => {
  assert.ok(EMPTY_REPLY_NOTICE.includes('未收到回复内容'))
  assert.ok(EMPTY_REPLY_NOTICE.includes('不会影响后续对话'))
})

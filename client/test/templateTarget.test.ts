/**
 * 用户反馈：无法指定 AI 助手把模板放到哪个算法课程标签下。
 * 这里固定住「目标标签」的解析规则：用户显式选择 > AI 给的 key > 兜底第一个分类。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_TEMPLATE_CATEGORY,
  isKnownTemplateCategory,
  resolveTemplateTarget,
  templateCategoryLabel,
  type TemplateCategoryOption,
} from '../src/templateTarget.ts'

const CATS: TemplateCategoryOption[] = [
  { key: 'basic', name: '基础算法', custom: false },
  { key: 'graph', name: '图论', custom: false },
  { key: 'custom-abc', name: '图论进阶', custom: true, templateCount: 0 },
]

test('resolveTemplateTarget: 用户显式选择优先于 AI 给的 key', () => {
  assert.equal(
    resolveTemplateTarget({ aiKey: 'graph', chosen: 'custom-abc', categories: CATS }),
    'custom-abc',
  )
})

test('resolveTemplateTarget: 用户没选时尊重 AI 给的有效 key（含自建标签）', () => {
  assert.equal(resolveTemplateTarget({ aiKey: 'custom-abc', categories: CATS }), 'custom-abc')
  assert.equal(resolveTemplateTarget({ aiKey: 'graph', categories: CATS }), 'graph')
})

test('resolveTemplateTarget: AI 给了无效 key（空/拼错/已删除）→ 兜底第一个分类', () => {
  assert.equal(resolveTemplateTarget({ aiKey: '', categories: CATS }), 'basic')
  assert.equal(resolveTemplateTarget({ aiKey: '不存在的分类', categories: CATS }), 'basic')
  assert.equal(resolveTemplateTarget({ aiKey: 'custom-deleted', categories: CATS }), 'basic')
})

test('resolveTemplateTarget: 用户选的 key 已失效（如标签刚被删除）→ 不静默写入，回退 AI key', () => {
  // 关键：不能把失效的 chosen 原样送出（服务端会 400 且用户看到莫名其妙的失败）
  assert.equal(
    resolveTemplateTarget({ aiKey: 'graph', chosen: 'custom-gone', categories: CATS }),
    'graph',
  )
})

test('resolveTemplateTarget: 分类清单为空时退回 basic（服务端会给明确报错）', () => {
  assert.equal(resolveTemplateTarget({ aiKey: 'graph', categories: [] }), FALLBACK_TEMPLATE_CATEGORY)
})

test('isKnownTemplateCategory: 空值/未登记 key 都不算命中', () => {
  assert.equal(isKnownTemplateCategory(CATS, 'basic'), true)
  assert.equal(isKnownTemplateCategory(CATS, 'custom-abc'), true)
  assert.equal(isKnownTemplateCategory(CATS, 'graph2'), false)
  assert.equal(isKnownTemplateCategory(CATS, undefined), false)
  assert.equal(isKnownTemplateCategory(CATS, ''), false)
})

test('templateCategoryLabel: 自建标签带「（自建）」标记，内置不加', () => {
  assert.equal(templateCategoryLabel(CATS[0]!), '基础算法')
  assert.equal(templateCategoryLabel(CATS[2]!), '图论进阶（自建）')
})

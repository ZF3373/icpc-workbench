import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CP_ALGORITHMS,
  READING_REFS,
  buildArticleAskText,
  readingRefCount,
  readingRefsOf,
} from '../../shared/src/readingRefs.ts'

/**
 * cp-algorithms 延伸阅读索引（shared/src/readingRefs.ts）。
 *
 * 这里守的是「索引本身的正确性」，不是文章内容：
 * 1. 每条 URL 必须真的属于 cp-algorithms（外链错了就是死链，用户点了打不开）；
 * 2. 分类 key 必须落在内置课程的 11 个分类内（拼错会让模板库静默少一块）；
 * 3. 同一分类内标题不重复（重复会让用户以为是两篇不同的文章）；
 * 4. 预填文案必须带上原文链接，否则 AI 拿不到要讲哪一篇。
 */

/** 内置课程分类（server/src/templates/curriculum.ts 的 CURRICULUM key 顺序） */
const CURRICULUM_KEYS = [
  'intro',
  'basic',
  'search',
  'ds',
  'dp',
  'graph',
  'tree',
  'math',
  'string',
  'geo',
  'misc',
]

test('readingRefs：每个分类 key 都属于内置课程分类', () => {
  for (const key of Object.keys(READING_REFS)) {
    assert.ok(CURRICULUM_KEYS.includes(key), `未知分类 key：${key}`)
  }
})

test('readingRefs：11 个内置分类每个都有延伸阅读（不留空分类）', () => {
  for (const key of CURRICULUM_KEYS) {
    const list = readingRefsOf(key)
    assert.ok(list.length > 0, `分类 ${key} 没有延伸阅读`)
  }
})

test('readingRefs：全部 URL 属于 cp-algorithms 且是 .html 文章页', () => {
  const seen = new Set<string>()
  for (const [key, list] of Object.entries(READING_REFS)) {
    for (const article of list) {
      assert.ok(
        article.url.startsWith('https://cp-algorithms.com/'),
        `${key} 的「${article.title}」URL 不在 cp-algorithms 域内：${article.url}`,
      )
      assert.ok(article.url.endsWith('.html'), `${key} 的「${article.title}」不是文章页：${article.url}`)
      seen.add(article.url)
    }
  }
  // 去重后的真实篇数必须与站点快照口径一致（站点 2026-11 为 163 篇）
  assert.equal(readingRefCount(), seen.size, 'readingRefCount 必须等于去重后的 URL 数')
  assert.equal(seen.size, CP_ALGORITHMS.articleCount, '索引篇数与站点元信息声明的篇数不一致')
})

test('readingRefs：同一分类内标题不重复', () => {
  for (const [key, list] of Object.entries(READING_REFS)) {
    const titles = list.map((a) => a.title)
    assert.equal(new Set(titles).size, titles.length, `分类 ${key} 有重复标题`)
  }
})

test('readingRefsOf：未知分类（含用户自建标签）返回空数组而不是抛错', () => {
  assert.deepEqual(readingRefsOf('c-42'), [])
  assert.deepEqual(readingRefsOf(''), [])
})

test('buildArticleAskText：带上链接与英文原名，并明确要求先读原文再讲', () => {
  const text = buildArticleAskText({
    title: '线段树',
    titleEn: 'Segment Tree',
    url: 'https://cp-algorithms.com/data_structures/segment_tree.html',
  })
  assert.match(text, /请用中文给我讲解这篇文章：线段树（Segment Tree）/)
  assert.match(text, /https:\/\/cp-algorithms\.com\/data_structures\/segment_tree\.html/)
  assert.match(text, /先读原文再讲/, '必须要求 AI 读原文，防止凭标题猜内容')
  assert.match(text, /保留原文链接/)
})

test('buildArticleAskText：中文标题与英文原名相同时不重复括号', () => {
  const text = buildArticleAskText({
    title: 'Binary Search',
    titleEn: 'Binary Search',
    url: 'https://cp-algorithms.com/num_methods/binary_search.html',
  })
  assert.doesNotMatch(text, /（Binary Search）/)
})

test('buildArticleAskText：预填文案经 URL 深链往返后不丢失换行与链接', () => {
  // 模板库用 `/ai?ask=${encodeURIComponent(text)}` 跳转，Assistant 用 searchParams.get 取回。
  // 中文、换行、冒号、斜杠都必须原样回来——否则 AI 收到的是一段被截断的提问。
  const article = {
    title: '树链剖分',
    titleEn: 'Heavy-light decomposition',
    url: 'https://cp-algorithms.com/graph/hld.html',
  }
  const text = buildArticleAskText(article)
  const href = `/ai?ask=${encodeURIComponent(text)}`
  const parsed = new URLSearchParams(href.slice(href.indexOf('?') + 1))
  assert.equal(parsed.get('ask'), text)
  assert.equal(parsed.get('ask')!.split('\n').length, text.split('\n').length, '换行数必须一致')
  assert.ok(parsed.get('ask')!.includes(article.url), '链接不能在往返中丢失')
})

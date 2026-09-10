/**
 * problemFilter.ts 纯函数单元测试（node:test 运行）。
 * 覆盖「过滤问题」面板的核心逻辑：标签逻辑或组合、同义别名归并、难度区间、状态过滤。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTagAliasSet, matchesProblemFilters } from '../src/problemFilter.ts'
import { canonicalTag, filterNoiseTags } from '../../shared/src/index.ts'

const row = (over: Partial<{ tags: string[]; difficulty: number | null; status: 'ac' | 'tried' | 'none' }>) => ({
  tags: [] as string[],
  difficulty: null as number | null,
  status: 'none' as const,
  ...over,
})

describe('problemFilter.ts', () => {
  describe('buildTagAliasSet', () => {
    it('expands a Chinese tag to its English aliases', () => {
      const s = buildTagAliasSet(['二分'])
      assert.ok(s.has('二分'))
      assert.ok(s.has('binary search'))
    })
    it('expands an English tag to its canonical Chinese name', () => {
      const s = buildTagAliasSet(['dp'])
      assert.ok(s.has('dp'))
      assert.ok(s.has('动态规划'))
    })
    it('unions aliases across multiple selected tags (OR)', () => {
      const s = buildTagAliasSet(['二分', '贪心'])
      assert.ok(s.has('binary search'))
      assert.ok(s.has('greedy'))
      assert.ok(s.has('贪心'))
    })
    it('returns an empty set for an empty selection', () => {
      assert.equal(buildTagAliasSet([]).size, 0)
    })
  })

  describe('matchesProblemFilters — tags (逻辑或)', () => {
    const noTags = { tagAliases: new Set<string>(), status: 'all' as const }

    it('keeps rows matching ANY selected tag (OR, not AND)', () => {
      const aliases = buildTagAliasSet(['dp', '贪心'])
      assert.equal(matchesProblemFilters(row({ tags: ['dp'] }), { tagAliases: aliases, status: 'all' }), true)
      assert.equal(matchesProblemFilters(row({ tags: ['greedy'] }), { tagAliases: aliases, status: 'all' }), true)
      // 只有其中一个标签的题保留，两个都不占的题被过滤
      assert.equal(matchesProblemFilters(row({ tags: ['graphs'] }), { tagAliases: aliases, status: 'all' }), false)
    })

    it('matches via alias: selecting 二分 keeps binary-search-tagged problems', () => {
      const aliases = buildTagAliasSet(['二分'])
      assert.equal(matchesProblemFilters(row({ tags: ['binary search'] }), { tagAliases: aliases, status: 'all' }), true)
      assert.equal(matchesProblemFilters(row({ tags: ['binary search', 'math'] }), { tagAliases: aliases, status: 'all' }), true)
      assert.equal(matchesProblemFilters(row({ tags: ['math'] }), { tagAliases: aliases, status: 'all' }), false)
    })

    it('no tag constraint when selection is empty', () => {
      assert.equal(matchesProblemFilters(row({ tags: [] }), { ...noTags }), true)
    })
  })

  describe('matchesProblemFilters — difficulty range', () => {
    const base = { tagAliases: new Set<string>(), status: 'all' as const }

    it('closed interval [min, max] inclusive', () => {
      assert.equal(matchesProblemFilters(row({ difficulty: 1200 }), { ...base, diffMin: 1200, diffMax: 1899 }), true)
      assert.equal(matchesProblemFilters(row({ difficulty: 1899 }), { ...base, diffMin: 1200, diffMax: 1899 }), true)
      assert.equal(matchesProblemFilters(row({ difficulty: 1199 }), { ...base, diffMin: 1200, diffMax: 1899 }), false)
      assert.equal(matchesProblemFilters(row({ difficulty: 1900 }), { ...base, diffMin: 1200, diffMax: 1899 }), false)
    })

    it('min-only and max-only bounds', () => {
      assert.equal(matchesProblemFilters(row({ difficulty: 3500 }), { ...base, diffMin: 1200 }), true)
      assert.equal(matchesProblemFilters(row({ difficulty: 800 }), { ...base, diffMin: 1200 }), false)
      assert.equal(matchesProblemFilters(row({ difficulty: 800 }), { ...base, diffMax: 1899 }), true)
      assert.equal(matchesProblemFilters(row({ difficulty: 2400 }), { ...base, diffMax: 1899 }), false)
    })

    it('drops unknown-difficulty problems while a range is set, keeps them without', () => {
      const unknown = row({ difficulty: null })
      assert.equal(matchesProblemFilters(unknown, { ...base, diffMin: 1200 }), false)
      assert.equal(matchesProblemFilters(unknown, { ...base, diffMax: 1899 }), false)
      assert.equal(matchesProblemFilters(unknown, base), true)
    })
  })

  describe('matchesProblemFilters — status', () => {
    const base = { tagAliases: new Set<string>() }

    it('filters by status and passes everything with all', () => {
      assert.equal(matchesProblemFilters(row({ status: 'ac' }), { ...base, status: 'ac' }), true)
      assert.equal(matchesProblemFilters(row({ status: 'tried' }), { ...base, status: 'ac' }), false)
      assert.equal(matchesProblemFilters(row({ status: 'none' }), { ...base, status: 'all' }), true)
    })
  })

  describe('matchesProblemFilters — combined', () => {
    it('ANDs tag / difficulty / status constraints', () => {
      const aliases = buildTagAliasSet(['dp'])
      const spec = { tagAliases: aliases, diffMin: 1200, diffMax: 1899, status: 'none' as const }
      assert.equal(
        matchesProblemFilters(row({ tags: ['动态规划'], difficulty: 1500, status: 'none' }), spec),
        true,
      )
      // 标签命中但难度不符
      assert.equal(
        matchesProblemFilters(row({ tags: ['dp'], difficulty: 2200, status: 'none' }), spec),
        false,
      )
      // 难度、状态都符合但标签不符
      assert.equal(
        matchesProblemFilters(row({ tags: ['greedy'], difficulty: 1500, status: 'none' }), spec),
        false,
      )
    })
  })

  describe('侧边栏标签统计：canonicalTag + filterNoiseTags', () => {
    it('merges English tags to Chinese canonical names (dp → 动态规划)', () => {
      // 模拟 Problems.tsx 的 tagCountEntries 统计逻辑
      const rows = [
        { tags: ['dp', 'greedy'] },
        { tags: ['动态规划'] },
        { tags: ['math'] },
      ]
      const m = new Map<string, number>()
      for (const r of rows)
        for (const t of filterNoiseTags(r.tags).map((tag) => canonicalTag(tag)))
          m.set(t, (m.get(t) ?? 0) + 1)
      // dp 和 动态规划 合并为「动态规划」（count=2）
      assert.equal(m.get('动态规划'), 2)
      assert.equal(m.get('dp'), undefined)
      // greedy → 贪心, math → 数学
      assert.equal(m.get('贪心'), 1)
      assert.equal(m.get('数学'), 1)
    })

    it('excludes noise tags from sidebar counts', () => {
      const rows = [
        { tags: ['dp', '2026', '蓝桥杯省赛'] },
        { tags: ['*special', 'greedy', 'O2优化'] },
      ]
      const m = new Map<string, number>()
      for (const r of rows)
        for (const t of filterNoiseTags(r.tags).map((tag) => canonicalTag(tag)))
          m.set(t, (m.get(t) ?? 0) + 1)
      // 噪声标签被过滤
      assert.equal(m.get('2026'), undefined)
      assert.equal(m.get('蓝桥杯省赛'), undefined)
      assert.equal(m.get('*special'), undefined)
      assert.equal(m.get('O2优化'), undefined)
      // 算法标签保留并归并
      assert.equal(m.get('动态规划'), 1)
      assert.equal(m.get('贪心'), 1)
    })
  })
})

/**
 * 难度展示纯函数 formatDifficulty 的单元测试（node:test）。
 *
 * 口径：数值一律是 CF rating 统一标尺（服务端 difficulty），括号里补平台原生档位
 * （服务端 difficultyLabel，如洛谷「提高」/ 力扣「中等」），标度名由 difficultyScale 给出。
 * 原生标签为 null（题库只给了数值，或平台压根没有难度）时只显示数值，绝不臆造档位名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDifficulty } from '../src/ui.ts'

test('formatDifficulty：CF 数值 + 平台原生标签', () => {
  assert.equal(formatDifficulty(1800, '提高', 'luogu-2026-06'), '1800 · 洛谷 提高')
  assert.equal(formatDifficulty(1500, null, 'nowcoder-score'), '1500')
  assert.equal(formatDifficulty(null, null, 'none'), '难度未知')
  assert.equal(formatDifficulty(null, null, 'none', '平台不提供难度'), '平台不提供难度')
})

test('formatDifficulty：各平台标度名与原生档位对应', () => {
  assert.equal(formatDifficulty(2200, '提高', 'jisuanke-level-8'), '2200 · 计蒜客 提高')
  assert.equal(formatDifficulty(1500, '中等', 'leetcode-tier'), '1500 · 力扣 中等')
  assert.equal(formatDifficulty(1800, '5/10', 'hydro-1-10'), '1800 · 代码源 5/10')
  assert.equal(formatDifficulty(2000, '1234', 'atcoder-kenkoooo-irt'), '2000 · AtCoder 1234')
  // QOJ 的难度由 ICPC/CCPC 公开榜单档位推导（icpc-tier）：展示为「1500 · ICPC 榜单 铜」
  assert.equal(formatDifficulty(1500, '铜', 'icpc-tier'), '1500 · ICPC 榜单 铜')
})

test('formatDifficulty：无原生标签 / 无标度名时只给数值', () => {
  // CF 的原生标签就是数值本身（'2200'）：再拼一次会变成「2200 · Codeforces 2200」，故 cf-rating 不出标度名
  assert.equal(formatDifficulty(2200, '2200', 'cf-rating'), '2200')
  assert.equal(formatDifficulty(1500, null, 'none'), '1500')
  assert.equal(formatDifficulty(1500, '提高', null), '1500')
  assert.equal(formatDifficulty(1500, '提高', undefined), '1500')
})

test('formatDifficulty：undefined 与 null 难度均走空态', () => {
  assert.equal(formatDifficulty(undefined, '提高', 'luogu-2026-06'), '难度未知')
  // 难度为空时即使有原生档位也不显示（服务端 difficulty=null 表示映射不出标尺，档位名无意义）
  assert.equal(formatDifficulty(null, '提高', 'luogu-2026-06'), '难度未知')
  assert.equal(formatDifficulty(null, '提高', 'luogu-2026-06', '-'), '-')
})

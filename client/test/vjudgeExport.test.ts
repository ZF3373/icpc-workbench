import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PLATFORMS, VJUDGE_OJ_OF_PLATFORM, type PlatformId } from '../../shared/src/index.ts'

/**
 * 题单导出为 Virtual Judge Markdown 用的 OJ 字面量。
 *
 * 这张表此前是客户端里的一段 if/else（CF- / Luogu- / nowcoder- / QOJ-），与 VJudge 线上
 * 实际写法（CodeForces / 洛谷 / 牛客 / QOJ）**全都不一样** —— 导出的题单粘进 VJudge 认不出来。
 * 现在收敛到 shared 的单一真源，这里锁住「只登记 VJudge 上真实存在的 OJ」这条口径。
 */
describe('VJudge OJ 字面量映射', () => {
  it('已接入且 VJudge 收录的平台都有映射', () => {
    for (const id of ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'jisuanke', 'daimayuan', 'qoj'] as PlatformId[]) {
      assert.ok(VJUDGE_OJ_OF_PLATFORM[id], `${id} 必须有 VJudge 字面量`)
    }
  })

  it('映射值是 VJudge 线上写法（大小写与中文都对得上）', () => {
    assert.equal(VJUDGE_OJ_OF_PLATFORM.codeforces, 'CodeForces')
    assert.equal(VJUDGE_OJ_OF_PLATFORM.atcoder, 'AtCoder')
    assert.equal(VJUDGE_OJ_OF_PLATFORM.luogu, '洛谷')
    assert.equal(VJUDGE_OJ_OF_PLATFORM.nowcoder, '牛客')
    assert.equal(VJUDGE_OJ_OF_PLATFORM.qoj, 'QOJ')
  })

  it('VJudge 上不存在的平台不登记（导出回退成普通链接，而不是拼一个假 OJ）', () => {
    // DashOJ / LeetCode 不在 VJudge 的 OJ 列表里；vjudge 自己更不需要「转发到自己」
    assert.equal(VJUDGE_OJ_OF_PLATFORM.dashoj, undefined)
    assert.equal(VJUDGE_OJ_OF_PLATFORM.leetcode, undefined)
    assert.equal(VJUDGE_OJ_OF_PLATFORM.vjudge, undefined)
  })

  it('映射的键必须是已知平台（防止拼错平台 id 后静默失效）', () => {
    const known = new Set(PLATFORMS.map((p) => p.id))
    for (const id of Object.keys(VJUDGE_OJ_OF_PLATFORM)) {
      assert.ok(known.has(id as PlatformId), `未知平台: ${id}`)
    }
  })
})

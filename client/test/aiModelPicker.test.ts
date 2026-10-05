/**
 * aiModelPicker.ts 纯函数单测：「获取可用模型」勾选采纳。
 * 回归点：目录条目上限必须**在采纳时**生效（否则界面显示几百条、服务端静默截到 50，
 * 且结构对账不会回写草稿 → 界面与库永久不一致、用户看不到提示）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergePickedModels } from '../src/aiModelPicker.ts'

describe('mergePickedModels', () => {
  it('追加勾选的新模型并保留已有条目（参数不被网关值覆盖）', () => {
    const existing = [{ id: 'a', maxTokens: 8192, contextWindow: 131072 }]
    const candidates = [
      { id: 'a', caps: { maxTokens: 999 } },
      { id: 'b', caps: { maxTokens: 16384, contextWindow: 200000 } },
      { id: 'c' },
    ]
    const r = mergePickedModels(existing, candidates, new Set(['a', 'b', 'c']))
    assert.deepEqual(r.models, [
      { id: 'a', maxTokens: 8192, contextWindow: 131072 },
      { id: 'b', maxTokens: 16384, contextWindow: 200000 },
      { id: 'c' },
    ])
    assert.equal(r.skipped, 0)
  })

  it('未勾选的候选不加入；目录里已有的不计入 skipped', () => {
    const r = mergePickedModels([{ id: 'a' }], [
      { id: 'a' },
      { id: 'b' },
    ], new Set(['b']))
    assert.deepEqual(r.models, [{ id: 'a' }, { id: 'b' }])
    assert.equal(r.skipped, 0)
  })

  it('超出上限的候选计入 skipped，绝不让草稿超过上限（与界面 50 条口径一致）', () => {
    const existing = Array.from({ length: 49 }, (_, i) => ({ id: `m${i}` }))
    const candidates = Array.from({ length: 5 }, (_, i) => ({ id: `new${i}` }))
    const r = mergePickedModels(existing, candidates, new Set(candidates.map((c) => c.id)))
    assert.equal(r.models.length, 50, '最多 50 条')
    assert.equal(r.skipped, 4, '4 条被上限挡下（而不是静默丢弃）')
    assert.equal(r.models[49]!.id, 'new0', '先到先得')
  })

  it('非法参数不写进目录（0/负数/非有限值）', () => {
    const r = mergePickedModels([], [
      { id: 'x', caps: { maxTokens: 0, contextWindow: -1 } },
      { id: 'y', caps: { maxTokens: Number.NaN, contextWindow: 32768 } },
    ], new Set(['x', 'y']))
    assert.deepEqual(r.models, [{ id: 'x' }, { id: 'y', contextWindow: 32768 }])
  })

  it('空勾选 / 空候选都是无副作用 no-op', () => {
    assert.deepEqual(mergePickedModels([{ id: 'a' }], [{ id: 'b' }], new Set()).models, [{ id: 'a' }])
    assert.deepEqual(mergePickedModels([{ id: 'a' }], [], new Set(['a'])).models, [{ id: 'a' }])
  })
})

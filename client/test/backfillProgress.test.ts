/**
 * 难度回填「进行中 / 已停止」文案纯函数测试（client/src/backfillProgress.ts）。
 *
 * 这些文案决定用户对三件事的判断：现在跑到哪了、停止是否生效、还剩多少要靠下次点击补
 * —— 口径必须稳定（与 syncStatus.ts 同款：文案抽成纯函数，组件只负责取值与渲染）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  progressText,
  resultText,
  type BackfillPlatformResult,
  type BackfillResponse,
  type BackfillRunStatus,
} from '../src/backfillProgress.ts'

const nameOf = (platform: string): string => (platform === 'luogu' ? '洛谷' : platform === 'nowcoder' ? '牛客' : platform)

const run = (over: Partial<BackfillRunStatus> = {}): BackfillRunStatus => ({
  running: true,
  stopping: false,
  startedAt: '2026-09-27T12:00:00.000Z',
  platform: 'luogu',
  platformDone: 37,
  platformTotal: 192,
  done: 37,
  total: 320,
  ...over,
})

const row = (over: Partial<BackfillPlatformResult> = {}): BackfillPlatformResult => ({
  platform: 'nowcoder',
  scanned: 12,
  filled: 3,
  nativeFilled: 2,
  repaired: 1,
  missing: 0,
  failed: 0,
  capped: 0,
  deferred: 0,
  cached: 0,
  ...over,
})

const response = (over: Partial<BackfillResponse> = {}): BackfillResponse => ({
  ok: true,
  stopped: false,
  unknownLeft: 466,
  results: [row()],
  ...over,
})

test('progressText：未运行（或没有状态）时为空 —— 按钮回到「一键回填」语义', () => {
  assert.equal(progressText(null, nameOf), '')
  assert.equal(progressText(run({ running: false }), nameOf), '')
})

test('progressText：运行中给出「平台 已完成/平台总数（本轮共 N 题）」', () => {
  assert.equal(progressText(run(), nameOf), '正在处理 洛谷 37/192（本轮共 320 题）')
})

test('progressText：平台未定/规模未知时不编数字', () => {
  assert.equal(
    progressText(run({ platform: null, platformDone: 0, platformTotal: 0, done: 0, total: 0 }), nameOf),
    '正在准备…',
  )
})

test('progressText：停止中说明「在途请求会被立即中断、已落库的保留」', () => {
  assert.equal(progressText(run({ stopping: true }), nameOf), '正在停止…（在途请求立即中断，已落库的保留）')
})

test('resultText：正常完成的文案保持既有口径（含 cached/deferred/capped 明细）', () => {
  const text = resultText(
    response({
      results: [
        row({ capped: 5, cached: 7, deferred: 0 }),
        row({ platform: 'luogu', scanned: 2, filled: 0, nativeFilled: 0, repaired: 0, missing: 1, failed: 1, deferred: 9 }),
      ],
    }),
    nameOf,
  )
  assert.match(text, /牛客：补难度 3 题、补原生难度 2 题、修标题\/标签\/难度值 1 题/)
  assert.match(text, /7 题维持「无官方难度」/)
  assert.match(text, /本次上限外还有 5 题（再点一次继续）/)
  assert.match(text, /洛谷：.*官方无难度 1 题.*失败 1 题.*跳过 9 题（难度已有、仅缺原生值）/)
  assert.match(text, /全库剩余未知难度 466 题$/)
  assert.doesNotMatch(text, /已停止/)
})

test('resultText：被停止时首句明说「已停止」并指向再点一次，不谎报完成', () => {
  const text = resultText(response({ stopped: true, unknownLeft: 300, results: [row({ capped: 8 })] }), nameOf)
  assert.match(text, /^已停止（已落库的成果不受影响）：/)
  assert.match(text, /再点一次继续/)
  assert.doesNotMatch(text, /难度回填完成/)
})

test('resultText：上游明确拒绝（401/403 已删除/私有）与「官方无难度」分开说', () => {
  // 两件事对用户含义不同：官方无难度 = 平台就没给这道题评级；
  // 无公开来源 = 题已下架/私有，再等也没有 —— 且两者都有负缓存，下轮不再重复查询
  const text = resultText(
    response({ results: [row({ platform: 'luogu', missing: 2, denied: 3, cached: 5 })] }),
    nameOf,
  )
  assert.match(text, /官方无难度 2 题/)
  assert.match(text, /无公开来源 3 题（上游已下架\/私有）/)
  assert.match(text, /5 题维持「无官方难度」/)
})

test('resultText：旧服务端不返回 denied 字段时不出现这一段（不误报 0）', () => {
  const text = resultText(response({ results: [row({ missing: 1 })] }), nameOf)
  assert.doesNotMatch(text, /无公开来源/)
})

test('resultText：QOJ 的 missing 说「推不出难度」而不是「官方无难度」', () => {
  // QOJ 平台自身没有难度字段（靠 ICPC/CCPC 公开榜单推导）：missing = 推导失败，
  // 不是「上游未评级」——说法不同，用户要做的事也不同（换网络/补凭据重试 vs 就此接受）
  const text = resultText(response({ results: [row({ platform: 'qoj', missing: 3 })] }), nameOf)
  assert.match(text, /qoj：.*推不出难度 3 题（公开榜单未匹配）/)
  assert.doesNotMatch(text, /官方无难度/)
})

test('resultText：库内没有任何待补的题', () => {
  assert.equal(resultText(response({ results: [], unknownLeft: 0 }), nameOf), '库内没有待回填难度的题')
})

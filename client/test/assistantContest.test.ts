import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ParticipatedContest } from '../../shared/src/index.ts'
import {
  REVIEW_REQUEST_TEXT,
  contestJumpWarning,
  reviewRequestText,
} from '../src/pages/assistantContest.ts'

/**
 * 赛后复盘入口文案（pages/assistantContest.ts）：复盘请求要带**本场关键事实**
 * （AI 本来要反问的内容），`?contest=` 推导失败要**明确提示而非静默丢弃**。
 */

function contest(over: Partial<ParticipatedContest> = {}): ParticipatedContest {
  return {
    key: 'codeforces:1877',
    platform: 'codeforces',
    contestId: '1877',
    name: 'Codeforces Round 900 (Div. 2)',
    url: 'https://codeforces.com/contest/1877',
    startTimeIso: '2026-09-20T14:00:00.000Z',
    endTimeIso: '2026-09-20T16:10:00.000Z',
    submissionCount: 9,
    problemCount: 6,
    acProblemCount: 2,
    inContestAcProblemCount: null,
    lastSubmittedAt: '2026-09-20T16:00:00.000Z',
    evidence: 'contest',
    source: null,
    ...over,
  }
}

test('reviewRequestText：带上本场关键事实（AC 题数/提交数），省一轮反问', () => {
  const text = reviewRequestText(contest())
  assert.match(text, /Codeforces Round 900 \(Div\. 2\)/)
  assert.match(text, /AC 2\/6 题/)
  assert.match(text, /共 9 次提交/)
  assert.match(text, /补题建议/)
})

test('reviewRequestText：赛时 < 当前 AC 时带出赛时/补题拆分，AI 直接知道补题进度', () => {
  const text = reviewRequestText(contest({ acProblemCount: 4, inContestAcProblemCount: 2 }))
  assert.match(text, /AC 4\/6 题（赛时 AC 2、赛后补题 2）/)
  // 赛时未知或已全部补完（持平）时不加拆分，避免无信息量的括号
  assert.doesNotMatch(reviewRequestText(contest()), /赛时 AC/)
  assert.doesNotMatch(
    reviewRequestText(contest({ acProblemCount: 2, inContestAcProblemCount: 2 })),
    /赛时 AC/,
  )
})

test('reviewRequestText：零提交场次显式说明「没有同步到提交记录」，不编 0/0', () => {
  const text = reviewRequestText(
    contest({
      key: 'atcoder:abc380',
      platform: 'atcoder',
      contestId: 'abc380',
      name: null,
      submissionCount: 0,
      problemCount: 0,
      acProblemCount: 0,
      evidence: 'joined-list',
    }),
  )
  assert.match(text, /我没有同步到该场的提交记录/)
  assert.doesNotMatch(text, /AC 0\/0/)
  assert.match(text, /atcoder · abc380/, '无赛名时回退「平台 · 比赛号」')
})

test('contestJumpWarning：说明推导失败原因并声明保留预填文本', () => {
  const msg = contestJumpWarning('codeforces:9999')
  assert.match(msg, /codeforces:9999/)
  assert.match(msg, /尚未同步|已被清理/)
  assert.match(msg, /已保留复盘请求文本/)
  assert.match(REVIEW_REQUEST_TEXT, /请复盘这场比赛/, '兜底预填文本仍是完整的复盘请求')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ParticipatedContest } from '../../shared/src/index.ts'
import * as view from '../src/pages/contestsView.ts'

function contest(id: string, over: Partial<ParticipatedContest> = {}): ParticipatedContest {
  return {
    key: `codeforces:${id}`, contestId: id, platform: 'codeforces', name: `Round ${id}`,
    url: '', startTimeIso: '2026-10-01T12:00:00Z', endTimeIso: '2026-10-01T14:00:00Z',
    lastSubmittedAt: '2026-10-02T12:00:00Z', submissionCount: 3, problemCount: 3,
    acProblemCount: 3, inContestAcProblemCount: 2, evidence: 'contest', source: null,
    ...over,
  }
}

test('补题进度只用官方总题数，本地交过三题全 AC 不代表补完比赛', () => {
  assert.equal(view.upsolveProgress(contest('1')).status, 'unknown')
  const known = contest('2', { source: { problemCount: 6, rank: null, rating: null, ratingChange: null, acceptedCount: null } })
  assert.deepEqual(view.upsolveProgress(known), { status: 'pending', total: 6, remaining: 3 })
  assert.deepEqual(view.upsolveProgress({ ...known, acProblemCount: 7 }), { status: 'complete', total: 6, remaining: 0 })
  assert.equal(view.upsolveProgress({ ...known, submissionCount: 0 }).status, 'unknown', '缺本地明细不等于没交题')
})

test('官方题单提供的总数可用于虚拟赛等没有平台成绩的记录', () => {
  const c = contest('virtual', { evidence: 'virtual', totalProblemCount: 7, source: null })
  assert.deepEqual(view.upsolveProgress(c), { status: 'pending', total: 7, remaining: 4 })
  assert.deepEqual(view.upsolveProgress({ ...c, acProblemCount: 7 }), { status: 'complete', total: 7, remaining: 0 })
})

test('参赛搜索组合平台、名称、场次号和账号；训练推测可以单独筛选', () => {
  const rows = [
    contest('100', { name: 'Educational Codeforces Round 100', accounts: ['main', 'Alt'] }),
    contest('101', { name: 'Educational Codeforces Round 101', evidence: 'gym' }),
    contest('abc200', { platform: 'atcoder', evidence: 'heuristic', name: 'AtCoder ABC 200' }),
  ]
  assert.deepEqual(view.filterParticipated(rows, { query: '  EDUCATIONAL alt ' }).map(c => c.contestId), ['100'])
  assert.deepEqual(view.filterParticipated(rows, { evidence: 'inferred' }).map(c => c.contestId), ['101', 'abc200'])
  assert.deepEqual(view.filterParticipated(rows, { platform: 'atcoder', evidence: 'recorded' }), [])
  assert.equal(view.filterParticipated(rows, { query: '101', evidence: 'recorded' }).length, 0)
})

test('只有 AC 下限时不能声称确切剩余题数，下限已覆盖全场则可确认完成', () => {
  const c = contest('partial', { acCountIsLowerBound: true, source: { problemCount: 6, rank: null, rating: null, ratingChange: null, acceptedCount: 4 } })
  assert.equal(view.upsolveProgress(c).status, 'unknown')
  assert.equal(view.upsolveProgress({ ...c, acProblemCount: 6 }).status, 'complete')
})

test('补题筛选与活动排序独立：补旧题不改变默认参赛时间顺序，未知时间排最后', () => {
  const source = { problemCount: 6, rank: null, rating: null, ratingChange: null, acceptedCount: null }
  const rows = [
    contest('old', { startTimeIso: '2026-09-01T00:00:00Z', lastSubmittedAt: '2026-10-14T00:00:00Z', source }),
    contest('new', { startTimeIso: '2026-10-10T00:00:00Z', acProblemCount: 6, source }),
    contest('unknown', { startTimeIso: null }),
  ]
  assert.deepEqual(view.filterParticipated(rows, {}).map(c => c.contestId), ['new', 'old', 'unknown'])
  assert.deepEqual(view.filterParticipated(rows, { progress: 'pending' }).map(c => c.contestId), ['old'])
  assert.deepEqual(view.filterParticipated(rows, { progress: 'unknown' }).map(c => c.contestId), ['unknown'])
  assert.deepEqual(view.filterParticipated(rows, { sort: 'activity' }).map(c => c.contestId), ['old', 'new', 'unknown'])
  assert.equal(rows[0].contestId, 'old', '筛选排序不修改 API 原数组')
})

test('赛事视图从 URL 恢复；非法参数回退，QOJ 切到日历时清除不支持的筛选', () => {
  const params = new URLSearchParams('tab=participated&platform=qoj&q=4071&progress=pending&evidence=inferred&sort=activity&page=3')
  const state = view.readContestView(params)
  assert.equal(state.tab, 'participated')
  assert.equal(state.platform, 'qoj')
  assert.equal(state.page, 3)
  const restored = view.readContestView(view.contestViewParams(state))
  assert.deepEqual(restored, state)
  const calendar = view.readContestView(view.contestViewParams({ ...state, tab: 'upcoming' }))
  assert.equal(calendar.platform, undefined)
  assert.equal(calendar.progress, 'all')
  assert.equal(calendar.evidence, 'all')
  assert.deepEqual(view.readContestView(new URLSearchParams('tab=x&platform=garbage&page=NaN&sort=x&progress=x')), view.readContestView(new URLSearchParams()))
})

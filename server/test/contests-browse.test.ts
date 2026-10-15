import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { ContestInfo } from '../../shared/src/index.ts';
import { createDb } from '../src/db/index.ts';
import { contestsRoutes } from '../src/routes/contests.ts';
import { contestPhase, selectContests } from '../src/contests/index.ts';
import { deriveParticipatedContests } from '../src/contests/participated.ts';
import { listenForTest } from './test-listen.ts';

function contest(id: string, name = id, category = 'Div. 2'): ContestInfo {
  return { id, name, category, platform: 'codeforces', startTimeIso: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 120, phase: 'BEFORE', url: '' };
}

test('日历先搜索和分类再分页，能找到默认首屏以外的场次', () => {
  const rows = Array.from({ length: 70 }, (_, i) => contest(`cf-${i}`, `Round ${i}`));
  rows.push(contest('cf-target', 'Educational Codeforces Round 500', 'Educational'));
  assert.deepEqual(selectContests(rows, { type: 'upcoming', query: 'educational 500', category: 'Educational', limit: 18 }).map(c => c.id), ['cf-target']);
  assert.deepEqual(selectContests(rows, { type: 'upcoming', offset: 69, limit: 18 }).map(c => c.id), ['cf-69', 'cf-target']);
});

test('坏日期与非法时长不归入已结束比赛', () => {
  assert.equal(contestPhase({ ...contest('bad'), startTimeIso: 'not-a-date' }), null);
  assert.equal(contestPhase({ ...contest('bad'), durationMinutes: NaN }), null);
  assert.equal(contestPhase({ ...contest('bad'), durationMinutes: -10 }), null);
});

test('参赛历史保留超过 200 场的旧赛，供客户端全量搜索与活动排序', () => {
  const db = createDb(':memory:');
  try {
    const records = Array.from({ length: 205 }, (_, i) => ({
      platform: 'nowcoder' as const, contestId: String(i), name: `历史比赛 ${i}`, url: '',
      startTimeMs: Date.now() - (i + 1) * 86400_000, endTimeMs: Date.now() - (i + 1) * 86400_000 + 7200_000,
      rank: null, rating: null, ratingChange: null, problemCount: null, acceptedCount: null,
    }));
    const history = deriveParticipatedContests(db, { sources: { nowcoder: records } });
    assert.equal(history.length, 205);
    assert.equal(history.at(-1)?.contestId, '204');
  } finally { db.close(); }
});

test('日历接口返回筛选总数、分类与分页结果；强制刷新绕过平台缓存', async () => {
  let revision = 1;
  let cfCalls = 0;
  const fetchStub = (async (input: string | URL | Request) => {
    if (String(input).includes('contest.list')) {
      cfCalls++;
      return Response.json({ status: 'OK', result: [
        { id: 9901, name: `Educational Round ${revision}`, phase: 'BEFORE', startTimeSeconds: Math.floor(Date.now() / 1000) + 86400, durationSeconds: 7200 },
        { id: 9902, name: 'Codeforces Round (Div. 3)', phase: 'BEFORE', startTimeSeconds: Math.floor(Date.now() / 1000) + 172800, durationSeconds: 7200 },
      ] });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const db = createDb(':memory:');
  const app = express();
  app.use('/api/contests', contestsRoutes(db, fetchStub));
  const server = await listenForTest(app);
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/contests`;
  try {
    const first = await (await fetch(`${base}?type=upcoming&limit=1&offset=1`)).json();
    assert.equal(first.total, 2);
    assert.deepEqual(first.contests.map((c: ContestInfo) => c.id), ['cf-9902']);
    assert.deepEqual(first.categories.sort(), ['Div. 3', 'Educational']);
    revision = 2;
    const search = await (await fetch(`${base}?type=upcoming&q=educational&category=Educational`)).json();
    assert.equal(search.total, 1);
    assert.equal(search.contests[0].name, 'Educational Round 1', '普通查询复用缓存');
    const refreshed = await (await fetch(`${base}?type=upcoming&q=educational&refresh=1`)).json();
    assert.equal(refreshed.contests[0].name, 'Educational Round 2');
    assert.equal(cfCalls, 2, '刷新时重新获取上游，普通筛选不重复拉取');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  }
});

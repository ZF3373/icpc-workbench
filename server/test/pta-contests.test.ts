import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPtaContest, fetchPtaContests, toPtaContest } from '../src/contests/ptaContests.ts';

/**
 * PTA 赛事数据源测试。
 * 夹具取自线上实测：GET /api/competitions/public?page=&limit=
 *   → { total, competitions: [{ id, name, startAt, endAt, type, ... }] }（startAt/endAt 为 ISO8601 UTC）
 */

test('pta 赛事：分类按名称关键词归组', () => {
  assert.equal(classifyPtaContest('2026年CCPC网络预选赛'), '网络预选赛');
  assert.equal(classifyPtaContest('2026 ICPC Asia EC网络预选赛 - 第一场'), '网络预选赛');
  assert.equal(classifyPtaContest('2026 ICPC Asia EC Final（总决赛）'), '总决赛');
  assert.equal(classifyPtaContest('重庆市第十四届大学生程序设计大赛'), '省赛');
  assert.equal(classifyPtaContest('“绿盟杯”内蒙古自治区第十九届大学生程序设计竞赛'), '省赛');
  assert.equal(classifyPtaContest('某某大学邀请赛'), '邀请赛');
  assert.equal(classifyPtaContest('蓝桥杯省赛模拟'), '省赛');
  assert.equal(classifyPtaContest('随便什么名字'), '比赛');
});

test('pta 赛事：competition → ContestInfo', () => {
  const c = toPtaContest({
    id: '2099750481526394880',
    name: '2026年CCPC网络预选赛',
    startAt: '2026-09-19T05:00:00Z',
    endAt: '2026-09-19T10:00:00Z',
  });
  assert.ok(c);
  assert.equal(c!.id, 'pta-2099750481526394880');
  assert.equal(c!.platform, 'pta');
  assert.equal(c!.startTimeIso, '2026-09-19T05:00:00.000Z');
  assert.equal(c!.durationMinutes, 300);
  assert.equal(c!.category, '网络预选赛');
  assert.equal(c!.url, 'https://pintia.cn/competitions/2099750481526394880');
});

test('pta 赛事：缺 id / 缺时间 / 时间倒挂的行一律丢弃（不参与日程排序）', () => {
  assert.equal(toPtaContest({ id: '', name: 'x', startAt: '2026-09-19T05:00:00Z', endAt: '2026-09-19T10:00:00Z' }), null);
  assert.equal(toPtaContest({ id: '1', name: 'x' }), null);
  assert.equal(toPtaContest({ id: '1', name: 'x', startAt: 'bogus', endAt: '2026-09-19T10:00:00Z' }), null);
  // 结束早于开始 = 脏数据
  assert.equal(toPtaContest({ id: '1', name: 'x', startAt: '2026-09-19T10:00:00Z', endAt: '2026-09-19T05:00:00Z' }), null);
});

test('pta 赛事：列表拉取去重并透传 total', async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.match(url, /competitions\/public\?page=0&limit=100/);
    return new Response(
      JSON.stringify({
        total: 2,
        competitions: [
          { id: '2', name: 'B 赛', startAt: '2026-09-19T05:00:00Z', endAt: '2026-09-19T10:00:00Z' },
          { id: '2', name: 'B 赛（重复）', startAt: '2026-09-19T05:00:00Z', endAt: '2026-09-19T10:00:00Z' },
          { id: '1', name: 'A 赛', startAt: '2026-09-12T05:00:00Z', endAt: '2026-09-12T10:00:00Z' },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const list = await fetchPtaContests(fetchFn, true);
  assert.deepEqual(list.map((c) => c.id), ['pta-2', 'pta-1']);
});

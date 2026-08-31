import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { contestsRoutes } from '../src/routes/contests.ts';
import { fetchCfContests, clearContestCache } from '../src/contests/cfContests.ts';
import { parseCfGroupCodes } from '../src/contests/index.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const FUTURE_START = Math.floor(Date.now() / 1000) + 3600;

const PUBLIC_BODY = {
  status: 'OK',
  result: [
    {
      id: 9999,
      name: 'Codeforces Round (Div. 2)',
      type: 'CF',
      phase: 'BEFORE',
      frozen: false,
      durationSeconds: 7200,
      startTimeSeconds: FUTURE_START,
    },
  ],
};

const GROUP_BODY = {
  status: 'OK',
  result: [
    {
      id: 2261,
      name: '队内模拟赛 #7',
      type: 'ICPC',
      phase: 'BEFORE',
      frozen: false,
      durationSeconds: 10800,
      startTimeSeconds: FUTURE_START + 1800,
    },
  ],
};

/** 按 URL 分发：公开榜 / group=G1 正常，group=BAD 500，其余全部失败（模拟其他平台不可达） */
function makeFetch(): { calls: string[]; fetchFn: typeof fetch } {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const json = async () => {
      if (u.includes('group=BAD')) throw new Error('HTTP 500 body');
      if (u.includes('group=')) return GROUP_BODY;
      if (u.includes('contest.list')) return PUBLIC_BODY;
      throw new Error('unreachable source');
    };
    return {
      ok: !u.includes('group=BAD'),
      status: u.includes('group=BAD') ? 500 : 200,
      json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

beforeEach(() => clearContestCache());

test('parseCfGroupCodes: 分隔/去重/去非法/数量上限', () => {
  assert.deepEqual(parseCfGroupCodes('G1, G2；，G1  bad*code\ng3'), ['G1', 'G2', 'g3']);
  assert.deepEqual(parseCfGroupCodes(null), []);
  assert.deepEqual(parseCfGroupCodes('   '), []);
  assert.equal(parseCfGroupCodes(Array.from({ length: 15 }, (_, i) => `grp${i}`).join(' ')).length, 10);
});

test('fetchCfContests: 公开榜 + 小组合并，小组映射 cfg- 前缀与 group 链接', async () => {
  const { calls, fetchFn } = makeFetch();
  const contests = await fetchCfContests(fetchFn, ['G1']);
  assert.equal(contests.length, 2);
  const group = contests.find((c) => c.id.startsWith('cfg-'))!;
  assert.equal(group.id, 'cfg-G1-2261');
  assert.equal(group.category, '小组');
  assert.equal(group.platform, 'codeforces');
  assert.equal(group.url, 'https://codeforces.com/group/G1/contest/2261');
  assert.ok(group.url.startsWith('https://codeforces.com/group/G1/'));
  assert.ok(calls.some((u) => u.includes('group=G1')));
  assert.ok(contests.some((c) => c.id === 'cf-9999'));
});

test('fetchCfContests: 单个小组失败降级不报错，全部失败才抛', async () => {
  const { fetchFn } = makeFetch();
  const degraded = await fetchCfContests(fetchFn, ['BAD']);
  assert.equal(degraded.length, 1); // 公开榜仍在

  const allFail = (async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error('HTTP 500');
    },
  })) as unknown as typeof fetch;
  clearContestCache();
  await assert.rejects(() => fetchCfContests(allFail, ['BAD']), /Codeforces API HTTP 500/);
});

test('fetchCfContests: 小组结果缓存 30 分钟，clearContestCache 失效', async () => {
  const { calls, fetchFn } = makeFetch();
  await fetchCfContests(fetchFn, ['G1']);
  const afterFirst = calls.length;
  await fetchCfContests(fetchFn, ['G1']);
  assert.equal(calls.length, afterFirst); // 命中缓存，无新请求
  clearContestCache();
  await fetchCfContests(fetchFn, ['G1']);
  assert.ok(calls.length > afterFirst);
});

test('设置 + 赛事路由端到端：保存小组 code 后 /api/contests 返回组内比赛', async () => {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  const { fetchFn } = makeFetch();
  app.use('/api/contests', contestsRoutes(db, fetchFn));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  type ContestsResp = { contests: Array<{ id: string; category: string; url: string }> };
  const getContests = async (): Promise<ContestsResp> =>
    (await (await fetch(`${base}/api/contests?type=upcoming`)).json()) as ContestsResp;
  try {
    // 保存前：仅公开榜
    let body = await getContests();
    assert.ok(body.contests.some((c) => c.id === 'cf-9999'));
    assert.ok(!body.contests.some((c) => c.category === '小组'));

    // 保存小组 code（含一个非法项应被过滤）
    const saved = await fetch(`${base}/api/settings/cf-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: 'G1, bad*' }),
    });
    const savedBody = (await saved.json()) as { codes: string[] };
    assert.deepEqual(savedBody.codes, ['G1']);

    // 设置读取
    clearContestCache();
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as { cfGroups: string };
    assert.equal(settings.cfGroups, 'G1');

    // 再查赛事：组内比赛出现
    clearContestCache();
    body = await getContests();
    const group = body.contests.find((c) => c.category === '小组')!;
    assert.equal(group.id, 'cfg-G1-2261');
    assert.ok(group.url.includes('/group/G1/contest/2261'));

    // 清空
    await fetch(`${base}/api/settings/cf-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: '' }),
    });
    clearContestCache();
    body = await getContests();
    assert.ok(!body.contests.some((c) => c.category === '小组'));
  } finally {
    srv.close();
    db.close();
  }
});

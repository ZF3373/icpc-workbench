import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { contestsRoutes } from '../src/routes/contests.ts';
import {
  fetchCfContests,
  clearContestCache,
  signedContestListUrl,
  type CfApiAuth,
} from '../src/contests/cfContests.ts';
import { parseCfGroupCodes } from '../src/contests/index.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const FUTURE_START = Math.floor(Date.now() / 1000) + 3600;
const AUTH: CfApiAuth = { apiKey: 'KEY123', secret: 'SECRET456' };

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

/**
 * 按 URL 分发：
 * - group=<code> 带 apiKey → 小组数据；不带 apiKey → 返回公开榜（模拟 CF 对匿名 group 参数静默忽略）
 * - group=BAD → HTTP 500
 * - 其余 URL（其他平台源）→ 失败，模拟不可达
 */
function makeFetch(): { calls: string[]; fetchFn: typeof fetch } {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    let body: unknown;
    if (u.includes('group=BAD')) body = { status: 'FAILED', comment: 'Internal error' };
    else if (u.includes('group=')) body = u.includes('apiKey=') ? GROUP_BODY : PUBLIC_BODY;
    else if (u.includes('contest.list')) body = PUBLIC_BODY;
    else throw new Error('unreachable source');
    return {
      ok: !u.includes('group=BAD'),
      status: u.includes('group=BAD') ? 500 : 200,
      json: async () => body,
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

test('signedContestListUrl: apiSig 签名格式正确（参数排序 + sha512(method?params#secret)）', () => {
  const url = signedContestListUrl('G1', AUTH);
  const u = new URL(url);
  assert.equal(u.pathname, '/api/contest.list');
  assert.equal(u.searchParams.get('group'), 'G1');
  assert.equal(u.searchParams.get('apiKey'), AUTH.apiKey);
  const time = u.searchParams.get('time')!;
  assert.ok(/^\d+$/.test(time));
  const apiSig = u.searchParams.get('apiSig')!;
  const toSign = `contest.list?apiKey=${AUTH.apiKey}&group=G1&time=${time}#${AUTH.secret}`;
  assert.equal(apiSig, createHash('sha512').update(toSign).digest('hex'));
});

test('fetchCfContests: 认证后公开榜 + 小组合并，小组映射 cfg- 前缀与 group 链接', async () => {
  const { calls, fetchFn } = makeFetch();
  const contests = await fetchCfContests(fetchFn, ['G1'], AUTH);
  assert.equal(contests.length, 2);
  const group = contests.find((c) => c.id.startsWith('cfg-'))!;
  assert.equal(group.id, 'cfg-G1-2261');
  assert.equal(group.category, '小组');
  assert.equal(group.platform, 'codeforces');
  assert.equal(group.url, 'https://codeforces.com/group/G1/contest/2261');
  assert.ok(calls.some((u) => u.includes('group=G1') && u.includes(`apiKey=${AUTH.apiKey}`) && u.includes('apiSig=')));
  assert.ok(contests.some((c) => c.id === 'cf-9999'));
});

test('fetchCfContests: 未配置 Key 时跳过小组源（不拿公开榜冒充小组赛）', async () => {
  const { calls, fetchFn } = makeFetch();
  const contests = await fetchCfContests(fetchFn, ['G1']);
  assert.equal(contests.length, 1); // 仅公开榜
  assert.ok(!contests.some((c) => c.category === '小组'));
  assert.ok(!calls.some((u) => u.includes('group='))); // 根本没发小组请求
});

test('fetchCfContests: 单个小组失败降级不报错，全部失败才抛', async () => {
  const { fetchFn } = makeFetch();
  const degraded = await fetchCfContests(fetchFn, ['BAD'], AUTH);
  assert.equal(degraded.length, 1); // 公开榜仍在

  const allFail = (async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error('HTTP 500');
    },
  })) as unknown as typeof fetch;
  clearContestCache();
  await assert.rejects(() => fetchCfContests(allFail, ['BAD'], AUTH), /Codeforces API HTTP 500/);
});

test('fetchCfContests: 小组结果缓存 30 分钟，clearContestCache 失效', async () => {
  const { calls, fetchFn } = makeFetch();
  await fetchCfContests(fetchFn, ['G1'], AUTH);
  const afterFirst = calls.length;
  await fetchCfContests(fetchFn, ['G1'], AUTH);
  assert.equal(calls.length, afterFirst); // 命中缓存，无新请求
  clearContestCache();
  await fetchCfContests(fetchFn, ['G1'], AUTH);
  assert.ok(calls.length > afterFirst);
});

test('设置 + 赛事路由端到端：配置小组 code 与 API Key 后 /api/contests 返回组内比赛', async () => {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  const { calls, fetchFn } = makeFetch();
  app.use('/api/contests', contestsRoutes(db, fetchFn));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  type ContestsResp = { contests: Array<{ id: string; category: string; url: string }> };
  const getContests = async (): Promise<ContestsResp> =>
    (await (await fetch(`${base}/api/contests?type=upcoming`)).json()) as ContestsResp;
  const postGroups = (payload: Record<string, string>): Promise<Response> =>
    fetch(`${base}/api/settings/cf-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  try {
    // 只存小组 code、未配 Key：不发小组请求，也不冒充
    const saved = await postGroups({ groups: 'G1, bad*' });
    const savedBody = (await saved.json()) as { codes: string[] };
    assert.deepEqual(savedBody.codes, ['G1']);
    let body = await getContests();
    assert.ok(body.contests.some((c) => c.id === 'cf-9999'));
    assert.ok(!body.contests.some((c) => c.category === '小组'));
    assert.ok(!calls.some((u) => u.includes('group=')));

    // 补上 API Key：组内比赛出现，请求带认证参数
    const keyCalls = calls.length;
    await postGroups({ groups: 'G1', apiKey: AUTH.apiKey, secret: AUTH.secret });
    clearContestCache();
    body = await getContests();
    const group = body.contests.find((c) => c.category === '小组')!;
    assert.equal(group.id, 'cfg-G1-2261');
    assert.ok(group.url.includes('/group/G1/contest/2261'));
    assert.ok(calls.slice(keyCalls).some((u) => u.includes('group=G1') && u.includes('apiKey=KEY123')));

    // 设置读取
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as {
      cfGroups: string;
      cfApiKey: string;
      cfSecret: string;
    };
    assert.equal(settings.cfGroups, 'G1');
    assert.equal(settings.cfApiKey, AUTH.apiKey);
    assert.equal(settings.cfSecret, AUTH.secret);

    // 清空
    await postGroups({ groups: '', apiKey: '', secret: '' });
    clearContestCache();
    body = await getContests();
    assert.ok(!body.contests.some((c) => c.category === '小组'));
  } finally {
    srv.close();
    db.close();
  }
});

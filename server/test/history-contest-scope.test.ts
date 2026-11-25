import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { historyRoutes } from '../src/routes/history.ts';
import { contestScopeSql, type ContestScope } from '../src/history/contestScope.ts';

/**
 * 按比赛 / 参赛阶段筛选提交（issue #70）。
 *
 * 这里钉住三条容易被写错的口径（都是评审意见指出的）：
 * 1. 必须限制在**比赛所属平台**上，否则没有可靠窗口的场次会返回全平台提交；
 * 2. Codeforces 的 context 只说明「比赛中/虚拟赛/练习」，**不含哪一场**，
 *    必须与「这场比赛里的题」取交集，否则选 A 场会把 B 场的赛时提交算进来；
 * 3. 归属证据与窗口都拿不到时不猜（回空 + 说明），而不是把该平台全部提交当成这一场。
 */

const scope = (over: Partial<ContestScope> = {}): ContestScope => ({
  contestKey: 'codeforces:1877',
  platform: 'codeforces',
  contestId: '1877',
  problemKeys: null,
  startMs: Date.parse('2026-09-10T14:35:00.000Z'),
  endMs: Date.parse('2026-09-10T16:35:00.000Z'),
  reliableWindow: true,
  name: 'Codeforces Round 1877',
  ...over,
});

test('永远带平台约束：别的平台的提交不属于这场比赛', () => {
  for (const phase of ['during', 'after', 'all'] as const) {
    const { sql, params } = contestScopeSql(scope(), phase);
    assert.match(sql, /s\.platform = \?/);
    assert.equal(params[0], 'codeforces');
  }
});

test('Codeforces：赛时 = context(contest/virtual) 且属于本场（URL 段匹配）', () => {
  const { sql, params } = contestScopeSql(scope(), 'during');
  assert.match(sql, /s\.platform = \?/);
  // 归属：/contest/1877/ 或 /gym/1877/ —— 不能只按题号前缀（1877 与 187 会撞）
  assert.match(sql, /p\.url LIKE \? ESCAPE/);
  assert.deepEqual(params.slice(1, 3), ['%/contest/1877/%', '%/gym/1877/%']);
  assert.match(sql, /s\.context IN \('contest','virtual'\)/);
});

test('有官方题目集时按题号集合精确归属（比 URL 更准）', () => {
  const { sql, params } = contestScopeSql(scope({ problemKeys: ['1877A', '1877B'] }), 'during');
  assert.match(sql, /p\.problem_key IN \(\?,\?\)/);
  assert.deepEqual(params.slice(1, 3), ['1877A', '1877B']);
  assert.doesNotMatch(sql, /p\.url LIKE/);
});

test('赛后 = practice 或（无语境且晚于结束），仍然限制在本场', () => {
  const { sql, params } = contestScopeSql(scope(), 'after');
  assert.match(sql, /s\.context = 'practice'/);
  assert.ok(params.includes('2026-09-10T16:35:00.000Z'));
  assert.match(sql, /p\.url LIKE \? ESCAPE/);
});

test('无可靠窗口的非 CF 平台：靠题号归属判定，而不是返回全平台', () => {
  // 洛谷：题号与链接都不带比赛信息 → 无法归属
  const luogu = contestScopeSql(scope({ platform: 'luogu', contestKey: 'luogu:353129', contestId: '353129', reliableWindow: false }), 'all');
  assert.equal(luogu.sql, ' AND 1 = 0');
  assert.match(luogu.note ?? '', /无法归属|缺少/);
  // QOJ：比赛题键 {contestId}-{problemId} 可判归属，即使没有窗口
  const qoj = contestScopeSql(scope({ platform: 'qoj', contestKey: 'qoj:1234', contestId: '1234', reliableWindow: false }), 'all');
  assert.match(qoj.sql, /p\.problem_key LIKE \? ESCAPE/);
  assert.ok(qoj.params.includes('1234-%'));
  assert.equal(qoj.note, null);
});

test('AtCoder 无窗口：按 /contests/slug/ 归属', () => {
  const { sql, params } = contestScopeSql(scope({ platform: 'atcoder', contestKey: 'atcoder:abc380', contestId: 'abc380', reliableWindow: false }), 'all');
  assert.match(sql, /s\.platform = \?/);
  assert.ok(params.includes('%/contests/abc380/%'));
  // 平台不下发 context：不应出现 context 条件
  assert.doesNotMatch(sql, /context/);
});

test('题号里的下划线被 LIKE 转义（AtCoder 的 abc321_a 不能当通配符）', () => {
  const { params } = contestScopeSql(scope({ platform: 'qoj', contestKey: 'qoj:12_3', contestId: '12_3', reliableWindow: false }), 'all');
  assert.ok(params.includes('12\\_3-%'));
});

async function withServer<T>(db: Db, run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/api/history', historyRoutes(db));
  const srv = await listenForTest(app);
  try {
    return await run(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/history`);
  } finally {
    srv.close();
  }
}

function seed(db: Db): void {
  const insertProblem = db.prepare(
    'INSERT INTO problems (platform, problem_key, title, url) VALUES (?, ?, ?, ?)',
  );
  const pid = Number(insertProblem.run('codeforces', '1877B', 'Two Binary Strings', 'https://codeforces.com/contest/1877/problem/B').lastInsertRowid);
  // 另一场比赛的同平台提交：选 1877 时**不该**出现
  const other = Number(insertProblem.run('codeforces', '1900A', 'Another Round', 'https://codeforces.com/contest/1900/problem/A').lastInsertRowid);
  // 另一个平台的提交：同样不该出现
  const luogu = Number(insertProblem.run('luogu', 'P1001', 'A+B', 'https://www.luogu.com.cn/problem/P1001').lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id, context, submission_url)
     VALUES (1, ?, 'alice', ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('codeforces', pid, 'WA', '2026-09-10T15:00:00.000Z', '11', 'contest', 'https://codeforces.com/contest/1877/submission/11');
  insert.run('codeforces', pid, 'AC', '2026-09-12T09:00:00.000Z', '12', 'practice', null);
  insert.run('codeforces', other, 'AC', '2026-09-11T10:00:00.000Z', '13', 'contest', null);
  insert.run('luogu', luogu, 'AC', '2026-09-10T15:30:00.000Z', '21', null, null);
}

test('逐条视图带 submissionUrl：库内有值直接用，为 NULL 时按平台模板现算', async () => {
  const db = createDb(':memory:');
  seed(db);
  await withServer(db, async (base) => {
    const res = (await (await fetch(`${base}/submissions?view=submission`)).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const byId = new Map(res.items.map((it) => [it.externalId, it]));
    assert.equal(byId.get('11')?.submissionUrl, 'https://codeforces.com/contest/1877/submission/11');
    // CF 需要 contestId，单靠提交号算不出 → null（前端据此不渲染链接）
    assert.equal(byId.get('12')?.submissionUrl, null);
    assert.equal(byId.get('11')?.context, 'contest');
    assert.equal(byId.get('11')?.account, 'alice');
  });
});

test('按账号筛选：只回该账号的提交', async () => {
  const db = createDb(':memory:');
  seed(db);
  await withServer(db, async (base) => {
    const bob = (await (await fetch(`${base}/submissions?view=submission&account=bob`)).json()) as { total: number };
    assert.equal(bob.total, 0);
    const alice = (await (await fetch(`${base}/submissions?view=submission&account=alice`)).json()) as { total: number };
    assert.equal(alice.total, 4);
  });
});

test('无法解析的比赛 key：明确回空并给出说明（而不是静默忽略筛选）', async () => {
  const db = createDb(':memory:');
  seed(db);
  await withServer(db, async (base) => {
    const res = (await (await fetch(`${base}/submissions?view=submission&contestKey=codeforces:999999`)).json()) as {
      total: number;
      scopeNote?: string;
    };
    assert.equal(res.total, 0);
    assert.match(res.scopeNote ?? '', /未找到比赛/);
  });
});

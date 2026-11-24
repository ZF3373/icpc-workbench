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
 * 重点是口径而不是 SQL 文本：虚拟赛必须靠平台自报的 context 判（时间窗会全错），
 * 无可靠窗口的平台不猜（返回「全部」而不是空）。
 */

const scope = (over: Partial<ContestScope> = {}): ContestScope => ({
  contestKey: 'codeforces:1877',
  platform: 'codeforces',
  startMs: Date.parse('2026-09-10T14:35:00.000Z'),
  endMs: Date.parse('2026-09-10T16:35:00.000Z'),
  reliableWindow: true,
  name: 'Codeforces Round 1877',
  ...over,
});

test('Codeforces 赛时：平台语境优先于时间窗（虚拟赛不会被时间窗判错）', () => {
  const { sql, params } = contestScopeSql(scope(), 'during');
  assert.match(sql, /s\.context IN \('contest','virtual'\)/);
  assert.equal(params.length, 2);
  assert.equal(params[0], '2026-09-10T14:35:00.000Z');
});

test('Codeforces 赛后：practice 或（无语境且晚于结束）', () => {
  const { sql, params } = contestScopeSql(scope(), 'after');
  assert.match(sql, /s\.context = 'practice'/);
  assert.match(sql, /s\.submitted_at >= \?/);
  assert.deepEqual(params, ['2026-09-10T16:35:00.000Z']);
});

test('无可靠时间窗的平台：不猜，返回全部而不是空', () => {
  // 洛谷：平台不下发 context，也没有可靠窗口 → 无法判定阶段
  const nonCf = scope({ platform: 'luogu', reliableWindow: false });
  for (const phase of ['during', 'after', 'all'] as const) {
    assert.deepEqual(contestScopeSql(nonCf, phase), { sql: '', params: [] });
  }
  // 洛谷但窗口可靠：能按时间窗判
  const nonCfWithWindow = scope({ platform: 'luogu', reliableWindow: true });
  const during = contestScopeSql(nonCfWithWindow, 'during');
  assert.match(during.sql, /s\.submitted_at >= \? AND s\.submitted_at < \?/);
  assert.doesNotMatch(during.sql, /context/);
});

test('Codeforces 无可靠窗口：仍能靠 context 判定（老行已由同步回填）', () => {
  const cfNoWindow = scope({ reliableWindow: false });
  assert.match(contestScopeSql(cfNoWindow, 'during').sql, /context IN \('contest','virtual'\)/);
  assert.match(contestScopeSql(cfNoWindow, 'after').sql, /context = 'practice'/);
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
  const pid = Number(
    db.prepare('INSERT INTO problems (platform, problem_key, title) VALUES (?, ?, ?)')
      .run('codeforces', '1877B', 'Two Binary Strings').lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id, context, submission_url)
     VALUES (1, 'codeforces', 'alice', ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(pid, 'WA', '2026-09-10T15:00:00.000Z', '11', 'contest', 'https://codeforces.com/contest/1877/submission/11');
  insert.run(pid, 'AC', '2026-09-12T09:00:00.000Z', '12', 'practice', null);
}

test('逐条视图带 submissionUrl：库内有值直接用，为 NULL 时按平台模板现算', async () => {
  const db = createDb(':memory:');
  seed(db);
  await withServer(db, async (base) => {
    const res = (await (await fetch(`${base}/submissions?view=submission`)).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const byId = new Map(res.items.map((it) => [it.externalId, it]));
    // 库内有值 → 原样返回
    assert.equal(byId.get('11')?.submissionUrl, 'https://codeforces.com/contest/1877/submission/11');
    // 老行为 NULL → 现算（CF 需要 contestId，单靠提交号算不出，故为空）
    assert.equal(byId.get('12')?.submissionUrl, null);
    // 语境与账号一并下发（前端标注 + 按次参赛筛选）
    assert.equal(byId.get('11')?.context, 'contest');
    assert.equal(byId.get('11')?.account, 'alice');
  });
});

test('按账号筛选：只回该账号的提交', async () => {
  const db = createDb(':memory:');
  seed(db);
  await withServer(db, async (base) => {
    const res = (await (await fetch(`${base}/submissions?view=submission&account=bob`)).json()) as {
      total: number;
    };
    assert.equal(res.total, 0);
    const own = (await (await fetch(`${base}/submissions?view=submission&account=alice`)).json()) as {
      total: number;
    };
    assert.equal(own.total, 2);
  });
});

test('无法解析的比赛 key：明确回空（而不是静默忽略筛选）', async () => {
  const db = createDb(':memory:');
  seed(db);
  await withServer(db, async (base) => {
    const res = (await (await fetch(`${base}/submissions?view=submission&contestKey=codeforces:999999`)).json()) as {
      total: number;
    };
    assert.equal(res.total, 0);
  });
});

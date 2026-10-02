/**
 * 多账号统计隔离回归（v0.8 多账号只做到「存」没做到「算」）。
 *
 * 提交按 submissions.account 归属到具体账号，但统计族此前只按 user_id 过滤，
 * 于是主力号 + 练习小号的 AC 率 / 弱项 / 掌握度 / 趋势 / 热力被静默混算。
 * 这里钉住三件事：
 * 1) 不带 account 时行为完全不变（默认全部账号）；
 * 2) account 必须与 platform 同时给——handle 只在平台内唯一（platform_accounts
 *    UNIQUE(user_id, platform, handle)），同一个人在洛谷与牛客的 uid 数字可能撞车；
 * 3) 各统计口径的账号基准（弱项的平均 AC 率、掌握度的总体 AC 率）也随作用域收窄，
 *    否则「相对自身平均」的 gap 仍是被稀释过的全体平均。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { PlatformId, Verdict } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { accountClause, computeOverall, fetchRows } from '../src/analysis/stats.ts';
import { computeWeakness } from '../src/analysis/weakness.ts';
import { computeTrend } from '../src/analysis/trend.ts';
import { computeHeatmap } from '../src/analysis/heatmap.ts';
import { computeMastery } from '../src/analysis/mastery.ts';
import { statsRoutes } from '../src/routes/stats.ts';
import { listenForTest } from './test-listen.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function add(
  platform: PlatformId,
  account: string,
  key: string,
  verdict: Verdict,
  submittedAt: string,
  opts: { difficulty?: number; tags?: string[] } = {},
): void {
  insertNormalized(
    db,
    1,
    [
      {
        problem: {
          platform,
          problemKey: key,
          title: `题 ${key}`,
          ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
          tags: opts.tags ?? [],
        },
        verdict,
        submittedAt,
        externalId: `${platform}-${account}-${key}-${verdict}-${submittedAt}`,
      },
    ],
    { account },
  );
}

/** 主力号 2 AC / 小号 1 AC 1 WA —— 混算会把主力号的 100% AC 率稀释成 60% */
function seedTwoCfAccounts(): void {
  add('codeforces', 'main', 'A', 'AC', '2026-09-20T05:00:00.000Z', { difficulty: 1500, tags: ['动态规划'] });
  add('codeforces', 'main', 'B', 'AC', '2026-09-21T05:00:00.000Z', { difficulty: 1800, tags: ['动态规划'] });
  add('codeforces', 'alt', 'C', 'AC', '2026-09-22T05:00:00.000Z', { difficulty: 800 });
  add('codeforces', 'alt', 'D', 'WA', '2026-09-22T06:00:00.000Z', { difficulty: 2600 });
}

test('不带 account 时统计跨全部账号（行为不变）', () => {
  seedTwoCfAccounts();
  const all = computeOverall(db, 1, { platform: 'codeforces' });
  assert.equal(all.attempts, 4);
  assert.equal(all.ac, 3);
  assert.equal(all.acRate, 75);
});

test('computeOverall/fetchRows 按账号收窄，弱项与难度分档也只含该账号', () => {
  seedTwoCfAccounts();
  const scoped = computeOverall(db, 1, { platform: 'codeforces', account: 'main' });
  assert.equal(scoped.attempts, 2);
  assert.equal(scoped.ac, 2);
  assert.equal(scoped.acRate, 100);
  assert.equal(scoped.solvedProblems, 2);
  assert.deepEqual(
    scoped.byDifficulty.map((d) => d.bucket),
    ['1400-1599', '1600-1899'],
  );
  // 小号那道 2600 的 WA 不该再出现在分档里
  assert.ok(!scoped.byDifficulty.some((d) => d.bucket === '2600+'));
  assert.equal(fetchRows(db, 1, { platform: 'codeforces', account: 'alt' }).length, 2);
});

test('account 只在平台内唯一：同名 handle 跨平台必须靠 platform 区分', () => {
  // 同一个人常在洛谷/牛客用同一串数字 uid
  add('luogu', '713093328', 'P1001', 'AC', '2026-09-20T05:00:00.000Z');
  add('nowcoder', '713093328', 'NC1', 'WA', '2026-09-20T05:00:00.000Z');
  const luoguOnly = computeOverall(db, 1, { platform: 'luogu', account: '713093328' });
  assert.equal(luoguOnly.attempts, 1);
  assert.equal(luoguOnly.ac, 1);
  const nowcoderOnly = computeOverall(db, 1, { platform: 'nowcoder', account: '713093328' });
  assert.equal(nowcoderOnly.attempts, 1);
  assert.equal(nowcoderOnly.ac, 0);
});

test('accountClause：只有 account 没有 platform 直接拒绝，不猜作用域', () => {
  assert.throws(() => accountClause({ account: 'main' }), /platform/);
  assert.deepEqual(accountClause({}), { sql: '', params: [] });
  assert.deepEqual(accountClause({ platform: 'codeforces' }), {
    sql: ' AND s.platform = ?',
    params: ['codeforces'],
  });
  assert.deepEqual(accountClause({ platform: 'codeforces', account: 'main' }), {
    sql: ' AND s.platform = ? AND s.account = ?',
    params: ['codeforces', 'main'],
  });
});

test('弱项画像的平均 AC 率基准按账号计算（否则 gap 被其他账号稀释）', () => {
  add('codeforces', 'main', 'A', 'AC', '2026-09-20T05:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'main', 'B', 'AC', '2026-09-21T05:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'alt', 'C', 'WA', '2026-09-22T05:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'alt', 'D', 'WA', '2026-09-22T06:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'alt', 'E', 'AC', '2026-09-22T07:00:00.000Z');
  add('codeforces', 'alt', 'F', 'AC', '2026-09-22T08:00:00.000Z');

  // 全体口径：小号的 DP 全 WA 把平均拉到 66.7%，DP 只有 50% → 被记成弱项
  const all = computeWeakness(db, 1, { minAttempts: 2, topN: 10 });
  const allDp = all.items.find((i) => i.tag === '动态规划');
  assert.ok(allDp);
  assert.equal(allDp!.avgAcRate, 66.7);
  assert.equal(allDp!.acRate, 50);
  assert.ok(allDp!.gap > 0);

  // 主力号口径：DP 两道全 AC = 自身平均，gap 归零
  const main = computeWeakness(db, 1, { minAttempts: 2, topN: 10, platform: 'codeforces', account: 'main' });
  const mainDp = main.items.find((i) => i.tag === '动态规划');
  assert.ok(mainDp);
  assert.equal(mainDp!.attempts, 2);
  assert.equal(mainDp!.avgAcRate, 100);
  assert.equal(mainDp!.acRate, 100);
  assert.equal(mainDp!.gap, 0);
});

test('周趋势按账号收窄', () => {
  seedTwoCfAccounts();
  const now = new Date('2026-09-28T12:00:00Z');
  const all = computeTrend(db, 1, 4, now);
  assert.equal(all.reduce((n, t) => n + t.attempts, 0), 4);
  const scoped = computeTrend(db, 1, 4, now, { platform: 'codeforces', account: 'main' });
  assert.equal(scoped.reduce((n, t) => n + t.attempts, 0), 2);
  assert.equal(scoped.reduce((n, t) => n + t.ac, 0), 2);
});

test('热力图按账号收窄（同题被两个账号 AC 时各算各的）', () => {
  add('codeforces', 'main', 'A', 'AC', '2026-09-24T05:00:00.000Z');
  add('codeforces', 'alt', 'A', 'AC', '2026-09-24T06:00:00.000Z');
  const NOW = new Date(2026, 8, 24, 15, 0, 0);
  const all = computeHeatmap(db, 1, { days: 3, now: NOW, platform: 'codeforces' });
  assert.equal(all.totalAttempts, 2);
  // 去重题数口径：同一题两个账号都 AC 仍只算 1 题
  assert.equal(all.totalSolved, 1);
  const main = computeHeatmap(db, 1, { days: 3, now: NOW, platform: 'codeforces', account: 'main' });
  assert.equal(main.totalAttempts, 1);
  assert.equal(main.days[main.days.length - 1].solved, 1);
});

test('掌握度的总体 AC 率基准与逐知识点计数都按账号收窄', () => {
  add('codeforces', 'main', 'A', 'AC', '2026-09-20T05:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'main', 'B', 'WA', '2026-09-20T06:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'alt', 'C', 'WA', '2026-09-20T07:00:00.000Z', { tags: ['动态规划'] });
  add('codeforces', 'alt', 'D', 'WA', '2026-09-20T08:00:00.000Z', { tags: ['动态规划'] });

  const pointOf = (opts: Parameters<typeof computeMastery>[2]) => {
    const report = computeMastery(db, 1, opts);
    return report.points.find((p) => p.code === 'dp.general');
  };
  const all = pointOf({ minSolved: 1 });
  assert.equal(all?.attempts, 4);
  assert.equal(all?.avgAcRate, 25); // 1 AC / 4

  const main = pointOf({ minSolved: 1, platform: 'codeforces', account: 'main' });
  assert.equal(main?.attempts, 2);
  assert.equal(main?.acRate, 50);
  assert.equal(main?.avgAcRate, 50); // 基准只剩主力号自己的两提交
  assert.equal(main?.gap, 0);
});

// —— 路由层 ——

let server: Server;
let base = '';
beforeEach(async () => {
  const app = express();
  app.use('/api/stats', statsRoutes(db));
  app.use((err: unknown, _req: express.Request, res: express.Response) => {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  });
  server = await listenForTest(app);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

test('GET /api/stats 接受 account 并按账号收窄', async () => {
  seedTwoCfAccounts();
  const all = await get('/api/stats?platform=codeforces');
  assert.equal((all.body as { attempts: number }).attempts, 4);
  const scoped = await get('/api/stats?platform=codeforces&account=main');
  assert.equal((scoped.body as { attempts: number }).attempts, 2);
});

test('GET /api/stats?account= 缺 platform 时明确报错，不静默跨平台合并', async () => {
  const res = await get('/api/stats?account=main');
  assert.equal(res.status, 400);
  assert.match((res.body as { error: string }).error, /platform/);
});

test('GET /api/stats/accounts 列出有数据的账号供前端切换', async () => {
  seedTwoCfAccounts();
  add('luogu', '1892580', 'P1001', 'AC', '2026-09-19T05:00:00.000Z');
  add('codeforces', '', 'MANUAL', 'AC', '2026-09-18T05:00:00.000Z'); // 手动导入无归属账号
  const body = (await get('/api/stats/accounts')).body as Array<{
    platform: string;
    account: string;
    attempts: number;
    ac: number;
    solved: number;
    lastSubmittedAt: string;
  }>;
  assert.deepEqual(
    body.map((a) => `${a.platform}:${a.account}:${a.attempts}:${a.solved}`).sort(),
    ['codeforces:alt:2:1', 'codeforces:main:2:2', 'luogu:1892580:1:1'],
  );
  assert.equal(body.find((a) => a.account === 'alt')?.lastSubmittedAt, '2026-09-22T06:00:00.000Z');
  // 无归属账号（手动导入）的行没有可切换的意义，不出现在列表里
  assert.ok(!body.some((a) => a.account === ''));
});

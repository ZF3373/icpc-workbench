/**
 * GET /api/contests/analysis?contestKey= 的单场过滤回归。
 *
 * 赛事中心「我参加的」弹窗按 contestKey 请求单场分析：
 * - 命中：只返回这一场的投影（contests.length === 1），不携带其他场；
 * - 该场不满足可靠归属（key 拼错 / 证据不足）→ 404 + 中文错误文案，
 *   前端据此在弹窗里展示「这场比赛没有可分析数据」而不是空白卡片。
 *
 * 全程内存库 + 卡死不返回的 fetch：analysis 路由不触发任何网络拉取。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { contestsRoutes } from '../src/routes/contests.ts';
import type { ContestAnalysisResponse } from '../../shared/src/index.ts';

const hangingFetch: typeof fetch = () => new Promise(() => {});

function seedContest(db: Db): void {
  // 牛客平台参赛记录（对齐 contests-participated.test.ts 的 Educational 195 夹具结构）：
  // joined-list 证据 + 完整起止时间窗 → 可靠归属，analysis 必须能推导出这一场。
  // 提交带 account：participationAccounts 靠 submissions.account 发现牛客账号，
  // 缺它 readParticipationSnapshot 读不到平台参赛记录。
  const pid = db
    .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('nowcoder', 'A', '题 A')")
    .run().lastInsertRowid as number;
  db.prepare(
    "INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id) VALUES (1, 'nowcoder', 'u', ?, 'AC', ?, 'nc-1')",
  ).run(pid, '2026-09-20T11:30:00.000Z');
  db.prepare(
    `INSERT INTO participated_contests
       (user_id, platform, account, contest_id, name, url, start_ms, end_ms, contest_rank, fetched_at, problem_ids, problem_set_state)
     VALUES (1, 'nowcoder', 'u', '140237', '牛客周赛 Round 162',
             'https://ac.nowcoder.com/acm/contest/140237', ?, ?, 371, ?, ?, 'ok')`,
  ).run(Date.parse('2026-09-20T11:00:00.000Z'), Date.parse('2026-09-20T13:00:00.000Z'),
    new Date(Date.now() - 60 * 60_000).toISOString(),
    JSON.stringify([{ id: 'A', title: '题 A' }, { id: 'B', title: '题 B' }]));
}

test('analysis 路由：?contestKey= 只返回该场投影，命不中返回 404', async () => {
  const db = createDb(':memory:');
  let srv: Server | undefined;
  try {
    seedContest(db);
    const app = express();
    app.use(express.json());
    app.use('/api/contests', contestsRoutes(db, hangingFetch));
    srv = await listenForTest(app);
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/contests/analysis`;

    const all = (await (await fetch(base)).json()) as ContestAnalysisResponse;
    assert.ok(all.contests.length >= 1, '无 key 时返回全量投影');

    const one = (await (await fetch(`${base}?contestKey=nowcoder:140237`)).json()) as ContestAnalysisResponse;
    assert.equal(one.contests.length, 1, '按 key 过滤后只剩这一场');
    assert.equal(one.contests[0]!.contest.key, 'nowcoder:140237');
    assert.equal(one.contests[0]!.problems.length, 2, '题目集里的未提交题也列出');
    const a = one.contests[0]!.problems.find(p => p.problemKey === 'A')!;
    assert.equal(a.attemptCount, 1, '赛时提交按时间窗归入赛时');
    assert.equal(a.contestAccepted, true);
    const b = one.contests[0]!.problems.find(p => p.problemKey === 'B')!;
    assert.equal(b.attemptCount, 0, '未提交题显示为未尝试');

    const missing = await fetch(`${base}?contestKey=nowcoder:999999`);
    assert.equal(missing.status, 404, '不存在的 key 返回 404');
    const body = (await missing.json()) as { error: string };
    assert.match(body.error, /无法生成赛时分析/, '404 带中文文案，前端可直接展示');
  } finally {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    db.close();
  }
});

test('analysis 路由：usedTags 返回历史标签（多用优先），增删标签后同步更新', async () => {
  const db = createDb(':memory:');
  let srv: Server | undefined;
  try {
    seedContest(db);
    const app = express();
    app.use(express.json());
    app.use('/api/contests', contestsRoutes(db, hangingFetch));
    srv = await listenForTest(app);
    const port = (srv.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/contests`;

    const tagPath = `${base}/analysis/tags`;
    const put = (problemKey: string, tag: string) => fetch(tagPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contestKey: 'nowcoder:140237', platform: 'nowcoder', problemKey, tag }),
    });

    // 「贪心」用在两道题上、「暴力」一道 → 选择框候选按使用次数排序
    const r1 = (await (await put('A', '贪心')).json()) as { usedTags?: string[] };
    await put('B', '贪心');
    const r3 = (await (await put('A', '暴力')).json()) as { usedTags?: string[] };
    assert.deepEqual(r3.usedTags, ['贪心', '暴力'], 'PUT 回报最新候选，多用者优先');

    const analysis = (await (await fetch(`${base}/analysis?contestKey=nowcoder:140237`)).json()) as ContestAnalysisResponse;
    assert.deepEqual(analysis.usedTags, ['贪心', '暴力'], 'analysis 响应带历史候选');

    const del = await fetch(tagPath, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contestKey: 'nowcoder:140237', platform: 'nowcoder', problemKey: 'A', tag: '贪心' }),
    });
    const delBody = (await del.json()) as { usedTags?: string[] };
    assert.deepEqual([...(delBody.usedTags ?? [])].sort(), ['暴力', '贪心'], 'DELETE 单题标签后：他处仍在用，候选保留');
    assert.ok(r1.usedTags, '首次 PUT 也带 usedTags 字段');
  } finally {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    db.close();
  }
});

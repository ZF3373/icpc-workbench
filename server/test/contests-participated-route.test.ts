/**
 * GET /api/contests/participated 的 `refreshing` 回报回归。
 *
 * 后台刷新已在跑时（kickBackgroundRefresh 返回 false），GET 也必须照实回报
 * 「正在刷新的平台」——旧实现此时返回 refreshing=[]，前端撤掉「正在后台更新」
 * 提示、也不会轮询跟进，用户既看不到状态也拿不到新数据（2026-10 审查修复）。
 *
 * 用「卡死不返回的 fetch」制造真实的 in-flight 后台刷新窗口；日历缓存行保持
 * 新鲜，使 GET 全程不触发日历网络拉取。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { contestsRoutes } from '../src/routes/contests.ts';

/** 卡死不返回：让第一次 GET 触发的后台刷新一直处于 in-flight */
const hangingFetch: typeof fetch = () => new Promise(() => {});

function seedStalePlatform(db: Db): void {
  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  // latestAccounts 从 submissions 推导「该平台当前账号」：一条带 account 的提交即完成绑定
  const pid = db
    .prepare(
      "INSERT INTO problems (platform, problem_key, title) VALUES ('nowcoder', 'NC1', '题 NC1')",
    )
    .run().lastInsertRowid as number;
  db.prepare(
    "INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id) VALUES (1, 'nowcoder', 'u', ?, 'AC', ?, 'nc-1')",
  ).run(pid, hourAgo);
  db.prepare(
    "INSERT INTO participation_sync (user_id, platform, account, last_sync_at, backlog_done) VALUES (1, 'nowcoder', 'u', ?, 1)",
  ).run(hourAgo);
  db.prepare(
    `INSERT INTO participated_contests
       (user_id, platform, account, contest_id, name, url, start_ms, end_ms, contest_rank, fetched_at)
     VALUES (1, 'nowcoder', 'u', '140237', '牛客周赛 Round 162',
             'https://ac.nowcoder.com/acm/contest/140237', ?, ?, 371, ?)`,
  ).run(Date.parse('2026-09-20T11:00:00.000Z'), Date.parse('2026-09-20T13:00:00.000Z'), hourAgo);
  // 日历缓存保持新鲜：GET 不触发日历网络拉取（fetchAllContests 走真网）
  db.prepare("INSERT INTO calendar_cache (id, fetched_at, contests) VALUES (1, ?, '[]')").run(
    new Date().toISOString(),
  );
}

test('participated 路由：后台刷新已在跑时仍回报 refreshing（横幅不消失、前端可跟进）', async () => {
  const db = createDb(':memory:');
  let srv: Server | undefined;
  try {
    seedStalePlatform(db);
    const app = express();
    app.use('/api/contests', contestsRoutes(db, hangingFetch));
    srv = await listenForTest(app);
    const port = (srv.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/contests/participated`;

    const r1 = (await (await fetch(base)).json()) as { refreshing: string[]; contests: Array<{ key: string }> };
    assert.deepEqual(r1.refreshing, ['nowcoder'], '首次 GET：过期平台触发后台刷新并回报');
    assert.equal(r1.contests.length, 1, '本次响应仍是库内存档数据（读库秒出）');

    const r2 = (await (await fetch(base)).json()) as { refreshing: string[] };
    assert.deepEqual(
      r2.refreshing,
      ['nowcoder'],
      '刷新已在跑（kick 返回 false）也必须照实回报，不得返回空让前端撤掉提示',
    );
  } finally {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
    db.close();
  }
});

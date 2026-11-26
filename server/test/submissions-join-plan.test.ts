import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { listenForTest } from './test-listen.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import {
  recommendProblems,
  recommendProblemsByWeakTag,
  practicePool,
} from '../src/plans/planService.ts';

/**
 * 回归：submissions 的逐题 LEFT JOIN 执行计划翻转（「过一段时间自动重启」的真因）。
 *
 * 真实库（2.5 万题 / 1509 提交、无 sqlite_stat1）上，planner 对
 * `LEFT JOIN submissions s ON s.problem_id = p.id AND s.user_id = ?` 放弃
 * idx_submissions_problem 点查、改走 idx_submissions_user_time —— 每道题扫一遍
 * 该用户全部提交（≈3900 万行访问），/page 的 list+count 各跑一次 ≈36s，
 * 同步 SQLite 阻塞事件循环超过壳看护容差 → kill_core 重拉 = 用户看到的「自动重启」。
 * NOT EXISTS 改写同样翻转，唯一稳定的写法是**先按用户预聚合成派生表再 JOIN**
 * （MATERIALIZE 一次 + 自动覆盖索引，不依赖 planner 统计）。
 *
 * 本文件断言**计划结构**而非耗时（计时测试在 CI 上不稳）：凡是从 problems 出发
 * 关联 submissions 的查询，EQP 里不得出现 `s USING INDEX idx_submissions_*`
 * ——命名索引只存在于原始表上，出现即意味着逐题回原始表扫描（翻转形态）；
 * 派生表形态走 AUTOMATIC COVERING INDEX / BLOOM FILTER，天然不命中该断言。
 */

// ---------- 脚手架 ----------

/** 包一层 prepare，录下路由/服务内部构造的全部 SQL（Db=DatabaseSync，实例属性可覆盖） */
function capturePrepare(db: Db): string[] {
  const captured: string[] = [];
  const orig = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    captured.push(sql);
    return orig(sql);
  }) as Db['prepare'];
  return captured;
}

function assertNoRawSubmissionsJoin(db: Db, sql: string): void {
  const binds = (sql.match(/\?/g) ?? []).length;
  const plan = db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(...Array(binds).fill(null)) as Array<{ detail: string }>;
  for (const { detail } of plan) {
    assert.ok(
      !/\bs USING (?:COVERING )?INDEX idx_submissions/.test(detail),
      `submissions 被逐题回原始表扫描（计划翻转形态）：${detail}\nSQL: ${sql}`,
    );
  }
}

/** 录到的 SQL 里，从 problems 出发关联 submissions 的那些 */
function problemJoinSqls(captured: string[]): string[] {
  return captured.filter((sql) => /FROM problems p/.test(sql) && /submissions/.test(sql));
}

function sub(key: string, verdict: 'AC' | 'WA', submittedAt: string): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces',
      problemKey: key,
      title: `T ${key}`,
      difficulty: 1500,
      tags: ['dp'],
      url: `https://codeforces.com/contest/${key}`,
    },
    verdict,
    submittedAt,
    externalId: `${key}-${verdict}-${submittedAt}`,
  };
}

function seed(db: Db): void {
  insertNormalized(db, 1, [
    sub('A', 'WA', '2026-07-28T10:00:00.000Z'),
    sub('A', 'AC', '2026-07-28T11:00:00.000Z'),
    sub('B', 'WA', '2026-07-28T12:00:00.000Z'),
  ]);
  // 纯题库题（无提交）：LEFT JOIN 空侧语义
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, tags, difficulty_source, url)
     VALUES ('codeforces', 'C', 'T C', 1600, '["dp"]', 'bank', 'https://codeforces.com/contest/C')`,
  ).run();
}

// 画像标签用规范名：候选标签经 canonicalTag 归一（dp → 动态规划）
const PROFILE = {
  items: [{ tag: '动态规划', attempts: 6, ac: 2, acRate: 33.3, avgAcRate: 60, gap: 26.7, rank: 26.7, solved: 2 }],
};

// ---------- 题库路由（/page、/facets、旧全量数组） ----------

test('题库路由的 submissions 关联一律预聚合，不得逐题回原始表（计划翻转回归）', async () => {
  const db = createDb(':memory:');
  seed(db);
  const captured = capturePrepare(db);
  const app = express();
  app.use('/api/problems', problemsRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    for (const qs of [
      '/page?bank=1',
      '/page?bank=1&status=ac',
      '/page?bank=1&status=tried',
      '/page?bank=1&status=none',
      '/facets?bank=1',
      '/?bank=1&tag=dp',
      '/', // includeBank=0 的 EXISTS 分支
    ]) {
      const res = await fetch(`${base}/api/problems${qs}`);
      assert.equal(res.status, 200, qs);
      await res.json();
    }
  } finally {
    srv.close();
  }
  const sqls = problemJoinSqls(captured);
  assert.ok(sqls.length >= 7, `应录到列表/计数/分面等查询，实际 ${sqls.length}`);
  for (const sql of sqls) assertNoRawSubmissionsJoin(db, sql);
  db.close();
});

test('预聚合后聚合口径不变：attempts/ac_count/last_ac_at 与逐行 JOIN 语义一致', async () => {
  const db = createDb(':memory:');
  seed(db);
  const app = express();
  app.use('/api/problems', problemsRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/problems/page?bank=1&sort=problem_key&order=asc`);
    const body = (await res.json()) as {
      items: Array<{ problem_key: string; attempts: number; ac_count: number; last_ac_at: string | null }>;
      total: number;
    };
    assert.equal(body.total, 3);
    const [a, b, c] = body.items;
    assert.deepEqual(
      [a.attempts, a.ac_count, a.last_ac_at],
      [2, 1, '2026-07-28T11:00:00.000Z'],
    );
    assert.deepEqual([b.attempts, b.ac_count, b.last_ac_at], [1, 0, null]);
    assert.deepEqual([c.attempts, c.ac_count, c.last_ac_at], [0, 0, null], '无提交题空侧为 0/null');

    // HAVING 别名陷阱：派生列若与 attempts/ac_count 同名，status=none 会解析到
    // 派生表原列（NULL）而非 COALESCE 别名，无提交题整组丢失
    const none = await fetch(`${base}/api/problems/page?bank=1&status=none`);
    const noneBody = (await none.json()) as { total: number; items: Array<{ problem_key: string }> };
    assert.equal(noneBody.total, 1);
    assert.deepEqual(noneBody.items.map((i) => i.problem_key), ['C']);
  } finally {
    srv.close();
  }
  db.close();
});

// ---------- 计划服务（今日推荐 / 弱项分组 / 训练候选池） ----------

test('planService 的 submissions 关联一律预聚合（同一翻转形态，实测 9-10s/条）', () => {
  const db = createDb(':memory:');
  seed(db);
  const captured = capturePrepare(db);
  recommendProblems(db, PROFILE as never, { level: null });
  recommendProblemsByWeakTag(db, PROFILE as never, { level: null });
  practicePool(db, ['dp']);
  const sqls = problemJoinSqls(captured);
  assert.ok(sqls.length >= 3, `应录到三条候选查询，实际 ${sqls.length}`);
  for (const sql of sqls) assertNoRawSubmissionsJoin(db, sql);
  db.close();
});

test('预聚合后推荐口径不变：未 AC 候选排除已 AC 题，aced/last_ac_at 正确', () => {
  const db = createDb(':memory:');
  seed(db);
  const recs = recommendProblems(db, PROFILE as never, { level: null });
  assert.deepEqual(recs.map((r) => r.problemKey).sort(), ['B', 'C'], 'A 已 AC 不得入候选');
  const groups = recommendProblemsByWeakTag(db, PROFILE as never, { level: null });
  const all = groups.flatMap((g) => g.problems);
  const a = all.find((p) => p.problemKey === 'A');
  assert.ok(a, '已 AC 题作复习参考保留');
  assert.equal(a.role, 'review');
  const pool = practicePool(db, ['dp']);
  assert.deepEqual(pool.map((r) => r.problemKey).sort(), ['B', 'C']);
  db.close();
});
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AiConfig } from '../src/config.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { plansRoutes } from '../src/routes/plans.ts';

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const ai: AiConfig = { enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' };
  const app = express();
  app.use(express.json());
  app.use('/api/plans', plansRoutes(db, () => ai));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/plans`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('DELETE /api/plans/:id removes plan and cascades tasks', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', '2026-08-10', '2026-08-12', 'template')",
    ).run();
    const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (?, '2026-08-10', 't1', 'practice')",
    ).run(planId);
    db.prepare(
      'INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, (SELECT id FROM plan_tasks LIMIT 1), ?)',
    ).run('2026-08-10');

    const res = await fetch(`${base}/${planId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get()!.c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plan_tasks').get()!.c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM checkins').get()!.c, 0); // 级联
  });
});

test('DELETE /api/plans/:id returns 404 for missing plan', async () => {
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/999`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /不存在/);
  });
});

async function seedTask(db: Db): Promise<number> {
  db.prepare(
    "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', '2026-08-10', '2026-08-12', 'template')",
  ).run();
  const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
  db.prepare(
    "INSERT INTO plan_tasks (plan_id, task_date, title, kind, url, note) VALUES (?, '2026-08-10', 't1', 'practice', 'https://x', 'n')",
  ).run(planId);
  return (db.prepare('SELECT id FROM plan_tasks').get() as { id: number }).id;
}

test('PATCH /api/plans/tasks/:taskId updates provided fields only', async () => {
  await withServer(async (db, base) => {
    const taskId = await seedTask(db);
    const res = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改名', kind: 'review', url: null }),
    });
    assert.equal(res.status, 200);
    const row = db
      .prepare('SELECT task_date, title, kind, url, note FROM plan_tasks WHERE id = ?')
      .get(taskId) as { task_date: string; title: string; kind: string; url: string | null; note: string };
    assert.equal(row.title, '改名');
    assert.equal(row.kind, 'review');
    assert.equal(row.url, null); // 传 null 清空
    assert.equal(row.note, 'n'); // 未提交字段不动
    assert.equal(row.task_date, '2026-08-10');
  });
});

test('PATCH /api/plans/tasks/:taskId validates inputs and 404s', async () => {
  await withServer(async (db, base) => {
    const taskId = await seedTask(db);
    const bad = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'xxx' }),
    });
    assert.equal(bad.status, 400);
    const badDate = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskDate: '2026/08/11' }),
    });
    assert.equal(badDate.status, 400);
    const empty = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    const missing = await fetch(`${base}/tasks/999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(missing.status, 404);
  });
});

test('DELETE /api/plans/tasks/:taskId removes task and its checkins', async () => {
  await withServer(async (db, base) => {
    const taskId = await seedTask(db);
    db.prepare('INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)').run(
      taskId,
      '2026-08-10',
    );
    const res = await fetch(`${base}/tasks/${taskId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plan_tasks').get()!.c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM checkins').get()!.c, 0); // 级联
    const again = await fetch(`${base}/tasks/${taskId}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  });
});

// ---------- POST /api/plans/import（导出提示词 → 手动喂 AI → 导入） ----------

test('POST /import saves AI-returned plan with fenced JSON and auto-links tasks', async () => {
  await withServer(async (db, base) => {
    // 模拟真实 AI 输出：围栏 + 前后解释文字；任务缺 url 由 savePlan 按题库补链
    db.prepare(
      `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags)
       VALUES ('codeforces', '1900F', 'Fancy Problem', 1600, 'https://codeforces.com/contest/1900/problem/F', '["dp"]')`,
    ).run();
    const raw = [
      '好的，这是你的训练计划：',
      '```json',
      '{',
      '  "title": "AI 定制 14 天冲刺",',
      '  "goal": "突破 dp 与图论",',
      '  "tasks": [',
      '    { "date": "2026-08-10", "title": "Fancy Problem 巩固练习", "kind": "practice", "platform": "codeforces", "problemKey": "1900F" },',
      '    { "date": "2026-08-11", "title": "回顾总结", "kind": "review" },',
      '  ]',
      '}',
      '```',
      '祝训练顺利！',
    ].join('\n');
    const res = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, startDate: '2026-08-10', days: 14 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; planId: number; title: string; taskCount: number };
    assert.equal(body.ok, true);
    assert.equal(body.title, 'AI 定制 14 天冲刺');
    assert.equal(body.taskCount, 2);
    const plan = db.prepare('SELECT source, raw_prompt FROM plans WHERE id = ?').get(body.planId) as { source: string; raw_prompt: string };
    assert.equal(plan.source, 'ai'); // 手动喂 AI 的产物同样标记为 ai 来源
    assert.ok(plan.raw_prompt.includes('```json')); // 原始 AI 输出留存
    const task = db
      .prepare('SELECT url, problem_id FROM plan_tasks WHERE plan_id = ? AND kind = ?')
      .get(body.planId, 'practice') as { url: string | null; problem_id: number | null };
    assert.equal(task.url, 'https://codeforces.com/contest/1900/problem/F'); // 缺 url 自动补链
    assert.ok((task.problem_id ?? 0) > 0);
  });
});

test('POST /import rejects missing raw, invalid JSON, and out-of-range dates', async () => {
  await withServer(async (_db, base) => {
    const missing = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /raw 必填/);

    const badJson = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: '这不是 JSON' }),
    });
    assert.equal(badJson.status, 400);
    assert.match(((await badJson.json()) as { error: string }).error, /导入失败/);

    // 任务日期在计划期外 → 全部被清洗 → "没有有效任务" 400
    const outOfRange = await fetch(`${base}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw: JSON.stringify({ title: 'x', goal: '', tasks: [{ date: '2025-01-01', title: '过期任务' }] }),
        startDate: '2026-08-10',
        days: 3,
      }),
    });
    assert.equal(outOfRange.status, 400);
  });
});

test('PATCH /api/plans/tasks/:id 改日期时同步迁移打卡记录的冗余 task_date', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', '2026-08-10', '2026-08-12', 'template')",
    ).run();
    const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (?, '2026-08-10', 't1', 'practice')",
    ).run(planId);
    const taskId = (db.prepare('SELECT id FROM plan_tasks').get() as { id: number }).id;
    db.prepare('INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)').run(taskId, '2026-08-10');

    const res = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskDate: '2026-08-11' }),
    });
    assert.equal(res.status, 200);
    // checkins.task_date 是冗余副本：不同步迁移的话，连续打卡/挂件永远记在旧日期，
    // 且重新打卡也修不好（INSERT OR IGNORE 按 task_id 去重）
    const cd = db.prepare('SELECT task_date FROM checkins WHERE task_id = ?').get(taskId) as { task_date: string };
    assert.equal(cd.task_date, '2026-08-11');
  });
});

// ---------- POST /api/plans/generate 入参范围校验（B14 / B15 回归） ----------

test('POST /generate 拒绝越界 days，且在校验阶段就返回（不进入 O(days) 循环）', async () => {
  await withServer(async (_db, base) => {
    /**
     * days 的 1-90 校验原本只在 savePlan 里，而它执行在 buildPlanPackage/templatePlan
     * 的 O(days) 循环**之后**：days=15000000 会让进程 heap out of memory（exit 134，
     * try/catch 拦不住，服务直接下线）。这里断言大值被快速拒绝。
     */
    const t0 = Date.now();
    const huge = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 15000000, startDate: '2026-10-09' }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(huge.status, 400);
    assert.match(((await huge.json()) as { error: string }).error, /days/);
    // 若真跑了循环，1500 万轮不可能在 5 秒内返回
    assert.ok(elapsed < 5000, `days 校验发生在昂贵循环之后（耗时 ${elapsed}ms）`);

    for (const bad of [91, 0, -1, 'abc', 14.5]) {
      const res = await fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: bad, startDate: '2026-10-09' }),
      });
      assert.equal(res.status, 400, `days=${String(bad)} 应被拒绝`);
    }

    // 边界内的值照常工作
    const ok = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 90, startDate: '2026-10-09' }),
    });
    assert.equal(ok.status, 200);
  });
});

test('POST /generate 拒绝非法 startDate（不再把 RangeError 原文回给用户）', async () => {
  await withServer(async (_db, base) => {
    for (const bad of ['garbage', '2026-13-45', '2026-02-30', '2026/10/09']) {
      const res = await fetch(`${base}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 7, startDate: bad }),
      });
      assert.equal(res.status, 400, `startDate=${bad} 应被拒绝`);
      const msg = ((await res.json()) as { error: string }).error;
      assert.match(msg, /startDate/, `错误文案应指向 startDate，实际: ${msg}`);
      assert.ok(!/Invalid time value/.test(msg), `泄露了引擎原文: ${msg}`);
    }
    // 省略 startDate 仍走默认（今天）
    const omitted = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 7 }),
    });
    assert.equal(omitted.status, 200);
  });
});

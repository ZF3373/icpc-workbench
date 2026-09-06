import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { plansRoutes } from '../src/routes/plans.ts';
import {
  applyPlanModification,
  parsePlanModifyJson,
  type PlanModification,
} from '../src/plans/planService.ts';

interface TestServer {
  db: Db
  base: string
}

async function withServer(
  fn: (s: TestServer, providerCalls: { system: string; messages: unknown[] }[]) => Promise<void>,
): Promise<void> {
  const db = createDb(':memory:');
  const providerCalls: { system: string; messages: unknown[] }[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/plans',
    plansRoutes(
      db,
      () => ({ enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' }),
      {
        createProvider: () => ({
          enabled: true,
          chat: async (messages) => {
            providerCalls.push({
              system: messages[0]?.content ?? '',
              messages: messages.slice(1),
            });
            return '好的，我已调整计划。```plan-modify\n{"title":"修改后计划","tasks":[]}\n```';
          },
        }),
      },
    ),
  );
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/plans`;
  try {
    await fn({ db, base }, providerCalls);
  } finally {
    srv.close();
    db.close();
  }
}

/** 建一个 3 任务计划（t1 已打卡），返回 planId 与 t1 的 taskId */
function seedPlan(db: Db): { planId: number; task1Id: number } {
  db.prepare(
    "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, '原计划', '练二分', '2026-09-01', '2026-09-07', 'ai')",
  ).run();
  const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
  const ins = db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (?, ?, ?, 'practice')");
  ins.run(planId, '2026-09-01', 't1');
  ins.run(planId, '2026-09-02', 't2');
  ins.run(planId, '2026-09-03', 't3');
  const task1Id = (db.prepare('SELECT id FROM plan_tasks ORDER BY id LIMIT 1').get() as { id: number }).id;
  db.prepare('INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)').run(task1Id, '2026-09-01');
  return { planId, task1Id };
}

// ---------- POST /:id/chat ----------

test('chat: injects plan context as system prompt and returns reply', async () => {
  await withServer(async ({ db, base }, providerCalls) => {
    const { planId } = seedPlan(db);
    const res = await fetch(`${base}/${planId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '第2周怎么安排？' }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { reply: string };
    assert.match(body.reply, /plan-modify/);
    assert.equal(providerCalls.length, 1);
    assert.match(providerCalls[0].system, /原计划/); // 计划标题注入
    assert.match(providerCalls[0].system, /t1/); // 任务清单注入
    assert.match(providerCalls[0].system, /2026-09-01/);
    assert.deepEqual(providerCalls[0].messages, [{ role: 'user', content: '第2周怎么安排？' }]);
  });
});

test('chat: rejects invalid messages and missing plan', async () => {
  await withServer(async ({ db, base }) => {
    const { planId } = seedPlan(db);
    const empty = await fetch(`${base}/${planId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(empty.status, 400);
    const missing = await fetch(`${base}/999/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(missing.status, 404);
  });
});

test('chat: returns needConfig guidance when AI disabled', async () => {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use(
    '/api/plans',
    plansRoutes(db, () => ({ enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' })),
  );
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/plans`;
  try {
    seedPlan(db);
    const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
    const res = await fetch(`${base}/${planId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; needConfig: boolean };
    assert.equal(body.needConfig, true);
    assert.match(body.error, /设置/);
  } finally {
    srv.close();
    db.close();
  }
});

// ---------- POST /:id/apply ----------

test('apply: keeps matching tasks with checkins, adds and removes others', async () => {
  await withServer(async ({ db, base }) => {
    const { planId, task1Id } = seedPlan(db);
    // t1 保留（打卡保留）、t2/t3 删除、新增 t4
    const raw = '已按要求调整：\n```plan-modify\n' + JSON.stringify({
      title: '修改后计划',
      tasks: [
        { date: '2026-09-01', title: 't1', kind: 'practice' },
        { date: '2026-09-04', title: 't4', kind: 'review', note: '回顾' },
      ],
    }) + '\n```';
    const res = await fetch(`${base}/${planId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; added: number; removed: number; kept: number; checkinsKept: number };
    assert.deepEqual(body, { ok: true, added: 1, removed: 2, kept: 1, checkinsKept: 1 });

    const title = (db.prepare('SELECT title FROM plans WHERE id = ?').get(planId) as { title: string }).title;
    assert.equal(title, '修改后计划');
    const tasks = db
      .prepare('SELECT id, task_date, title FROM plan_tasks WHERE plan_id = ? ORDER BY task_date')
      .all(planId) as Array<{ id: number; task_date: string; title: string }>;
    assert.deepEqual(tasks.map((t) => t.title), ['t1', 't4']);
    assert.equal(tasks[0].id, task1Id); // 保留原 id → 打卡外键存活
    const checkin = db.prepare('SELECT COUNT(*) AS c FROM checkins WHERE task_id = ?').get(task1Id) as { c: number };
    assert.equal(checkin.c, 1);
  });
});

test('apply: updates period when startDate/days given', async () => {
  await withServer(async ({ db, base }) => {
    const { planId } = seedPlan(db);
    const raw = '延长一周：\n```plan-modify\n' + JSON.stringify({
      days: 14,
      tasks: [{ date: '2026-09-10', title: '延期任务', kind: 'practice' }],
    }) + '\n```';
    const res = await fetch(`${base}/${planId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    assert.equal(res.status, 200);
    const plan = db.prepare('SELECT start_date, end_date FROM plans WHERE id = ?').get(planId) as {
      start_date: string;
      end_date: string;
    };
    assert.equal(plan.start_date, '2026-09-01'); // startDate 缺省沿用
    assert.equal(plan.end_date, '2026-09-14'); // days=14 → 结束日顺延
  });
});

test('apply: rejects malformed JSON and missing plan', async () => {
  await withServer(async ({ db, base }) => {
    const { planId } = seedPlan(db);
    const bad = await fetch(`${base}/${planId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: '```plan-modify\n{not json\n```' }),
    });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/999/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: '{"tasks":[]}' }),
    });
    assert.equal(missing.status, 404);
  });
});

// ---------- parsePlanModifyJson / applyPlanModification 单元 ----------

test('parsePlanModifyJson: fence variants, trailing commas, out-of-range dates dropped', () => {
  const raw = '说明文字\n```json\n{"title":"T","tasks":[{"date":"2026-09-02","title":"a",},{"date":"2026-10-99","title":"超期"},{"date":"2026-09-02"}]}\n```';
  const mod = parsePlanModifyJson(raw, '2026-09-01', 7);
  assert.equal(mod.title, 'T');
  assert.equal(mod.startDate, '2026-09-01');
  assert.equal(mod.days, 7);
  assert.equal(mod.tasks.length, 1); // 日期超期/缺标题条目被清洗
  assert.equal(mod.tasks[0].kind, 'practice'); // 未知 kind 回退
  assert.throws(() => parsePlanModifyJson('{"tasks":[]}', '2026-09-01', 7));
});

test('applyPlanModification: duplicate (date,title) new tasks hit UNIQUE → friendly error + rollback', () => {
  const db = createDb(':memory:');
  try {
    const { planId, task1Id } = seedPlan(db);
    const mod: PlanModification = {
      startDate: '2026-09-01',
      days: 7,
      tasks: [
        { date: '2026-09-01', title: 't1', kind: 'practice' },
        { date: '2026-09-02', title: 't2', kind: 'practice' }, // 与未打卡旧任务同 key → 视为保留
      ],
    };
    const r = applyPlanModification(db, 1, planId, mod);
    assert.equal(r.kept, 2);
    assert.equal(r.removed, 1); // t3 被删
    assert.equal(task1Id, (db.prepare('SELECT id FROM plan_tasks ORDER BY id LIMIT 1').get() as { id: number }).id);
  } finally {
    db.close();
  }
});

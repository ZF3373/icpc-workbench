/**
 * 复习间隔的「留存系数」与复习日志回归。
 *
 * 阶梯只回答「这一档该隔几天」，但同一档位下三道题的脆弱程度完全不同：
 * 反复失手过的、靠看题解才做出来的、所属知识点还没掌握的，都该排得更近；
 * 连续稳定答对、知识点已熟练的该排得更远。这里钉住信号来源与夹边界，
 * 以及每次反馈都落一行 review_events（后续任何自适应都要靠它）。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { reviewsRoutes } from '../src/routes/reviews.ts';
import { FACTOR_CEIL, FACTOR_FLOOR, retentionFactor } from '../src/reviews/retention.ts';
import { dateAfterDays, intervalDaysWithFactor } from '../src/reviews/schedule.ts';
import { localToday } from '../src/dates.ts';
import { listenForTest } from './test-listen.ts';

let db: Db;
let server: Server;
let base = '';

beforeEach(async () => {
  db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/reviews', reviewsRoutes(db));
  app.use((err: unknown, _req: express.Request, res: express.Response) => {
    res.status(500).json({ error: String((err as Error)?.message ?? err) });
  });
  server = await listenForTest(app);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

const NEUTRAL = { reviews: 0, lapses: 0, weakConcept: false, solidConcept: false, stuckByIntent: false };

function addProblem(key = '2001-A', difficulty = 1500): number {
  return db
    .prepare("INSERT INTO problems (platform, problem_key, title, difficulty, tags) VALUES ('codeforces', ?, ?, ?, '[]')")
    .run(key, `题 ${key}`, difficulty).lastInsertRowid as number;
}

/** 建一条复习条目（stage 直接落库，到期日=今天，便于断言本次排期） */
function addItem(problemId: number, stage = 0, nextDueOn = localToday()): number {
  return db
    .prepare('INSERT INTO review_items (user_id, problem_id, stage, next_due_on) VALUES (1, ?, ?, ?)')
    .run(problemId, stage, nextDueOn).lastInsertRowid as number;
}

function logEvent(itemId: number, problemId: number, feedback: string, stage: number, at: string): void {
  db.prepare(
    `INSERT INTO review_events
       (user_id, review_item_id, problem_id, reviewed_at, feedback, stage_before, stage_after, due_on, interval_days, factor)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(itemId, problemId, at, feedback, Math.max(0, stage - 1), stage, at, 7);
}

/** 给题目打知识点标注，并按该知识点造出指定规模的练习记录 */
function annotate(platform: string, problemKey: string, code: string): void {
  db.prepare(
    `INSERT INTO problem_keypoints
       (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_at)
     VALUES (?, ?, ?, ?, 0.9, 'rule', 'rule#test', 1, 1, '2026-09-01T00:00:00.000Z')`,
  ).run(platform, problemKey, code, code);
}

function seedConcept(code: string, problemId: number, opts: { solved: number; attempts: number; ac: number }): void {
  const problem = db.prepare('SELECT platform, problem_key FROM problems WHERE id = ?').get(problemId) as {
    platform: string;
    problem_key: string;
  };
  annotate(problem.platform, problem.problem_key, code);
  for (let i = 0; i < opts.attempts; i++) {
    const pid = addProblem(`${code}-s${i}`);
    annotate('codeforces', `${code}-s${i}`, code);
    db.prepare(
      "INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id) VALUES (1, 'codeforces', 'u', ?, ?, ?, ?)",
    ).run(pid, i < opts.ac ? 'AC' : 'WA', '2026-09-10T10:00:00.000Z', `${code}-${i}`);
  }
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as never };
}

// ---------- 纯函数 ----------

test('retentionFactor：无信号就是 1，与阶梯原样一致', () => {
  assert.equal(retentionFactor(NEUTRAL), 1);
});

test('retentionFactor：失手与卡点收紧、稳定与熟练放宽', () => {
  assert.ok(retentionFactor({ ...NEUTRAL, lapses: 1 }) < 1, '忘记过一次要排得更近');
  assert.ok(
    retentionFactor({ ...NEUTRAL, lapses: 2 }) < retentionFactor({ ...NEUTRAL, lapses: 1 }),
    '忘记两次比一次更近',
  );
  assert.ok(retentionFactor({ ...NEUTRAL, stuckByIntent: true }) < 1, '靠题解做出来的题留存差');
  assert.ok(retentionFactor({ ...NEUTRAL, weakConcept: true }) < 1, '知识点本身没掌握要更常回炉');
  assert.ok(
    retentionFactor({ ...NEUTRAL, reviews: 4, solidConcept: true }) > 1,
    '连续稳定且知识点已熟练可以拉长间隔',
  );
});

test('retentionFactor：多个负面信号叠到下限即止，不把题排成今天', () => {
  const worst = retentionFactor({ reviews: 9, lapses: 9, weakConcept: true, solidConcept: false, stuckByIntent: true });
  assert.ok(worst >= FACTOR_FLOOR && worst <= FACTOR_CEIL);
  assert.equal(retentionFactor({ reviews: 99, lapses: 99, weakConcept: true, solidConcept: false, stuckByIntent: true }), FACTOR_FLOOR);
  assert.ok(intervalDaysWithFactor(60, FACTOR_FLOOR) >= 1, '夹到最小 1 天，绝不排出今天重复');
});

// ---------- 路由接线 ----------

test('反馈落一行 review_events：档位变化 / 原定到期日 / 生效系数都可审计', async () => {
  const pid = addProblem();
  const itemId = addItem(pid, 2, localToday());
  const { body } = await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  const res = body as { stage: number; nextDueOn: string; factor: number };
  assert.equal(res.stage, 3);

  const ev = db
    .prepare('SELECT * FROM review_events WHERE review_item_id = ?')
    .get(itemId) as Record<string, unknown>;
  assert.ok(ev, '必须留痕');
  assert.equal(ev.problem_id, pid);
  assert.equal(ev.feedback, 'ok');
  assert.equal(ev.stage_before, 2);
  assert.equal(ev.stage_after, 3);
  assert.equal(ev.due_on, localToday(), '记下复习时原本的到期日，才能算逾期强度');
  assert.equal(Number(ev.interval_days), 14);
  assert.equal(ev.factor, 1);
  assert.equal(res.nextDueOn, dateAfterDays(localToday(), 14), '无信号时排期 = 基线档位间隔');
});

test('逾期复习会记在日志里（due_on 早于复习当天）', async () => {
  const pid = addProblem();
  const itemId = addItem(pid, 3, '2026-09-01');
  await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  const ev = db.prepare('SELECT due_on, reviewed_at FROM review_events WHERE review_item_id = ?').get(itemId) as {
    due_on: string;
    reviewed_at: string;
  };
  assert.equal(ev.due_on, '2026-09-01');
  assert.ok(ev.reviewed_at.slice(0, 10) > ev.due_on, '复习时刻晚于原定到期日 = 逾期');
});

test('历史失手次数让本次排期短于阶梯基线', async () => {
  const pid = addProblem();
  const itemId = addItem(pid, 1, localToday());
  // 基线：stage1 + ok → stage2 = 7 天
  logEvent(itemId, pid, 'hard', 0, '2026-09-05T10:00:00.000Z');
  logEvent(itemId, pid, 'hard', 0, '2026-09-06T10:00:00.000Z');
  const { body } = await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  const res = body as { nextDueOn: string; factor: number; intervalDays: number };
  assert.ok(res.factor < 1, '两次失手要收紧');
  assert.ok(res.intervalDays < 7, `实际间隔应短于基线 7 天，实得 ${res.intervalDays}`);
});

test('连续稳定 + 知识点熟练把间隔拉长', async () => {
  const pid = addProblem('2001-A');
  seedConcept('dp.general', pid, { solved: 24, attempts: 30, ac: 24 }); // 掌握度=熟练
  const itemId = addItem(pid, 2, localToday());
  for (let i = 0; i < 4; i++) logEvent(itemId, pid, 'ok', Math.min(5, i + 1), `2026-0${5 + i}-10T10:00:00.000Z`);
  const { body } = await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  const res = body as { factor: number; intervalDays: number };
  assert.ok(res.factor > 1, `应放宽，实得 ${res.factor}`);
  assert.ok(res.intervalDays > 14, `基线 14 天应被拉长，实得 ${res.intervalDays}`);
});

test('知识点薄弱把间隔收紧（同一档位不同题不再同一条排期）', async () => {
  const pid = addProblem('2001-A');
  seedConcept('dp.general', pid, { solved: 1, attempts: 4, ac: 1 }); // 接触档
  const itemId = addItem(pid, 2, localToday());
  const { body } = await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  const res = body as { factor: number; intervalDays: number };
  assert.ok(res.factor < 1, `知识点没掌握要收紧，实得 ${res.factor}`);
  assert.ok(res.intervalDays < 14);
});

test('该题记过「看题解才做出」就收紧', async () => {
  const pid = addProblem();
  const itemId = addItem(pid, 2, localToday());
  db.prepare("INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (1, ?, 'dp.general', 'editorial')").run(pid);
  const { body } = await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  assert.ok((body as { factor: number }).factor < 1);
});

test('列表带出每题的复习次数与失手次数', async () => {
  const pid = addProblem();
  const itemId = addItem(pid, 1, localToday());
  logEvent(itemId, pid, 'hard', 0, '2026-09-05T10:00:00.000Z');
  logEvent(itemId, pid, 'ok', 1, '2026-09-08T10:00:00.000Z');
  const { body } = await api('GET', '/api/reviews');
  const items = body as Array<{ id: number; reviewCount: number; lapseCount: number }>;
  const found = items.find((i) => i.id === itemId);
  assert.equal(found?.reviewCount, 2);
  assert.equal(found?.lapseCount, 1);
});

test('移出队列时一并清掉它的复习日志（外键开着，留孤儿会让删除直接失败）', async () => {
  const pid = addProblem();
  const itemId = addItem(pid, 1, localToday());
  await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'ok' });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM review_events WHERE review_item_id = ?').get(itemId) as { c: number }).c, 1);
  const del = await api('DELETE', `/api/reviews/${itemId}`);
  assert.equal(del.status, 200);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM review_events').get() as { c: number }).c, 0);
});

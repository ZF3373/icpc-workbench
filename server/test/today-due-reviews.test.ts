/**
 * 今日训练要带出「具体是哪几道复习题」，而不是只给一个计数。
 *
 * 三档题单刻意排除复习队列中的题（SUPPRESSION_TIERS 的 excludeReview），
 * 所以复习题不会出现在 bands 里；若接口只回 dueReviews 计数，
 * 用户看到「有 3 道该复习」却不知道是哪几道，还得自己跑去复习库翻。
 */
import { test, beforeEach, afterEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { todayRoutes } from '../src/routes/today.ts';
import { dateAfterDays } from '../src/reviews/schedule.ts';
import { listenForTest } from './test-listen.ts';
import type { TodayPlan } from '../../shared/src/index.ts';

let db: Db;
let server: Server;
let base: string;

beforeEach(async () => {
  db = createDb(':memory:');
  const app = express();
  app.use('/api/today', todayRoutes(db));
  server = await listenForTest(app);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
  db.close();
});

function addProblem(key: string, difficulty = 1300): number {
  return db
    .prepare(
      "INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES ('codeforces', ?, ?, ?, NULL, '[]')",
    )
    .run(key, `题 ${key}`, difficulty).lastInsertRowid as number;
}

function addItem(problemId: number, nextDueOn: string, stage = 0): void {
  db.prepare('INSERT INTO review_items (user_id, problem_id, stage, next_due_on) VALUES (?, ?, ?, ?)').run(
    DEFAULT_USER_ID,
    problemId,
    stage,
    nextDueOn,
  );
}

async function getPlan(): Promise<TodayPlan> {
  const res = await fetch(`${base}/api/today`);
  assert.equal(res.status, 200);
  return (await res.json()) as TodayPlan;
}

test('GET /api/today：带出到期复习的具体条目（含逾期），计数与列表一致', async () => {
  const today = (await getPlan()).date;
  const overdueId = addProblem('OVERDUE');
  const todayId = addProblem('TODAY');
  const futureId = addProblem('FUTURE');
  addItem(overdueId, dateAfterDays(today, -2));
  addItem(todayId, today);
  addItem(futureId, dateAfterDays(today, 4));

  const plan = await getPlan();
  assert.equal(plan.dueReviews, 2, '逾期 + 今日到期');
  assert.deepEqual(
    plan.dueReviewItems.map((i) => i.problemKey),
    ['OVERDUE', 'TODAY'],
    '未来的不掺进来',
  );
  assert.equal(plan.dueReviewItems.length, plan.dueReviews, '计数必须等于列表长度');
});

test('GET /api/today：复习条目带齐界面需要的字段（题号/链接/档位/间隔/复习次数）', async () => {
  const today = (await getPlan()).date;
  const id = addProblem('A', 1600);
  db.prepare("UPDATE problems SET url = 'https://codeforces.com/contest/A' WHERE id = ?").run(id);
  addItem(id, today, 3);

  const plan = await getPlan();
  const item = plan.dueReviewItems[0]!;
  assert.equal(item.problemKey, 'A');
  assert.equal(item.url, 'https://codeforces.com/contest/A');
  assert.equal(item.difficulty, 1600);
  assert.equal(item.stage, 3);
  assert.equal(item.intervalDays, 14, '第 4 档 = 14 天');
  assert.equal(item.reviewCount, 0);
  assert.equal(item.lapseCount, 0);
});

test('GET /api/today：无到期复习时 dueReviews=0 且列表为空', async () => {
  addProblem('A');
  const plan = await getPlan();
  assert.equal(plan.dueReviews, 0);
  assert.deepEqual(plan.dueReviewItems, []);
});

test('GET /api/today：复习题不出现在三档题单里（既有排除策略不变）', async () => {
  const today = (await getPlan()).date;
  // 池子要够大：候选不足时放宽阶梯会故意放开复习排除（见 today/select.ts 的 SUPPRESSION_TIERS），
  // 那样复习题本来就会进题单——这里要验证的是「严格档下不重复推荐」这条既有策略
  for (let i = 0; i < 8; i += 1) addProblem(`POOL${i}`, 1300);
  const queuedId = addProblem('QUEUED', 1300);
  addItem(queuedId, dateAfterDays(today, 30)); // 远未到期：只验证它不被当新推荐

  const plan = await getPlan();
  const bandIds = plan.bands.flatMap((b) => b.problems.map((p) => p.id));
  assert.ok(bandIds.length > 0, '池子够大时应能出题');
  assert.ok(!bandIds.includes(queuedId), '复习队列中的题仍不进三档题单');
  // 严格档出题（未被放宽），说明排除确实是策略生效而非凑巧没选中
  assert.ok(
    plan.bands.every((b) => b.relaxed === null),
    `不应放宽: ${JSON.stringify(plan.bands.map((b) => b.relaxed))}`,
  );
});

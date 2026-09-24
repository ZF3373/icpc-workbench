import { test, beforeEach, afterEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { todayRoutes } from '../src/routes/today.ts';
import type { TodayPlan } from '../../shared/src/index.ts';

/**
 * 今日训练的跨天去重（issue：推荐的题每天一模一样）。
 * 排序是完全确定性的，所以「明天换一批题」只能靠 today_recommendations 冷却记录实现。
 */

let db: Db;
let server: Server;
let base: string;

beforeEach(async () => {
  db = createDb(':memory:');
  const app = express();
  app.use('/api/today', todayRoutes(db));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

/** 无 AC 记录时能力值回退 1200 → 巩固 1000-1199 / 同段 1200-1400 / 挑战 1401-1600 */
function addProblems(platform: string, difficulties: number[]): void {
  const ins = db.prepare(
    'INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES (?, ?, ?, ?, NULL, ?)',
  );
  difficulties.forEach((d, i) => ins.run(platform, `${platform[0]}${i}_${d}`, `T${i}`, d, '[]'));
}

async function getPlan(query = ''): Promise<TodayPlan> {
  const res = await fetch(`${base}/api/today${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as TodayPlan;
}

const allIds = (plan: TodayPlan) => plan.bands.flatMap((b) => b.problems.map((p) => p.id));

test('GET /api/today: 返回的题写入冷却记录，标注为今天', async () => {
  addProblems('codeforces', [1300, 1310, 1320, 1330, 1340, 1350]);
  const plan = await getPlan();
  assert.equal(plan.cooldownDays, 14);
  assert.equal(allIds(plan).length, 3); // 只有同段区有题，巩固/挑战档为空
  const rows = db
    .prepare('SELECT problem_id, recommended_on, band FROM today_recommendations ORDER BY problem_id')
    .all() as Array<{ problem_id: number; recommended_on: string; band: string }>;
  assert.deepEqual(
    rows.map((r) => r.problem_id),
    allIds(plan).sort((a, b) => a - b),
  );
  assert.ok(rows.every((r) => r.recommended_on === plan.date));
  assert.ok(rows.every((r) => r.band === 'core'));
});

test('GET /api/today: 往日推荐过的题不再出现（跨天不重复）', async () => {
  addProblems('codeforces', [1300, 1310, 1320, 1330, 1340, 1350, 1360, 1370, 1380]);
  const first = await getPlan();
  const shown = new Set(allIds(first));
  assert.equal(shown.size, 3);

  // 模拟「第二天再来」：把推荐日期改成昨天，等价于用户隔天重新打开页面
  db.prepare("UPDATE today_recommendations SET recommended_on = date(recommended_on, '-1 day')").run();
  const next = await getPlan();
  const repeated = allIds(next).filter((id) => shown.has(id));
  assert.deepEqual(repeated, []);
});

test('GET /api/today: 当天重复请求不消耗冷却队列，rotate 给出整批新题', async () => {
  addProblems('codeforces', [1300, 1310, 1320, 1330, 1340, 1350]);
  const first = await getPlan();
  // 同一批再请求一次必须完全一致（同日多次请求结果稳定的原有约定）
  assert.deepEqual(allIds(await getPlan()), allIds(first));
  // rotate=1 平移一整批：与上一批零重叠，而不是只换掉 1 题
  const rotated = await getPlan('?rotate=1');
  const overlap = allIds(rotated).filter((id) => allIds(first).includes(id));
  assert.deepEqual(overlap, []);
});

test('GET /api/today: 复习队列中的题不再作为新推荐出现', async () => {
  addProblems('codeforces', [1300, 1310, 1320, 1330]);
  const before = await getPlan();
  const queuedId = allIds(before)[0];
  db.prepare(
    'INSERT INTO review_items (user_id, problem_id, stage, next_due_on) VALUES (?, ?, 0, ?)',
  ).run(DEFAULT_USER_ID, queuedId, before.date);

  const after = await getPlan();
  assert.ok(!allIds(after).includes(queuedId));
  // 移出复习队列后自动回到候选池（排除是查询时算的，无需清理记录）
  db.prepare('DELETE FROM review_items WHERE problem_id = ?').run(queuedId);
  assert.ok(allIds(await getPlan()).includes(queuedId));
});

test('GET /api/today: 冷却把该档排空时逐级放宽，而不是留一个空档', async () => {
  addProblems('codeforces', [1300]);
  const first = await getPlan();
  assert.equal(allIds(first).length, 1);

  db.prepare("UPDATE today_recommendations SET recommended_on = date(recommended_on, '-1 day')").run();
  const second = await getPlan();
  // 只有 1 题且昨天刚推荐过 → 14/7/3 天窗口都会排空，必须放宽后仍出题
  assert.deepEqual(allIds(second), allIds(first));
  assert.match(second.bands.find((b) => b.key === 'core')!.relaxed ?? '', /放宽|重复|凑齐/);
});

test('GET /api/today: 挑战区池子够时严格档出题，不带放宽说明', async () => {
  addProblems('codeforces', [1500, 1510, 1520, 1530]);
  const plan = await getPlan();
  const challenge = plan.bands.find((b) => b.key === 'challenge')!;
  assert.equal(challenge.problems.length, 1);
  assert.equal(challenge.relaxed, null);
});

test('GET /api/today: 已 AC 的题不进入候选，也不受冷却影响', async () => {
  addProblems('codeforces', [1300, 1310]);
  const plan = await getPlan();
  const [id] = allIds(plan);
  db.prepare(
    `INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id)
     VALUES (?, 'codeforces', ?, 'AC', datetime('now'), ?)`,
  ).run(DEFAULT_USER_ID, id, `ac-${id}`);
  assert.ok(!allIds(await getPlan()).includes(id));
});

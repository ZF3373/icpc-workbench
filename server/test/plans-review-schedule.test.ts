/**
 * AI 训练计划要按复习库的**具体到期日与题目**排 review 任务，而不是只看到一个计数。
 *
 * 两条路径都必须做到（同一份数据包，行为不该有差别）：
 * - AI 路径：提示词里逐条给出题号与 nextDueOn，并写明硬约束
 * - 无 AI 降级路径：templatePlan 自己按真实到期日排具体复习题
 *
 * 逾期项排计划首日（已经欠着了，越早补越好）；期外条目不排（不为凑数提前）。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { dateAfterDays } from '../src/reviews/schedule.ts';
import { buildPlanPackage, templatePlan, today } from '../src/plans/planService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(key: string, verdict: 'AC' | 'WA', tags: string[], difficulty: number, url?: string): NormalizedSubmission {
  return {
    problem: { platform: 'codeforces', problemKey: key, title: `T ${key}`, difficulty, tags, ...(url ? { url } : {}) },
    verdict,
    submittedAt: '2026-07-28T10:00:00.000Z',
    externalId: `${key}-${verdict}`,
  };
}

/** 造一道已 AC 的题（复习库里的题都是做过的）+ 一条复习条目 */
function addReviewItem(key: string, nextDueOn: string, difficulty = 1500, stage = 0): number {
  insertNormalized(db, DEFAULT_USER_ID, [
    sub(key, 'AC', ['dp'], difficulty, `https://codeforces.com/contest/${key}`),
  ]);
  const problemId = (db.prepare('SELECT id FROM problems WHERE problem_key = ?').get(key) as { id: number }).id;
  db.prepare('INSERT INTO review_items (user_id, problem_id, stage, next_due_on) VALUES (?, ?, ?, ?)').run(
    DEFAULT_USER_ID,
    problemId,
    stage,
    nextDueOn,
  );
  return problemId;
}

const PROFILE = {
  items: [{ tag: '动态规划', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, rank: 40, solved: 1 }],
  byDifficulty: [],
  generatedAt: '',
};

test('buildPlanPackage：复习排期逐条进入提示词（含题号、到期日、链接）', () => {
  // 提示词里的排期视野从「今天」起算（AI 需要知道此刻欠着什么），
  // 所以这里必须用相对今天的日期，写死日期会随真实日期流逝而变成「已逾期」
  const start = today();
  addReviewItem('R1', dateAfterDays(start, 2));
  addReviewItem('R2', dateAfterDays(start, 5));

  const pkg = buildPlanPackage(db, DEFAULT_USER_ID, { days: 14, startDate: start });
  assert.match(pkg.prompt, /复习排期/, '提示词应有复习排期段');
  assert.match(pkg.prompt, new RegExp(`${dateAfterDays(start, 2)} .*codeforces/R1`), 'R1 的到期日与题号应成对出现');
  assert.match(pkg.prompt, new RegExp(`${dateAfterDays(start, 5)} .*codeforces/R2`));
  assert.match(pkg.prompt, /codeforces\/R1《T R1》/);
  // 硬约束：必须落到具体日期与题目，而不是写抽象任务
  assert.match(pkg.prompt, /复习库排期必须落到具体日期与题目/);
});

test('buildPlanPackage：逾期项在提示词里被标注出来（AI 才能排到首日）', () => {
  const start = today();
  addReviewItem('LATE', dateAfterDays(start, -3));
  const pkg = buildPlanPackage(db, DEFAULT_USER_ID, { days: 7, startDate: start });
  assert.match(pkg.prompt, /已逾期/);
  assert.match(pkg.prompt, /LATE/);
});

test('buildPlanPackage：摘要结构里带出 upcoming 与窗口总量', () => {
  const start = today();
  addReviewItem('R1', dateAfterDays(start, 2));
  addReviewItem('R2', dateAfterDays(start, 3));
  const pkg = buildPlanPackage(db, DEFAULT_USER_ID, { days: 7, startDate: start });
  assert.equal(pkg.summary.reviewQueue.upcoming.length, 2);
  assert.equal(pkg.summary.reviewQueue.upcomingTotal, 2);
  assert.equal(pkg.summary.reviewQueue.windowDays, 30);
  assert.equal(pkg.summary.reviewQueue.upcoming[0]!.problemKey, 'R1');
  assert.equal(pkg.summary.reviewQueue.upcoming[0]!.nextDueOn, dateAfterDays(start, 2));
});

test('templatePlan：按真实到期日排具体复习题，逾期排首日', () => {
  const start = '2026-08-10';
  addReviewItem('R1', '2026-08-12');
  addReviewItem('LATE', '2026-08-01'); // 早于计划首日 → 逾期

  const p = templatePlan(db, PROFILE as never, start, 7);
  const reviews = p.tasks.filter((t) => t.kind === 'review');
  const r1 = reviews.find((t) => t.problemKey === 'R1');
  const late = reviews.find((t) => t.problemKey === 'LATE');
  assert.ok(r1, `应有 R1 的复习任务: ${JSON.stringify(reviews.map((t) => t.problemKey))}`);
  assert.equal(r1.date, '2026-08-12', '期内条目排在自己的到期日');
  assert.equal(r1.url, 'https://codeforces.com/contest/R1', '带可点击链接');
  assert.ok(late, '逾期条目也要排进来');
  assert.equal(late.date, start, '逾期项排计划首日');
  assert.match(late.note ?? '', /逾期/, '说明里写明原定到期日');
});

test('templatePlan：到期日在计划期外的条目不排（不为凑数提前）', () => {
  const start = '2026-08-10';
  addReviewItem('SOON', '2026-08-12');
  addReviewItem('FAR', '2026-09-20'); // 7 天计划（至 08-16）之外

  const p = templatePlan(db, PROFILE as never, start, 7);
  const keys = p.tasks.filter((t) => t.kind === 'review').map((t) => t.problemKey);
  assert.ok(keys.includes('SOON'));
  assert.ok(!keys.includes('FAR'), `期外条目不应出现: ${JSON.stringify(keys)}`);
});

test('templatePlan：复习题与练习任务重名时不撞 UNIQUE（补题号后缀）', () => {
  const start = '2026-08-10';
  // 练习池会选中未 AC 的题；这里让一道已 AC 题与复习条目同名，模拟同名冲突
  insertNormalized(db, DEFAULT_USER_ID, [sub('DUP', 'WA', ['dp'], 1500, 'https://codeforces.com/contest/DUP')]);
  const dupProblemId = (db.prepare("SELECT id FROM problems WHERE problem_key = 'DUP'").get() as { id: number }).id;
  // 同题号不可能同时在 problems 里有两行（UNIQUE platform+key），改用不同题号但同名标题：
  // 直接改标题制造重名
  db.prepare("UPDATE problems SET title = '同名题' WHERE id = ?").run(dupProblemId);
  db.prepare('INSERT INTO review_items (user_id, problem_id, stage, next_due_on) VALUES (?, ?, 0, ?)').run(
    DEFAULT_USER_ID,
    dupProblemId,
    '2026-08-12',
  );
  // 另造一道未 AC、同名的题进练习池
  insertNormalized(db, DEFAULT_USER_ID, [sub('OTHER', 'WA', ['dp'], 1500, 'https://codeforces.com/contest/OTHER')]);
  db.prepare("UPDATE problems SET title = '同名题' WHERE problem_key = 'OTHER'").run();

  const p = templatePlan(db, PROFILE as never, start, 7);
  const sameDay = p.tasks.filter((t) => t.date === '2026-08-12');
  const titles = sameDay.map((t) => t.title);
  assert.equal(new Set(titles).size, titles.length, `同一天不应有重名任务: ${JSON.stringify(titles)}`);
  // 复习条目仍在（重名时补题号后缀，而不是被丢掉）
  assert.ok(
    p.tasks.some((t) => t.kind === 'review' && t.problemKey === 'DUP'),
    '复习任务不应因重名被丢弃',
  );
});

test('templatePlan：复习任务带上档位/间隔说明与失手次数', () => {
  const start = '2026-08-10';
  addReviewItem('R1', '2026-08-12', 1500, 3);
  const p = templatePlan(db, PROFILE as never, start, 7);
  const r1 = p.tasks.find((t) => t.problemKey === 'R1')!;
  assert.match(r1.note ?? '', /第 4 档/, '档位 = stage+1');
  assert.match(r1.note ?? '', /间隔 14 天/, '第 4 档对应 14 天');
});

test('templatePlan：复习库为空时行为不变（不生成复习题任务，节奏性回顾仍在）', () => {
  const start = '2026-08-10';
  insertNormalized(db, DEFAULT_USER_ID, [sub('A', 'WA', ['dp'], 1500, 'https://codeforces.com/contest/A')]);
  const p = templatePlan(db, PROFILE as never, start, 7);
  // 复习库为空 → 没有带题号的复习任务，但既有的「回顾与错题重做」节奏仍在
  const reviews = p.tasks.filter((t) => t.kind === 'review');
  assert.ok(reviews.length > 0, '节奏性回顾任务保留');
  assert.ok(reviews.every((t) => !t.problemKey), '复习库为空时不应有具体题目的复习任务');
});

test('templatePlan：复习任务数量受上限约束（复习库几百条时不砸穿日历）', () => {
  const start = '2026-08-10';
  // 造 70 条全部在计划期内到期
  for (let i = 0; i < 70; i += 1) {
    addReviewItem(`BULK${i}`, `2026-08-${String(10 + (i % 7)).padStart(2, '0')}`);
  }
  const p = templatePlan(db, PROFILE as never, start, 7);
  const reviewWithKey = p.tasks.filter((t) => t.kind === 'review' && t.problemKey);
  assert.ok(reviewWithKey.length <= 60, `复习任务应受 60 条上限约束，实际 ${reviewWithKey.length}`);
});

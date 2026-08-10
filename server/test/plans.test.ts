import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { AiProvider } from '../src/ai/provider.ts';
import {
  buildPlanPackage,
  generatePlan,
  parsePlanJson,
  recommendProblems,
  renderTemplate,
  savePlan,
  templatePlan,
  today,
  type PlanInput,
} from '../src/plans/planService.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

const AI_DISABLED = { enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' };

function sub(platform: 'codeforces', key: string, verdict: 'AC' | 'WA', tags: string[], difficulty: number, submittedAt: string): NormalizedSubmission {
  return {
    problem: { platform, problemKey: key, title: `T ${key}`, difficulty, tags },
    verdict,
    submittedAt,
    externalId: `${key}-${verdict}-${submittedAt}`,
  };
}

function seed(): void {
  insertNormalized(db, 1, [
    sub('codeforces', 'A', 'WA', ['dp', 'greedy'], 1500, '2026-07-28T10:00:00.000Z'),
    sub('codeforces', 'A', 'AC', ['dp', 'greedy'], 1500, '2026-07-28T11:00:00.000Z'),
    sub('codeforces', 'B', 'AC', ['dp', 'graphs'], 1800, '2026-07-28T12:00:00.000Z'),
    sub('codeforces', 'C', 'AC', ['greedy'], 1200, '2026-07-28T13:00:00.000Z'),
  ]);
}

test('savePlan persists plan with tasks and problem link', () => {
  seed();
  const planId = savePlan(db, 1, {
    title: '测试计划',
    goal: '目标',
    startDate: '2026-08-10',
    days: 3,
    tasks: [
      { date: '2026-08-10', title: '练习 dp', kind: 'practice', platform: 'codeforces', problemKey: 'A', url: 'https://codeforces.com/contest/A' },
      { date: '2026-08-12', title: '回顾', kind: 'review' },
    ],
  }, 'manual');
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as { title: string; end_date: string; source: string };
  assert.equal(plan.title, '测试计划');
  assert.equal(plan.end_date, '2026-08-12');
  assert.equal(plan.source, 'manual');
  const task = db.prepare('SELECT problem_id, url FROM plan_tasks WHERE plan_id = ? AND task_date = ?').get(planId, '2026-08-10') as { problem_id: number; url: string };
  assert.ok(task.problem_id > 0); // 关联到 problems.A
  assert.equal(task.url, 'https://codeforces.com/contest/A');
});

test('savePlan validates inputs', () => {
  assert.throws(
    () => savePlan(db, 1, { title: '', goal: '', startDate: '2026-08-10', days: 3, tasks: [{ date: '2026-08-10', title: 'x' }] }, 'manual'),
    /标题/,
  );
  assert.throws(
    () => savePlan(db, 1, { title: 'p', goal: '', startDate: '2026-08-10', days: 3, tasks: [] }, 'manual'),
    /任务/,
  );
  assert.throws(
    () => savePlan(db, 1, { title: 'p', goal: '', startDate: 'bad', days: 3, tasks: [{ date: '2026-08-10', title: 'x' }] }, 'manual'),
    /startDate/,
  );
});

test('parsePlanJson tolerates markdown fences and validates shape', () => {
  const raw = '```json\n{"title":"P","goal":"G","tasks":[{"date":"2026-08-10","title":"t","kind":"practice"}]}\n```';
  const p = parsePlanJson(raw, '2026-08-10', 1);
  assert.equal(p.title, 'P');
  assert.equal(p.tasks.length, 1);
  assert.throws(() => parsePlanJson('{"tasks":[]}', '2026-08-10', 1), /title/);
  assert.throws(() => parsePlanJson('not json', '2026-08-10', 1), /JSON/);
});

test('templatePlan covers each day with periodic review/contest', () => {
  const p = templatePlan({ items: [{ tag: 'dp', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, solved: 1 }], byDifficulty: [], generatedAt: '' }, '2026-08-10', 14);
  assert.equal(p.days, 14);
  assert.equal(p.tasks.length >= 14, true);
  assert.ok(p.tasks.some((t) => t.kind === 'review'));
  assert.ok(p.tasks.some((t) => t.kind === 'contest'));
  assert.match(p.tasks[0].title, /dp/);
});

test('generatePlan falls back to template when AI disabled', async () => {
  seed();
  const result = await generatePlan(db, AI_DISABLED, { days: 7, startDate: '2026-08-10' });
  assert.equal(result.source, 'template');
  const plan = db.prepare('SELECT source FROM plans WHERE id = ?').get(result.planId) as { source: string };
  assert.equal(plan.source, 'template');
});

test('generatePlan uses AI when enabled and saves raw prompt', async () => {
  seed();
  const aiBody = {
    title: 'AI 训练计划',
    goal: '突破 dp',
    tasks: [
      { date: '2026-08-10', title: 'dp 专题', kind: 'topic', platform: 'codeforces', problemKey: 'B', note: '状态转移' },
      { date: '2026-08-11', title: '回顾', kind: 'review' },
    ],
  };
  const fetchFn = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiBody) } }] }), { status: 200 });
  const provider = new AiProvider({ enabled: true, baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' }, fetchFn);
  const result = await generatePlan(db, AI_DISABLED, { days: 2, startDate: '2026-08-10', provider });
  assert.equal(result.source, 'ai');
  const plan = db.prepare('SELECT raw_prompt, title FROM plans WHERE id = ?').get(result.planId) as { raw_prompt: string; title: string };
  assert.equal(plan.title, 'AI 训练计划');
  assert.ok(plan.raw_prompt.includes('2026-08-10')); // 渲染后的完整提示词已保存
});

test('generatePlan falls back to template when AI call fails', async () => {
  seed();
  const fetchFn = async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
  const provider = new AiProvider({ enabled: true, baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' }, fetchFn);
  const result = await generatePlan(db, AI_DISABLED, { days: 3, startDate: '2026-08-10', provider });
  assert.equal(result.source, 'template');
});

test('recommendProblems prioritizes weak-tag problems', () => {
  seed();
  const pkg = buildPlanPackage(db, 1, { days: 7, startDate: today() });
  // 弱项应为 greedy（1/2 AC 率低）或 dp
  const recs = recommendProblems(db, pkg.profile, 10);
  assert.ok(recs.length >= 1);
  const firstTags = new Set(recs[0].tags);
  assert.ok(firstTags.has('greedy') || firstTags.has('dp'), `首个推荐应含弱项 tag: ${JSON.stringify(recs[0].tags)}`);
});

test('buildPlanPackage prompt has placeholders rendered', () => {
  seed();
  const pkg = buildPlanPackage(db, 1, { days: 7, startDate: '2026-08-10' });
  assert.ok(pkg.prompt.includes('2026-08-10'));
  assert.ok(pkg.prompt.includes('共 7 天'));
  assert.ok(!pkg.prompt.includes('{weakness}'), '占位符应被替换');
  assert.equal(pkg.meta.days, 7);
  assert.ok(pkg.problems.length > 0);
});

test('renderTemplate replaces known vars and keeps unknown', () => {
  assert.equal(renderTemplate('a={x} b={y}', { x: '1' }), 'a=1 b={y}');
});

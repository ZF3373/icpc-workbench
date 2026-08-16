import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { AiProvider } from '../src/ai/provider.ts';
import { initAdapters } from '../src/adapters/index.ts';
import {
  buildPlanPackage,
  computeUserLevel,
  generatePlan,
  parsePlanJson,
  recommendProblems,
  recommendProblemsByWeakTag,
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

function sub(platform: 'codeforces', key: string, verdict: 'AC' | 'WA', tags: string[], difficulty: number, submittedAt: string, url?: string): NormalizedSubmission {
  return {
    problem: { platform, problemKey: key, title: `T ${key}`, difficulty, tags, ...(url ? { url } : {}) },
    verdict,
    submittedAt,
    externalId: `${key}-${verdict}-${submittedAt}`,
  };
}

function seed(): void {
  insertNormalized(db, 1, [
    sub('codeforces', 'A', 'WA', ['dp', 'greedy'], 1500, '2026-07-28T10:00:00.000Z', 'https://codeforces.com/contest/A'),
    sub('codeforces', 'A', 'AC', ['dp', 'greedy'], 1500, '2026-07-28T11:00:00.000Z', 'https://codeforces.com/contest/A'),
    sub('codeforces', 'B', 'AC', ['dp', 'graphs'], 1800, '2026-07-28T12:00:00.000Z', 'https://codeforces.com/contest/B'),
    sub('codeforces', 'C', 'AC', ['greedy'], 1200, '2026-07-28T13:00:00.000Z', 'https://codeforces.com/contest/C'),
    // D 只有 WA（未 AC）→ 模板选题候选
    sub('codeforces', 'D', 'WA', ['dp'], 1600, '2026-07-28T14:00:00.000Z', 'https://codeforces.com/contest/D'),
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

test('parsePlanJson tolerates prose around JSON', () => {
  const raw =
    '好的，以下是计划：\n{"title":"P","goal":"G","tasks":[{"date":"2026-08-10","title":"t","kind":"practice"}]}\n希望对你有帮助！';
  const p = parsePlanJson(raw, '2026-08-10', 1);
  assert.equal(p.title, 'P');
  assert.equal(p.tasks.length, 1);
});

test('parsePlanJson tolerates trailing commas inside fences', () => {
  const raw = '```json\n{"title":"P","tasks":[{"date":"2026-08-10","title":"t","kind":"practice",},],}\n```';
  const p = parsePlanJson(raw, '2026-08-10', 1);
  assert.equal(p.tasks.length, 1);
});

test('parsePlanJson sanitizes malformed task entries', () => {
  const raw = JSON.stringify({
    title: 'P',
    tasks: [
      { date: '2026-08-10', title: 'ok', kind: 'review' },
      { date: '2026-08-11', title: 'bad kind', kind: '不知名类型' },
      'not an object',
      { date: '2026-08-12' },
      null,
    ],
  });
  const p = parsePlanJson(raw, '2026-08-10', 3);
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks[0].kind, 'review');
  assert.equal(p.tasks[1].kind, 'practice'); // 未知 kind 回退
  assert.throws(
    () => parsePlanJson('{"title":"P","tasks":["x", 1]}', '2026-08-10', 1),
    /有效任务/,
  );
});

test('parsePlanJson drops tasks outside the plan window', () => {
  const raw = JSON.stringify({
    title: 'P',
    tasks: [
      { date: '2026-08-10', title: 'in' },        // 期内首日
      { date: '2026-08-12', title: 'last' },      // 期内末日（3 天计划：10/11/12）
      { date: '2026-08-13', title: 'after' },     // 期外 → 丢弃
      { date: '2026-08-09', title: 'before' },    // 期外 → 丢弃
      { date: 'not-a-date', title: 'bad' },       // 非法日期 → 丢弃
    ],
  });
  const p = parsePlanJson(raw, '2026-08-10', 3);
  assert.equal(p.tasks.length, 2);
  assert.deepEqual(p.tasks.map((t) => t.title), ['in', 'last']);
});

test('templatePlan covers each day with periodic review/contest', () => {
  const p = templatePlan(db, { items: [{ tag: 'dp', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, solved: 1 }], byDifficulty: [], generatedAt: '' }, '2026-08-10', 14);
  assert.equal(p.days, 14);
  assert.equal(p.tasks.length >= 14, true);
  assert.ok(p.tasks.some((t) => t.kind === 'review'));
  assert.ok(p.tasks.some((t) => t.kind === 'contest'));
  assert.match(p.tasks[0].title, /dp/);
});

test('templatePlan picks concrete problems with clickable links', () => {
  seed();
  const p = templatePlan(db, { items: [{ tag: 'dp', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, solved: 1 }], byDifficulty: [], generatedAt: '' }, '2026-08-10', 7);
  const practice = p.tasks.filter((t) => t.kind === 'practice');
  assert.ok(practice.length > 0);
  // 每日练习任务优先关联具体题目与可点击链接（仅未 AC 的题可入选：D）；
  // 池中题目用尽后回退为抽象任务（计划仍完整生成）
  assert.equal(practice[0].problemKey, 'D');
  assert.equal(practice[0].url, 'https://codeforces.com/contest/D');
});

test('templatePlan does not repeat the same problem across weak tags', () => {
  seed();
  // 两个弱项 tag 都命中同一道题（D: dp）与各自独立题（E: graphs）
  insertNormalized(db, 1, [
    sub('codeforces', 'E', 'WA', ['graphs'], 1700, '2026-07-28T15:00:00.000Z', 'https://codeforces.com/contest/E'),
  ]);
  const profile = {
    items: [
      { tag: 'dp', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, solved: 1 },
      { tag: 'graphs', attempts: 4, ac: 1, acRate: 25, avgAcRate: 60, gap: 35, solved: 1 },
    ],
    byDifficulty: [],
    generatedAt: '',
  };
  const p = templatePlan(db, profile, '2026-08-10', 6);
  const picked = p.tasks
    .filter((t) => t.kind === 'practice' && t.problemKey)
    .map((t) => `${t.platform}:${t.problemKey}`);
  assert.equal(new Set(picked).size, picked.length); // 无重复
});

test('savePlan falls back to problem url when task lacks url', () => {
  seed();
  const planId = savePlan(db, 1, {
    title: '兜底',
    goal: '',
    startDate: '2026-08-10',
    days: 1,
    tasks: [{ date: '2026-08-10', title: '练习', kind: 'practice', platform: 'codeforces', problemKey: 'A' }],
  }, 'manual');
  const t = db.prepare('SELECT url FROM plan_tasks WHERE plan_id = ?').get(planId) as { url: string | null };
  assert.equal(t.url, 'https://codeforces.com/contest/A'); // 任务未带链接 → 用题目链接
});

test('templatePlan attaches clickable urls to every task kind (practice/contest/review)', () => {
  seed();
  const p = templatePlan(db, { items: [{ tag: 'dp', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, solved: 1 }], byDifficulty: [], generatedAt: '' }, '2026-08-10', 14);
  // contest（第 7/14 天）与 review（第 4/8/12 天）任务都应有链接；practice 落到具体题
  const contest = p.tasks.filter((t) => t.kind === 'contest');
  const review = p.tasks.filter((t) => t.kind === 'review');
  assert.ok(contest.length >= 2);
  assert.ok(review.length >= 3);
  for (const t of [...contest, ...review]) {
    assert.ok(t.url, `任务 ${t.title} 应带可点击链接`);
  }
  const firstContest = contest[0];
  assert.ok(firstContest && firstContest.url?.startsWith('https://codeforces.com/'));
});

test('templatePlan keeps picking concrete problems after per-tag pool drains', () => {
  seed();
  // 单弱项 dp：池中未 AC 题只有 D 一道；7 天计划里 6 个 practice 日，D 用尽后应继续从全库兜底
  // （seed 数据只有 D，兜底池也空 → 抽象任务；补充 F 验证兜底确实生效）
  insertNormalized(db, 1, [
    sub('codeforces', 'F', 'WA', ['math'], 1550, '2026-07-28T16:00:00.000Z', 'https://codeforces.com/contest/F'),
  ]);
  const p = templatePlan(db, { items: [{ tag: 'dp', attempts: 5, ac: 1, acRate: 20, avgAcRate: 60, gap: 40, solved: 1 }], byDifficulty: [], generatedAt: '' }, '2026-08-10', 7);
  const practice = p.tasks.filter((t) => t.kind === 'practice');
  const withProblem = practice.filter((t) => t.problemKey && t.url);
  // D（dp 队列）+ F（dp 用尽后的全库兜底）都被选中且带链接
  const keys = withProblem.map((t) => t.problemKey);
  assert.ok(keys.includes('D'), `应选中 D: ${keys}`);
  assert.ok(keys.includes('F'), `dp 池耗尽后应兜底选中 F: ${keys}`);
  for (const t of withProblem) assert.ok(t.url, `${t.title} 应带链接`);
});

test('savePlan fuzzy-matches problem by title when AI omits url and key is wrong', () => {
  seed();
  const planId = savePlan(db, 1, {
    title: '模糊匹配',
    goal: '',
    startDate: '2026-08-10',
    days: 1,
    // AI 编造 problemKey、未带 url，但标题含题库题名（T D）→ 应按标题匹配补链接
    tasks: [{ date: '2026-08-10', title: '刷一道 T D 巩固 dp', kind: 'practice', platform: 'codeforces', problemKey: 'FAKE-KEY' }],
  }, 'manual');
  const t = db.prepare('SELECT url, problem_id FROM plan_tasks WHERE plan_id = ?').get(planId) as { url: string | null; problem_id: number | null };
  assert.equal(t.url, 'https://codeforces.com/contest/D');
  assert.ok((t.problem_id ?? 0) > 0); // 同时关联到题库记录
});

test('savePlan builds url from adapter when problem unknown in db', () => {
  initAdapters();
  const planId = savePlan(db, 1, {
    title: '适配器兜底',
    goal: '',
    startDate: '2026-08-10',
    days: 1,
    // 题库匹配不到（题名不含任何题库题名）→ 用 codeforces 适配器按 key 构造链接
    tasks: [{ date: '2026-08-10', title: '全新题目', kind: 'practice', platform: 'codeforces', problemKey: '1900F' }],
  }, 'manual');
  const t = db.prepare('SELECT url FROM plan_tasks WHERE plan_id = ?').get(planId) as { url: string | null };
  assert.equal(t.url, 'https://codeforces.com/contest/1900/problem/F');
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

test('recommendProblems prioritizes weak-tag problems, excludes AC-ed and anchors difficulty', () => {
  seed();
  const pkg = buildPlanPackage(db, 1, { days: 7, startDate: today() });
  // 弱项应为 greedy（1/2 AC 率低）或 dp
  const recs = recommendProblems(db, pkg.profile, { limit: 10 });
  assert.ok(recs.length >= 1);
  const firstTags = new Set(recs[0].tags);
  assert.ok(firstTags.has('greedy') || firstTags.has('dp'), `首个推荐应含弱项 tag: ${JSON.stringify(recs[0].tags)}`);
  // 排除已 AC：seed 中 A/B/C 已 AC，只有 D 未 AC → 推荐不应包含 A/B/C
  const keys = recs.map((r) => r.problemKey);
  assert.ok(!keys.includes('A') && !keys.includes('B') && !keys.includes('C'), `不应推荐已 AC 题: ${keys}`);
});

test('recommendProblems filters difficulty to suggested range when level provided', () => {
  seed();
  const pkg = buildPlanPackage(db, 1, { days: 7, startDate: today() });
  // 显式指定水平区间 1500-1700：区间外（无难度题/1200 题）被过滤
  const recs = recommendProblems(db, pkg.profile, {
    limit: 10,
    level: { solvedCount: 10, medianDifficulty: 1500, p75Difficulty: 1500, suggestedRange: [1500, 1700] },
  });
  for (const r of recs) {
    assert.ok(r.difficulty !== null && r.difficulty >= 1500 && r.difficulty <= 1700, `难度应在区间内: ${r.problemKey}=${r.difficulty}`);
  }
  // level=null（样本不足）→ 不按难度过滤，仅排除已 AC
  const recsNoLevel = recommendProblems(db, pkg.profile, { limit: 10, level: null });
  assert.ok(recsNoLevel.some((r) => r.problemKey === 'D'));
});

test('computeUserLevel returns percentiles from AC-ed difficulties', () => {
  assert.equal(computeUserLevel(db, 1).medianDifficulty, null); // 空 db：样本不足
  // 构造 12 道 AC 题，难度 800..1900（步长100）：中位 1300/1350 落点、P75 1600/1650
  const rows: NormalizedSubmission[] = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push(sub('codeforces', `K${i}`, 'AC', ['dp'], 800 + i * 100, '2026-07-28T10:00:00.000Z'));
  }
  insertNormalized(db, 1, rows);
  const lv = computeUserLevel(db, 1);
  assert.equal(lv.solvedCount, 12);
  assert.equal(lv.medianDifficulty, 1300);
  assert.equal(lv.p75Difficulty, 1600);
  assert.deepEqual(lv.suggestedRange, [1200, 1800]);
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

// ---------- 按弱项 tag 分组选题（导出提示词清单） ----------

const PROFILE = (tags: string[]) => ({
  items: tags.map((tag, i) => ({
    tag,
    attempts: 6,
    ac: 2,
    acRate: 33.3,
    avgAcRate: 60,
    gap: 26.7 - i, // 依次递减，tag[0] 最弱
    solved: 2,
  })),
  byDifficulty: [],
  generatedAt: '',
});

function seedGrouped(): void {
  // 用户已 AC：A(dp)、B(graphs)；未 AC：D(dp)、E(graphs)、F(无弱项标签)
  // D/E 各补 3 次 WA：使 dp/graphs 提交数 ≥5，过 buildPlanPackage 的 minAttempts=5 弱项门槛
  insertNormalized(db, 1, [
    sub('codeforces', 'A', 'AC', ['dp'], 1500, '2026-07-20T10:00:00.000Z', 'https://codeforces.com/contest/A'),
    sub('codeforces', 'B', 'AC', ['graphs'], 1500, '2026-07-25T10:00:00.000Z', 'https://codeforces.com/contest/B'),
    sub('codeforces', 'D', 'WA', ['dp'], 1500, '2026-07-28T10:00:00.000Z', 'https://codeforces.com/contest/D'),
    sub('codeforces', 'D', 'WA', ['dp'], 1500, '2026-07-27T10:00:00.000Z', 'https://codeforces.com/contest/D'),
    sub('codeforces', 'D', 'WA', ['dp'], 1500, '2026-07-26T10:00:00.000Z', 'https://codeforces.com/contest/D'),
    sub('codeforces', 'D', 'WA', ['dp'], 1500, '2026-07-25T09:00:00.000Z', 'https://codeforces.com/contest/D'),
    sub('codeforces', 'E', 'WA', ['graphs'], 1600, '2026-07-28T11:00:00.000Z', 'https://codeforces.com/contest/E'),
    sub('codeforces', 'E', 'WA', ['graphs'], 1600, '2026-07-27T11:00:00.000Z', 'https://codeforces.com/contest/E'),
    sub('codeforces', 'E', 'WA', ['graphs'], 1600, '2026-07-26T11:00:00.000Z', 'https://codeforces.com/contest/E'),
    sub('codeforces', 'E', 'WA', ['graphs'], 1600, '2026-07-25T09:30:00.000Z', 'https://codeforces.com/contest/E'),
    // 无弱项标签且未 AC → 应进「综合练习」兜底组
    sub('codeforces', 'F', 'WA', ['math'], 1500, '2026-07-28T12:00:00.000Z', 'https://codeforces.com/contest/F'),
  ]);
}

test('recommendProblemsByWeakTag groups by weak tag, limits per tag, AC only as review', () => {
  seedGrouped();
  const groups = recommendProblemsByWeakTag(db, PROFILE(['dp', 'graphs']) as never, {
    perTag: 5,
    reviewPerTag: 1,
    level: null, // 不过滤难度，聚焦分组语义
  });
  const tags = groups.map((g) => g.tag);
  assert.ok(tags.includes('dp'), `应包含 dp 组: ${tags}`);
  assert.ok(tags.includes('graphs'), `应包含 graphs 组: ${tags}`);
  assert.ok(tags.includes('综合练习'), `应包含兜底组: ${tags}`);

  const dp = groups.find((g) => g.tag === 'dp')!;
  // 未 AC 新题在前（role=weak），已 AC 仅 1 道且标注 review
  const weak = dp.problems.filter((p) => p.role === 'weak');
  const review = dp.problems.filter((p) => p.role === 'review');
  assert.ok(weak.some((p) => p.problemKey === 'D'), '未 AC 的 D 应为 dp 组新题');
  assert.equal(review.length, 1, '已 AC 题每组至多 1 道复习位');
  assert.equal(review[0].problemKey, 'A');
  // 综合练习组只含未 AC、无弱项标签的题
  const misc = groups.find((g) => g.tag === '综合练习')!;
  assert.deepEqual(misc.problems.map((p) => p.problemKey), ['F']);
  assert.ok(misc.problems.every((p) => p.role === 'weak'));
});

test('recommendProblemsByWeakTag respects perTag limit and difficulty range', () => {
  seedGrouped();
  // 追加 6 道 dp 未 AC 题，难度 1500-2000；区间设为 1500-1600 → 仅区间内入选
  const more: NormalizedSubmission[] = [];
  for (let i = 0; i < 6; i += 1) {
    more.push(sub('codeforces', `DP${i}`, 'WA', ['dp'], 1500 + i * 100, '2026-07-29T10:00:00.000Z', `https://codeforces.com/contest/DP${i}`));
  }
  insertNormalized(db, 1, more);
  const groups = recommendProblemsByWeakTag(db, PROFILE(['dp']) as never, {
    perTag: 2,
    reviewPerTag: 0,
    level: { solvedCount: 10, medianDifficulty: 1500, p75Difficulty: 1550, suggestedRange: [1500, 1600] },
  });
  const dp = groups.find((g) => g.tag === 'dp')!;
  assert.equal(dp.problems.filter((p) => p.role === 'weak').length, 2); // perTag 限量
  assert.ok(dp.problems.every((p) => p.difficulty !== null && p.difficulty >= 1500 && p.difficulty <= 1600));
  assert.ok(dp.problems.every((p) => p.role === 'weak')); // reviewPerTag=0 → 无复习位
});

test('recommendProblemsByWeakTag picks oldest-AC problem for review slot', () => {
  seedGrouped();
  // A 的 AC 时间（07-20）早于 B（07-25）；dp 组复习位应取 A（久未重做）
  const groups = recommendProblemsByWeakTag(db, PROFILE(['dp', 'graphs']) as never, {
    perTag: 5,
    reviewPerTag: 1,
    level: null,
  });
  const dp = groups.find((g) => g.tag === 'dp')!;
  const graphs = groups.find((g) => g.tag === 'graphs')!;
  assert.equal(dp.problems.find((p) => p.role === 'review')?.problemKey, 'A');
  assert.equal(graphs.problems.find((p) => p.role === 'review')?.problemKey, 'B'); // graphs 组内唯一 AC
});

test('buildPlanPackage renders grouped problem list in prompt markdown', () => {
  seedGrouped();
  const pkg = buildPlanPackage(db, 1, { days: 7, startDate: '2026-08-10' });
  // 提示词中出现分组标题与题目行（role 标注）
  assert.match(pkg.prompt, /### dp/);
  assert.match(pkg.prompt, /### 综合练习/);
  assert.match(pkg.prompt, /codeforces\/D《T D》\s*\|\s*难度1500\s*\|\s*未AC/);
  assert.match(pkg.prompt, /codeforces\/A《T A》\s*\|\s*难度1500\s*\|\s*已AC-可作复习/);
  // 扁平 problems 与分组结构一致
  assert.equal(pkg.problems.length, pkg.problemGroups.reduce((n, g) => n + g.problems.length, 0));
  // 未出现旧版大 JSON 数组形态
  assert.ok(!pkg.prompt.includes('[{"platform"'));
});

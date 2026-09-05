import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import {
  buildPracticeSummary,
  renderSummaryForPrompt,
  renderSummaryMarkdown,
} from '../src/analysis/summary.ts';
import { buildPlanPackage } from '../src/plans/planService.ts';

const DAY = 86_400_000;
const iso = (offsetDays: number): string => new Date(Date.now() - offsetDays * DAY).toISOString();
const dateStr = (offsetDays: number): string => iso(offsetDays).slice(0, 10);

/** 造数：平台题目 + 提交 + 复习/课程/打卡数据 */
function seed(db: Db): void {
  const insProblem = db.prepare(
    'INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES (?, ?, ?, ?, ?, ?)',
  );
  // CF：dp 两道 AC（一道 4 天前一道 20 天前）、一道卡壳题（3 WA 未 AC）
  const dp1 = Number(
    insProblem.run('codeforces', '1000A', 'DP 基础', 1400, 'https://codeforces.com/contest/1000/problem/A', JSON.stringify(['dp', '线性dp'])).lastInsertRowid,
  );
  const dp2 = Number(
    insProblem.run('codeforces', '1000B', 'DP 进阶', 1600, 'https://codeforces.com/contest/1000/problem/B', JSON.stringify(['dp'])).lastInsertRowid,
  );
  const stuck = Number(
    insProblem.run('codeforces', '1000C', '卡壳题', 1900, 'https://codeforces.com/contest/1000/problem/C', JSON.stringify(['dp', '贪心'])).lastInsertRowid,
  );
  // 洛谷：一道 AC
  const lg = Number(
    insProblem.run('luogu', 'P1001', 'A+B', 1000, 'https://www.luogu.com.cn/problem/P1001', JSON.stringify(['模拟'])).lastInsertRowid,
  );
  const insSub = db.prepare(
    'INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, ?, ?, ?, ?, ?)',
  );
  insSub.run('codeforces', dp1, 'AC', iso(4), 's1');
  insSub.run('codeforces', dp2, 'AC', iso(20), 's2');
  insSub.run('codeforces', stuck, 'WA', iso(3), 's3');
  insSub.run('codeforces', stuck, 'TLE', iso(2), 's4');
  insSub.run('codeforces', stuck, 'WA', iso(1), 's5');
  insSub.run('luogu', lg, 'AC', iso(2), 's6');

  // 复习库：1 在队列、1 到期
  db.prepare("INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (1, ?, ?)").run(dp1, dateStr(-1)); // 已逾期
  db.prepare("INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (1, ?, ?)").run(dp2, dateStr(7)); // 未来到期

  // 模板课程进度：任取课程前两讲
  db.prepare("INSERT INTO template_progress (template_id, user_id, status) VALUES (?, 1, 'mastered')").run('basic-binary-search');
  db.prepare("INSERT INTO template_progress (template_id, user_id, status) VALUES (?, 1, 'learning')").run('basic-two-pointers');

  // 打卡：今天和昨天各一次（plan → task → checkin）
  for (const offset of [0, 1]) {
    const planId = Number(
      db
        .prepare("INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', ?, ?, 'template')")
        .run(dateStr(offset), dateStr(offset)).lastInsertRowid,
    );
    const taskId = Number(
      db
        .prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (?, ?, 't', 'practice')")
        .run(planId, dateStr(offset)).lastInsertRowid,
    );
    db.prepare("INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)").run(taskId, dateStr(offset));
  }
}

test('buildPracticeSummary 汇总总量 / 平台 / 难度 / 标签 / 弱项', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  seed(db);
  const s = buildPracticeSummary(db, 1);

  assert.equal(s.overall.submissions, 6);
  assert.equal(s.overall.problems, 4);
  assert.equal(s.overall.solved, 3);
  assert.equal(s.range.activeDays, 5);
  assert.ok(s.range.firstSubmissionAt!.startsWith(dateStr(20)));

  const cf = s.byPlatform.find((p) => p.platform === 'codeforces')!;
  assert.equal(cf.submissions, 5);
  assert.equal(cf.problems, 3);
  assert.equal(cf.solved, 2);
  assert.ok(cf.solveRate > 60 && cf.solveRate < 70); // 2/3
  const lg = s.byPlatform.find((p) => p.platform === 'luogu')!;
  assert.equal(lg.solved, 1);
  assert.equal(lg.lastActiveAt!.slice(0, 10), dateStr(2));

  const dp = s.topTags.find((x) => x.tag === 'dp')!;
  assert.equal(dp.solved, 2);
  assert.equal(dp.attempts, 5);
  // 噪声标签（赛事/来源类）不参与知识点画像
  assert.equal(s.topTags.find((x) => x.tag === 'Codeforces'), undefined);

  // 能力评估：3 道 AC 有难度，但 computeUserLevel minSample=10 → null
  assert.equal(s.level.medianDifficulty, null);
  assert.equal(s.level.solvedCount, 3);
});

test('buildPracticeSummary 卡壳题 / 近期 AC / 复习库 / 课程进度 / 打卡', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  seed(db);
  const s = buildPracticeSummary(db, 1);

  assert.equal(s.stuckProblems.length, 1);
  const stuck = s.stuckProblems[0];
  assert.equal(stuck.problemKey, '1000C');
  assert.equal(stuck.attempts, 3);

  assert.equal(s.recentAc.length, 3);
  assert.equal(s.recentAc[0].problemKey, 'P1001'); // 最近 AC（2 天前）
  assert.equal(s.recentAc[0].platform, 'luogu');

  assert.equal(s.reviewQueue.total, 2);
  assert.equal(s.reviewQueue.dueCount, 1);

  assert.equal(s.templates.total > 100, true);
  assert.equal(s.templates.mastered, 1);
  assert.equal(s.templates.learning, 1);
  const basic = s.templates.byCategory.find((c) => c.key === 'basic')!;
  assert.equal(basic.mastered, 1);

  assert.deepEqual(s.checkins, { currentStreak: 2, longestStreak: 2, totalDays: 2 });

  // 掌握度摘要：dp 练过但档位低（2 题）应出现在 weak（英文 dp 按别名归并为动态规划）；AC 数少无 level>=3
  assert.ok(s.mastery.weak.some((m) => m.tag === '动态规划'));
  assert.equal(s.mastery.masteredCount, 0);

  // 「练过但 0 AC」的知识点（贪心：3 次 WA）必须进 weak，而不是被标成「从未练过」
  const greedy = s.mastery.weak.find((m) => m.tag === '贪心');
  assert.ok(greedy, '贪心（练过未通过）应出现在掌握薄弱清单');
  assert.equal(greedy.solved, 0);
  assert.ok(greedy.attempts >= 3);
  assert.equal(s.mastery.untouchedCourseTags.includes('贪心'), false, '练过的知识点不得归入课程盲区');
});

test('renderSummaryMarkdown 输出完整章节，renderSummaryForPrompt 输出精简行', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  seed(db);
  const s = buildPracticeSummary(db, 1);

  const md = renderSummaryMarkdown(s);
  for (const section of ['个人练习数据汇总', '## 一、总览', '## 二、平台分布', '## 四、知识点画像', '## 五、近 12 周训练趋势', '## 六、最近通过的题', '## 七、卡壳题', '## 八、学习系统状态']) {
    assert.ok(md.includes(section), `应包含「${section}」`);
  }
  assert.ok(md.includes('1000C'), '卡壳题应含题号');
  assert.ok(md.includes('学习盲区'), '应列出课程盲区章节（0 练习的课程知识点很多）');

  const brief = renderSummaryForPrompt(s);
  assert.ok(brief.startsWith('- '));
  assert.ok(brief.includes('掌握薄弱'));
  assert.ok(brief.includes('卡壳题'));
  assert.ok(brief.includes('复习库'));
  assert.ok(brief.includes('模板课程'));
});

test('buildPlanPackage 的提示词注入数据汇总段', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  seed(db);
  const pkg = buildPlanPackage(db, 1, { days: 7, startDate: dateStr(0) });
  assert.ok(pkg.prompt.includes('用户练习数据汇总'));
  assert.ok(pkg.prompt.includes('掌握薄弱'));
  assert.ok(!pkg.prompt.includes('{summary}'), '占位符应被替换');
  // 结构化汇总随数据包导出
  assert.equal(pkg.summary.overall.submissions, 6);
  assert.ok(pkg.summaryPrompt.includes('近期在练') || pkg.summaryPrompt.includes('近期'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { computeMastery, levelFor, templatesForTag } from '../src/analysis/mastery.ts';
import { CURRICULUM } from '../src/templates/curriculum.ts';

test('levelFor 档位阈值：20题+70%熟练 / 10题掌握 / 5题入门 / 1题接触 / 0未开始（acRate 为百分数）', () => {
  assert.equal(levelFor(0, 0), 0);
  assert.equal(levelFor(1, 50), 1);
  assert.equal(levelFor(4, 100), 1); // 不足 5 题，仍是接触
  assert.equal(levelFor(5, 50), 2);
  assert.equal(levelFor(9, 90), 2); // 不足 10 题，仍是入门
  assert.equal(levelFor(10, 30), 3);
  assert.equal(levelFor(19, 90), 3); // 不足 20 题，仍是掌握
  assert.equal(levelFor(20, 50), 3); // AC 率不达标
  assert.equal(levelFor(20, 70), 4);
  assert.equal(levelFor(30, 95), 4);
});

test('templatesForTag 返回关联课程与学习状态', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  // 任取课程中一个真实 tag
  const tag = CURRICULUM.flatMap((c) => c.templates.map((x) => ({ t: x, cat: c }))).find((x) => x.t.tags.length > 0)!.t.tags[0];
  const links = templatesForTag(db, 1, tag);
  assert.ok(links.length > 0, `课程 tag「${tag}」应关联到模板`);
  assert.ok(links.every((l) => l.status === 'todo'));

  db.prepare("INSERT INTO template_progress (template_id, user_id, status) VALUES (?, 1, 'mastered')").run(links[0].id);
  const after = templatesForTag(db, 1, tag);
  assert.equal(after.find((l) => l.id === links[0].id)?.status, 'mastered');
});

function seedSubmission(
  db: Db,
  platform: string,
  key: string,
  tags: string[],
  verdict: string,
  submittedAt: string,
): void {
  const pid = (() => {
    const found = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, key) as { id: number } | undefined;
    if (found) return found.id;
    return Number(
      db
        .prepare('INSERT INTO problems (platform, problem_key, title, tags) VALUES (?, ?, ?, ?)')
        .run(platform, key, key, JSON.stringify(tags)).lastInsertRowid,
    );
  })();
  db.prepare(
    'INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, ?, ?, ?, ?, ?)',
  ).run(platform, pid, verdict, submittedAt, `${key}-${verdict}-${submittedAt}`);
}

test('computeMastery：CF 英文标签按别名归并到课程中文知识点（binary search → 二分）', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) seedSubmission(db, 'codeforces', `700${i}A`, ['binary search'], 'AC', now);
  seedSubmission(db, 'codeforces', '7010A', ['two pointers'], 'AC', now);

  const report = computeMastery(db, 1);
  // 英文标签不再单独立点，而是并入中文知识点
  assert.equal(report.points.find((p) => p.tag === 'binary search'), undefined);
  const bin = report.points.find((p) => p.tag === '二分');
  assert.ok(bin, 'binary search 应归并到「二分」');
  assert.equal(bin.solved, 3);
  assert.equal(bin.attempts, 3);
  // 课程大纲里直接写英文别名的 tag（two pointers）同样归并，不产生重复知识点
  assert.equal(report.points.find((p) => p.tag === 'two pointers'), undefined);
  const tp = report.points.find((p) => p.tag === '双指针');
  assert.ok(tp, 'two pointers 应归并到「双指针」');
  assert.equal(tp.solved, 1);
});

test('computeMastery：无别名映射的英文标签保持原样（brute force 不强行归并）', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  seedSubmission(db, 'codeforces', '8000A', ['brute force'], 'AC', new Date().toISOString());
  const report = computeMastery(db, 1);
  assert.ok(report.points.find((p) => p.tag === 'brute force'));
});

test('computeMastery：按 tag 聚合、联动课程、0 练习的知识点标记未开始', (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  const now = Date.now();
  const iso = (offsetMs: number): string => new Date(now - offsetMs).toISOString();
  const day = 86_400_000;

  // 二分：6 题 AC（5 天前）→ 入门（solved 6）
  for (let i = 0; i < 6; i += 1) seedSubmission(db, 'codeforces', `100${i}A`, ['二分'], 'AC', iso(i * day + day));
  // 贪心：2 AC + 8 WA → 接触（solved 2，gap 大）
  for (let i = 0; i < 2; i += 1) seedSubmission(db, 'codeforces', `200${i}A`, ['贪心'], 'AC', iso(day));
  for (let i = 0; i < 8; i += 1) seedSubmission(db, 'codeforces', `300${i}A`, ['贪心'], 'WA', iso(2 * day));
  // 噪声标签不参与
  seedSubmission(db, 'luogu', 'P1001', ['2026'], 'AC', iso(day));

  const report = computeMastery(db, 1);
  const bin = report.points.find((p) => p.tag === '二分');
  assert.ok(bin);
  assert.equal(bin.solved, 6);
  assert.equal(bin.attempts, 6);
  assert.equal(bin.level, 2);
  assert.equal(bin.recentSolved, 6);

  const greedy = report.points.find((p) => p.tag === '贪心');
  assert.ok(greedy);
  assert.equal(greedy.solved, 2);
  assert.equal(greedy.attempts, 10);
  assert.equal(greedy.level, 1);
  assert.ok(greedy.gap > 0); // 低于自身平均

  // 课程里的知识点即使 0 练习也输出（未开始）且关联模板
  const untouched = report.points.find((p) => p.level === 0 && p.solved === 0 && p.templates.length > 0);
  assert.ok(untouched, '应存在 0 练习但关联课程模板的知识点');
  assert.ok(untouched.templates.every((l) => l.categoryName.length > 0));

  // 噪声标签未混入
  assert.equal(report.points.find((p) => p.tag === '2026'), undefined);

  // minSolved 过滤
  const filtered = computeMastery(db, 1, { minSolved: 5 });
  assert.ok(filtered.points.every((p) => p.solved >= 5));
});

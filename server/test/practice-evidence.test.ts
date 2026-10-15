import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { computeWeakness } from '../src/analysis/weakness.ts';
import { computeMastery } from '../src/analysis/mastery.ts';

function seed(db: Db, n = 10) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = Number(db.prepare("INSERT INTO problems(platform,problem_key,title,difficulty,tags) VALUES('codeforces',?,?,1500,?)").run(`P${i}`, `P${i}`, '["动态规划","数论"]').lastInsertRowid);
    db.prepare("INSERT INTO submissions(user_id,platform,account,problem_id,verdict,submitted_at) VALUES(1,'codeforces','main',?,'AC','2026-01-01T00:00:00Z')").run(id);
    ids.push(id);
  }
  return ids;
}

test('看题解按知识点降低掌握证据并提高推荐优先级，真实 AC 率保持原值', () => {
  const db = createDb(':memory:');
  try {
    const ids = seed(db);
    for (const id of ids) db.prepare("INSERT INTO submission_intents(user_id,problem_id,code,outcome,created_at) VALUES(1,?,'dp.general','editorial','2026-01-02 00:00:00')").run(id);
    const weak = computeWeakness(db, 1);
    const dp = weak.items.find(p => p.tag === '动态规划')!;
    const nt = weak.items.find(p => p.tag === '数论')!;
    assert.equal(dp.acRate, 100); assert.equal(dp.gap, 0);
    assert.ok(dp.rank > nt.rank);
    assert.ok(dp.evidenceGap! > 0);
    const points = computeMastery(db, 1).points;
    const mastery = points.find(p => p.tag === '动态规划')!;
    assert.equal(mastery.solved, 10);
    assert.ok(mastery.level < 3, '依赖题解的十题不能直接变成掌握');
    assert.equal(mastery.evidence!.assistedSolved, 10);
    assert.equal(mastery.evidence!.creditedSolved, 4.5);
    assert.equal(points.find(p => p.tag === '数论')!.level, 3, '明确归因的卡点不污染其它知识点');
  } finally { db.close(); }
});

test('最新成功复习可恢复证据，后来的失手降低证据，重复 AC 不增加样本量', () => {
  const db = createDb(':memory:');
  try {
    const [id] = seed(db, 1);
    db.prepare("INSERT INTO submissions(user_id,platform,account,problem_id,verdict,submitted_at) VALUES(1,'codeforces','main',?,'AC','2026-01-02T00:00:00Z')").run(id);
    db.prepare("INSERT INTO submission_intents(user_id,problem_id,outcome,created_at) VALUES(1,?,'editorial','2026-01-02 00:00:00')").run(id);
    const item = db.prepare("INSERT INTO review_items(user_id,problem_id,next_due_on) VALUES(1,?,'2026-01-03')").run(id).lastInsertRowid;
    const review = db.prepare("INSERT INTO review_events(user_id,review_item_id,problem_id,reviewed_at,feedback,stage_before,stage_after,due_on,interval_days,factor) VALUES(1,?,?,?, ?,0,1,'2026-01-03',7,1)");
    review.run(item, id, '2026-01-03T00:00:00Z', 'ok');
    let point = computeMastery(db, 1).points.find(p => p.tag === '动态规划')!;
    assert.equal(point.evidence!.sampleSize, 1);
    assert.equal(point.evidence!.creditedSolved, 1);
    assert.equal(point.level, 1, '样本不足仍保留接触状态');
    review.run(item, id, '2026-01-04T00:00:00Z', 'hard');
    point = computeMastery(db, 1).points.find(p => p.tag === '动态规划')!;
    assert.ok(point.evidence!.creditedSolved < 1);
    assert.equal(point.evidence!.fragileSolved, 1);
    review.run(item, id, '2026-01-05T00:00:00Z', 'easy');
    assert.equal(computeMastery(db, 1).points.find(p => p.tag === '动态规划')!.evidence!.creditedSolved, 1);
  } finally { db.close(); }
});

test('掌握证据不借用其它账号的题量或其它用户的卡点', () => {
  const db = createDb(':memory:');
  try {
    const [id] = seed(db, 1);
    db.prepare("INSERT INTO users(id,username) VALUES(2,'other')").run();
    db.prepare("INSERT INTO submission_intents(user_id,problem_id,outcome) VALUES(2,?,'editorial')").run(id);
    const main = computeMastery(db, 1, { platform: 'codeforces', account: 'main' }).points.find(p => p.tag === '动态规划')!;
    const alt = computeMastery(db, 1, { platform: 'codeforces', account: 'alt' }).points.find(p => p.tag === '动态规划')!;
    assert.equal(main.evidence!.creditedSolved, 1);
    assert.equal(alt.evidence!.sampleSize, 0);
    assert.equal(alt.level, 0);
  } finally { db.close(); }
});

test('尚未 AC 的明确卡点也进入补强建议，并按题目而非重复提交计数', () => {
  const db = createDb(':memory:');
  try {
    const [id] = seed(db, 1);
    db.prepare("UPDATE submissions SET verdict = 'WA' WHERE problem_id = ?").run(id);
    const before = computeWeakness(db, 1, { minAttempts: 1 }).items.find(p => p.tag === '动态规划')!;
    db.prepare("INSERT INTO submission_intents(user_id,problem_id,code,outcome) VALUES(1,?,'dp.general','cant_start')").run(id);
    const after = computeWeakness(db, 1, { minAttempts: 1 }).items.find(p => p.tag === '动态规划')!;
    assert.ok(after.rank > before.rank);
    assert.equal(after.evidence!.stuckProblems, 1);
    assert.equal(after.evidence!.creditedSolved, 0);
    assert.equal(after.acRate, 0);
  } finally { db.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { fixVjudgeProblemIdentities } from '../src/db/vjudgeIdentityFix.ts';

function seedProblem(db: Db, platform: string, key: string, title: string, url: string | null = null): number {
  const r = db
    .prepare('INSERT INTO problems (platform, problem_key, title, url, tags) VALUES (?, ?, ?, ?, \'[]\')')
    .run(platform, key, title, url);
  return Number(r.lastInsertRowid);
}

test('迁移：vjudge 行原地改名为原 OJ 身份（目标键不存在）', () => {
  const db = createDb(':memory:');
  try {
    const id = seedProblem(db, 'vjudge', 'CodeForces-1234A', 'CodeForces-1234A', 'https://vjudge.net/problem/CodeForces-1234A');
    const result = fixVjudgeProblemIdentities(db);

    assert.deepEqual(result, { renamed: 1, merged: 0, skipped: 0 });
    const row = db.prepare('SELECT id, platform, problem_key, title, url FROM problems WHERE id = ?').get(id) as
      | { id: number; platform: string; problem_key: string; title: string; url: string }
      | undefined;
    assert.ok(row, '行本身必须保留（不重建，引用不会断）');
    assert.equal(row!.platform, 'codeforces');
    assert.equal(row!.problem_key, '1234A');
    // 标题当初就是题号 → 跟着改，保持「不是真标题」的语义
    assert.equal(row!.title, '1234A');
    // 转发链接换成原站地址
    assert.equal(row!.url, 'https://codeforces.com/contest/1234/problem/A');
    // 生成列 identity 自动重算
    assert.equal((db.prepare('SELECT identity FROM problems WHERE id = ?').get(id) as { identity: string }).identity, 'codeforces:1234a');
  } finally { db.close(); }
});

test('迁移：目标键已存在时跨平台合并，引用迁到保留行', () => {
  const db = createDb(':memory:');
  try {
    const keepId = seedProblem(db, 'luogu', 'P1001', 'A+B Problem', 'https://www.luogu.com.cn/problem/P1001');
    const oldId = seedProblem(db, 'vjudge', '洛谷-P1001', '洛谷-P1001', 'https://vjudge.net/problem/洛谷-P1001');
    db.prepare(`INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
      VALUES (?, 'vjudge', 'Fantasy', ?, 'AC', '2026-08-01T00:00:00Z', 'run-1')`).run(DEFAULT_USER_ID, oldId);
    db.prepare('INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, \'2026-09-01\')').run(DEFAULT_USER_ID, oldId);

    const result = fixVjudgeProblemIdentities(db);
    assert.deepEqual(result, { renamed: 0, merged: 1, skipped: 0 });

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problems WHERE platform = \'vjudge\'').get() as { n: number }).n, 0, '旧行必须删除');
    const keep = db.prepare('SELECT title FROM problems WHERE id = ?').get(keepId) as { title: string };
    assert.equal(keep.title, 'A+B Problem', '保留行的好标题不被覆盖');
    const sub = db.prepare('SELECT problem_id FROM submissions WHERE external_id = \'run-1\'').get() as { problem_id: number };
    assert.equal(sub.problem_id, keepId, '提交迁到保留行');
    const review = db.prepare('SELECT problem_id FROM review_items').get() as { problem_id: number };
    assert.equal(review.problem_id, keepId, '复习条目迁到保留行');
  } finally { db.close(); }
});

test('迁移：未接入的原 OJ 保持 vjudge 身份（不丢数据、已是规范写法即空操作）', () => {
  const db = createDb(':memory:');
  try {
    const id = seedProblem(db, 'vjudge', 'SPOJ-TEST', 'SPOJ-TEST', 'https://vjudge.net/problem/SPOJ-TEST');
    const result = fixVjudgeProblemIdentities(db);
    assert.deepEqual(result, { renamed: 0, merged: 0, skipped: 1 });
    const row = db.prepare('SELECT platform, problem_key FROM problems WHERE id = ?').get(id) as { platform: string; problem_key: string };
    assert.equal(row.platform, 'vjudge');
    assert.equal(row.problem_key, 'SPOJ-TEST');
  } finally { db.close(); }
});

/**
 * 未接入 OJ 的**别名归并**：旧实现对这类行一律原样不动，于是 HYSBZ-1000 / 黑暗爆炸-1000
 * 会与 BZOJ-1000 长期各占一行（同一道题在统计里算三次）。
 */
test('迁移：未接入 OJ 的别名行归并到规范字面量，提交跟着走', () => {
  const db = createDb(':memory:');
  try {
    const keepId = seedProblem(db, 'vjudge', 'LibreOJ-102', 'LibreOJ-102', 'https://vjudge.net/problem/LibreOJ-102');
    const aliasId = seedProblem(db, 'vjudge', 'LOJ-102', 'LOJ-102', 'https://vjudge.net/problem/LOJ-102');
    const lowerId = seedProblem(db, 'vjudge', 'libreoj-102', 'libreoj-102', null);
    db.prepare(`INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
      VALUES (?, 'vjudge', 'Fantasy', ?, 'AC', '2026-08-01T00:00:00Z', 'run-1')`).run(DEFAULT_USER_ID, aliasId);
    db.prepare(`INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
      VALUES (?, 'vjudge', 'Fantasy', ?, 'WA', '2026-08-02T00:00:00Z', 'run-2')`).run(DEFAULT_USER_ID, lowerId);

    // 保留行本身已是规范写法（键 + 链接都对）→ 空操作，计入 skipped
    const result = fixVjudgeProblemIdentities(db);
    assert.deepEqual(result, { renamed: 0, merged: 2, skipped: 1 });

    const rows = db.prepare("SELECT id, problem_key FROM problems WHERE platform = 'vjudge'").all() as
      Array<{ id: number; problem_key: string }>;
    assert.deepEqual(rows.map(r => r.problem_key), ['LibreOJ-102'], '别名行并入规范行');
    const subs = db.prepare('SELECT problem_id FROM submissions ORDER BY external_id').all() as Array<{ problem_id: number }>;
    assert.deepEqual(subs.map(s => s.problem_id), [keepId, keepId], '提交迁到保留行');
  } finally { db.close(); }
});

test('迁移：未接入 OJ 的行补齐规范链接（键已规范、链接还是旧写法）', () => {
  const db = createDb(':memory:');
  try {
    // 历史行可能键规范但链接缺/脏（例如早期 problemUrl 编码口径不同）
    const id = seedProblem(db, 'vjudge', 'Toph-make-it-big', 'Toph-make-it-big', null);
    const result = fixVjudgeProblemIdentities(db);
    assert.deepEqual(result, { renamed: 1, merged: 0, skipped: 0 });
    const row = db.prepare('SELECT url FROM problems WHERE id = ?').get(id) as { url: string };
    assert.equal(row.url, 'https://vjudge.net/problem/Toph-make-it-big');
  } finally { db.close(); }
});

test('迁移：幂等 —— 第二次运行是空操作', () => {
  const db = createDb(':memory:');
  try {
    seedProblem(db, 'vjudge', '洛谷-P1001', '洛谷-P1001');
    seedProblem(db, 'vjudge', 'AtCoder-abc300_a', 'AtCoder-abc300_a');
    // 未接入 OJ 的别名行同样要收敛，且第二次运行不得再动它（否则每次启动都重写一遍）
    seedProblem(db, 'vjudge', 'LOJ-102', 'LOJ-102', 'https://vjudge.net/problem/LOJ-102');
    const first = fixVjudgeProblemIdentities(db);
    assert.equal(first.renamed, 3);
    const second = fixVjudgeProblemIdentities(db);
    assert.deepEqual(second, { renamed: 0, merged: 0, skipped: 1 }, '只剩已规范的那行，且是空操作');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n, 3, '行数不变');
  } finally { db.close(); }
});

test('迁移：题单条目/知识点/墓碑跟着改键，撞唯一键的丢弃旧侧', () => {
  const db = createDb(':memory:');
  try {
    seedProblem(db, 'vjudge', '洛谷-P1001', '洛谷-P1001');
    db.prepare("INSERT INTO problem_lists (id, user_id, title) VALUES (1, ?, 'L')").run(DEFAULT_USER_ID);
    db.prepare("INSERT INTO problem_list_items (list_id, platform, problem_key, title, position) VALUES (1, 'vjudge', '洛谷-P1001', '洛谷-P1001', 0)").run();
    db.prepare("INSERT INTO deleted_problems (platform, problem_key, normalized_key) VALUES ('vjudge', '洛谷-P1001', '洛谷-p1001')").run();

    fixVjudgeProblemIdentities(db);

    const item = db.prepare('SELECT platform, problem_key FROM problem_list_items').get() as { platform: string; problem_key: string };
    assert.equal(item.platform, 'luogu');
    assert.equal(item.problem_key, 'P1001');
    const tomb = db.prepare('SELECT platform, problem_key, normalized_key FROM deleted_problems').get() as
      { platform: string; problem_key: string; normalized_key: string };
    assert.equal(tomb.platform, 'luogu');
    assert.equal(tomb.problem_key, 'P1001');
    assert.equal(tomb.normalized_key, 'p1001', '归一化键同步重算');
  } finally { db.close(); }
});

test('迁移：与「通过链接添加」产生的行落到同一身份（迁移后不再重复）', () => {
  const db = createDb(':memory:');
  try {
    // 模拟：先有 VJudge 同步行，后用户通过链接添加了同一道题（luogu/P1001）
    seedProblem(db, 'vjudge', '洛谷-P1001', '洛谷-P1001');
    const addedId = seedProblem(db, 'luogu', 'P1001', 'A+B Problem');
    fixVjudgeProblemIdentities(db);
    const rows = db.prepare("SELECT id, platform FROM problems WHERE identity = 'luogu:p1001'").all() as Array<{ id: number; platform: string }>;
    assert.equal(rows.length, 1, '同一道题只能有一行');
    assert.equal(rows[0]!.id, addedId, '保留的是用户通过链接添加的那行（有真标题）');
  } finally { db.close(); }
});
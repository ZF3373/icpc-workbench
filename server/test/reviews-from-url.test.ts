import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import { addReviewFromUrl } from '../src/reviews/fromUrl.ts';

test('URL creates a review and problem without inventing a submission', () => {
  const db = createDb(':memory:');
  try {
    const result = addReviewFromUrl(db, 'https://www.luogu.com.cn/problem/P1001', 'A+B');
    assert.equal(result.problemKey, 'P1001');
    assert.equal(result.title, 'A+B');
    assert.equal(result.created, true);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as {n:number}).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as {n:number}).n, 1);
  } finally { db.close(); }
});

test('existing metadata and review progress survive duplicate URL imports', () => {
  const db = createDb(':memory:');
  try {
    addReviewFromUrl(db, 'https://codeforces.com/contest/1234/problem/A', 'Original');
    db.prepare("UPDATE review_items SET stage=4, next_due_on='2030-01-01'").run();
    const again = addReviewFromUrl(db, 'https://codeforces.com/problemset/problem/1234/A?locale=en', 'Replacement');
    assert.equal(again.alreadyInQueue, true);
    assert.equal(again.created, false);
    assert.equal(again.title, 'Original');
    assert.equal(again.nextDueOn, '2030-01-01');
    assert.equal((db.prepare('SELECT stage FROM review_items').get() as {stage:number}).stage, 4);
  } finally { db.close(); }
});

/**
 * 回归（2026-11-07）：同一道题的**不同平台行**不能各建一条复习条目。
 *
 * `review_items` 的唯一键是 (user_id, problem_id) —— 按题目**行**，而 problems 表里同一道题
 * 可以有多行（`codeforces/1000A` 与洛谷镜像 `luogu/CF1000A` 共享 identity
 * `codeforces:1000a`）。按行判「是否已在队列」会真的落出两条：今日训练里同一道题出现两次、
 * 两条各自独立排期（一条练到 60 天档、另一条还在 3 天档）—— 用户要复习同一道题两遍。
 */
test('同一道题的多平台行共用一条复习条目（按题目身份去重）', () => {
  const db = createDb(':memory:');
  try {
    const first = addReviewFromUrl(db, 'https://codeforces.com/contest/1000/problem/A');
    assert.equal(first.alreadyInQueue, false);
    db.prepare("UPDATE review_items SET stage=5, next_due_on='2030-01-01'").run();

    // 洛谷镜像题（identity 相同、题目行不同）
    const mirror = addReviewFromUrl(db, 'https://www.luogu.com.cn/problem/CF1000A');
    assert.equal(mirror.created, true, '镜像题是新题目行');
    assert.equal(mirror.alreadyInQueue, true, '但同一道题已在复习队列里 → 复用，不新建条目');
    assert.equal(mirror.nextDueOn, '2030-01-01', '复用原条目的排期，不被新条目的首刷日覆盖');

    // VJudge 转发链接落到原平台身份上
    const viaVjudge = addReviewFromUrl(db, 'https://vjudge.net/problem/CodeForces-1000A');
    assert.equal(viaVjudge.alreadyInQueue, true);

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n,
      2,
      '题目行仍是两行（不同平台各自一行，这是既有设计）',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n,
      1,
      '同一道题只能有一条复习条目',
    );
    assert.equal((db.prepare('SELECT stage FROM review_items').get() as { stage: number }).stage, 5, '进度不被镜像导入覆盖');
  } finally { db.close(); }
});

test('supported platform URLs and VJudge resolve to platform identities', () => {
  const db = createDb(':memory:');
  try {
    for (const [url, platform, key] of [
      ['https://atcoder.jp/contests/abc300/tasks/abc300_a', 'atcoder', 'abc300_a'],
      ['https://leetcode.cn/problems/two-sum/', 'leetcode', 'two-sum'],
      ['https://qoj.ac/problem/9242', 'qoj', '9242'],
      ['https://vjudge.net/problem/洛谷-P1001', 'luogu', 'P1001'],
      ['https://codeforces.com/gym/104821/problem/A', 'codeforces', '104821A'],
      ['https://ac.nowcoder.com/acm/problem/51000', 'nowcoder', '51000'],
      ['https://bs.daimayuan.top/p/7', 'daimayuan', '7'],
      ['https://www.jisuanke.com/problem/T1001', 'jisuanke', 'T1001'],
    ]) {
      const result = addReviewFromUrl(db, url);
      assert.equal(result.platform, platform);
      assert.equal(result.problemKey, key);
    }
  } finally { db.close(); }
});

/**
 * 本应用**没有**的 OJ（SPOJ / HDU / Toph …）：VJudge 是唯一数据源，链接必须能加进复习库，
 * 落 `vjudge/{规范 OJ}-{题号}`。旧实现在这里抛「未识别到题目」——用户从 VJudge 复制的
 * 一半题目根本加不进来。
 */
test('VJudge 未接入 OJ 的链接可以加进复习库（落 vjudge 身份）', () => {
  const db = createDb(':memory:');
  try {
    for (const [url, key] of [
      ['https://vjudge.net/problem/SPOJ-TEST', 'SPOJ-TEST'],
      ['https://vjudge.net/problem/HDU-1000', 'HDU-1000'],
      ['https://vjudge.net/problem/Toph-make-it-big', 'Toph-make-it-big'],
      ['https://vjudge.net/problem/OpenJ_NOI-CH0106-02', 'OpenJ_NOI-CH0106-02'],
    ] as const) {
      const result = addReviewFromUrl(db, url);
      assert.equal(result.platform, 'vjudge', url);
      assert.equal(result.problemKey, key, url);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problems').get() as {n:number}).n, 4);
    // 已接入的 OJ 仍映射回原平台（去重口径不变）
    assert.equal(addReviewFromUrl(db, 'https://vjudge.net/problem/洛谷-P1001').platform, 'luogu');
  } finally { db.close(); }
});

test('invalid URLs do not write anything', () => {
  const db = createDb(':memory:');
  try {
    for (const url of ['', 'P1001', 'javascript:alert(1)', 'https://example.com/luogu.com.cn/problem/P1001',
      'https://codeforces.com.evil.test/contest/1234/problem/A', 'https://codeforces.com/',
      'https://user:pass@codeforces.com/contest/1234/problem/A',
      // 没有题号 / 不是题目页：识别不到身份，仍必须拒绝
      'https://vjudge.net/problem/', 'https://vjudge.net/problem/SPOJ-']) {
      assert.throws(() => addReviewFromUrl(db, url), Error, url);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problems').get() as {n:number}).n, 0);
  } finally { db.close(); }
});
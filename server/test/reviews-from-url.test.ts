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

test('invalid URLs do not write anything', () => {
  const db = createDb(':memory:');
  try {
    for (const url of ['', 'P1001', 'javascript:alert(1)', 'https://example.com/luogu.com.cn/problem/P1001',
      'https://codeforces.com.evil.test/contest/1234/problem/A', 'https://codeforces.com/',
      'https://user:pass@codeforces.com/contest/1234/problem/A', 'https://vjudge.net/problem/SPOJ-TEST']) {
      assert.throws(() => addReviewFromUrl(db, url), Error, url);
    }
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problems').get() as {n:number}).n, 0);
  } finally { db.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  problemIdPrefix,
  problemSetMatchesContest,
} from '../src/contests/problemSetShape.ts';

/**
 * 题目集归属校验（problemSetShape.ts）：CF 2241 存进牛客「小乐乐」20 题的真实事故，
 * 靠这里的 key 前缀约定在读取期与迁移期同时兜住。
 */

test('problemIdPrefix：CF 用 contestId 前缀，AtCoder 用 `{contestId}_`，其余不校验', () => {
  assert.equal(problemIdPrefix('codeforces', '2241'), '2241');
  assert.equal(problemIdPrefix('atcoder', 'abc454'), 'abc454_');
  assert.equal(problemIdPrefix('nowcoder', '140489'), null);
  assert.equal(problemIdPrefix('luogu', '357001'), null);
});

test('problemSetMatchesContest：本场题目集通过，牛客串台数据被拒', () => {
  // 正确的 CF 题目集（standings 形态）
  assert.equal(
    problemSetMatchesContest('codeforces', '2241', [
      { id: '2241A' },
      { id: '2241B' },
      { id: '2241C1' },
    ]),
    true,
  );
  // 真实事故数据：CF 2241 行里存的是牛客题目 id
  assert.equal(
    problemSetMatchesContest('codeforces', '2241', [
      { id: '54536' },
      { id: '54537' },
      { id: '54538' },
    ]),
    false,
    '牛客数字 id 不得被当成 CF 2241 的题目集',
  );
  // 同号牛客比赛的题集若 id 恰好带前缀则放行不了——前缀不匹配即拒
  assert.equal(problemSetMatchesContest('codeforces', '2244', [{ id: '2241A' }]), false, '别的场次也不行');

  assert.equal(
    problemSetMatchesContest('atcoder', 'abc454', [{ id: 'abc454_a' }, { id: 'abc454_g' }]),
    true,
  );
  assert.equal(
    problemSetMatchesContest('atcoder', 'abc454', [{ id: '54536' }]),
    false,
    'AtCoder 场次同样不得接受牛客题目 id',
  );
});

test('problemSetMatchesContest：无前缀约定的平台一律放行，空集不合法', () => {
  assert.equal(problemSetMatchesContest('nowcoder', '140489', [{ id: '320779' }, { id: '320781' }]), true);
  assert.equal(problemSetMatchesContest('jisuanke', '37170', [{ id: '37170-101605' }]), true);
  assert.equal(problemSetMatchesContest('codeforces', '2241', []), false, '空集不是有效题目集');
  assert.equal(problemSetMatchesContest('codeforces', '2241', null), false);
});

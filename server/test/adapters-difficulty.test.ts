import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { NormalizedProblem, NormalizedSubmission, PlatformId } from '../../shared/src/index.ts';
import { difficultyFields } from '../../shared/src/difficulty.ts';
import { createCodeforcesAdapter } from '../src/adapters/codeforces.ts';
import { createAtcoderAdapter } from '../src/adapters/atcoder.ts';
import { createLuoguAdapter, luoguDifficultyToRating } from '../src/adapters/luogu.ts';
import { createNowcoderAdapter } from '../src/adapters/nowcoder.ts';
import { createLeetcodeAdapter, leetcodeDifficultyToRating } from '../src/adapters/leetcode.ts';
import { createDaimayuanAdapter } from '../src/adapters/daimayuan.ts';
import { createJisuankeAdapter, jisuankeDifficultyToRating } from '../src/adapters/jisuanke.ts';
import { createQojAdapter, normalizeQojRow } from '../src/adapters/qoj.ts';
import { daimayuanDifficultyToRating } from '../src/adapters/problemBank.ts';

/**
 * 任务 3：8 平台适配器接入 shared/src/difficulty.ts 统一难度标尺。
 *
 * 断言分层：
 * - 薄包装别名（旧调用点签名不变）必须与统一模块同值；
 * - 有难度来源的平台必须同时下发 difficulty / nativeDifficulty / difficultyScale；
 * - 提交载荷里没有难度的平台必须只下发 difficultyScale，**不得猜**（保持"未知 = 缺 difficulty 键"）。
 */

/** 请求路由器：按 URL 子串匹配返回预置响应（与其余适配器测试同款） */
function router(
  handlers: Record<string, (url: string) => unknown>,
): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        const v = handler(u);
        if (typeof v === 'string') return new Response(v, { status: 200 });
        return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

// ---------- 1. 薄包装别名（表已收敛，调用点签名不变） ----------

test('薄包装别名与统一模块一致（旧调用点不用改）', () => {
  assert.equal(luoguDifficultyToRating(4), 1800);
  assert.equal(luoguDifficultyToRating(3), 1500);
  assert.equal(luoguDifficultyToRating(0), null);
  assert.equal(luoguDifficultyToRating(9), null); // 越界档位不得当 8 用
  assert.equal(leetcodeDifficultyToRating('HARD'), 2100);
  assert.equal(leetcodeDifficultyToRating('easy'), 1000);
  assert.equal(leetcodeDifficultyToRating(undefined), null);
  assert.equal(jisuankeDifficultyToRating('level5'), 2200);
  assert.equal(jisuankeDifficultyToRating(5), 2200); // 整数档位也接受（接口另有数字形态）
  assert.equal(daimayuanDifficultyToRating(9), 2200);
  // 别名与共享模块逐点同值
  for (const d of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(luoguDifficultyToRating(d), difficultyFields('luogu', d).difficulty);
    assert.equal(jisuankeDifficultyToRating(d), difficultyFields('jisuanke', `level${d}`).difficulty);
    assert.equal(daimayuanDifficultyToRating(d), difficultyFields('daimayuan', d).difficulty);
  }
  // 计蒜客超档位（level9+ 实测题量 0）：未知就是未知，不再"封顶当 level8"
  assert.equal(jisuankeDifficultyToRating('level12'), null);
  assert.equal(jisuankeDifficultyToRating('level0'), null);
  assert.equal(jisuankeDifficultyToRating('others'), null);
  assert.equal(jisuankeDifficultyToRating('weird'), null);
  assert.equal(jisuankeDifficultyToRating(undefined), null);
});

// ---------- 2. 映射表只剩一份 ----------

test('映射表只存在于 shared/src/difficulty.ts（适配器内不得再有表常量）', () => {
  const dir = path.join(import.meta.dirname, '..', 'src');
  const offenders: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && /_TO_RATING\s*[:=]/.test(fs.readFileSync(p, 'utf8'))) {
        offenders.push(path.relative(dir, p));
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], '映射表必须只在 shared/src/difficulty.ts');
});

// ---------- 3. 有原生难度的平台：三字段齐发 ----------

test('CF 适配器下发原生 rating 与标度', async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        status: 'OK',
        result: [
          {
            id: 1,
            creationTimeSeconds: 1700000000,
            problem: { contestId: 1919, index: 'C', name: 'X', rating: 1900, tags: ['dp'] },
            verdict: 'OK',
            programmingLanguage: 'GNU C++20',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  const out = await createCodeforcesAdapter(fetchFn).fetchUserSubmissions('someone', { pageDelayMs: 0 });
  assert.equal(out[0]!.problem.difficulty, 1900);
  assert.equal(out[0]!.problem.nativeDifficulty, '1900');
  assert.equal(out[0]!.problem.difficultyScale, 'cf-rating');
});

test('洛谷适配器下发档位原文与标度（映射走统一表）', async () => {
  const fetchFn = router({
    'record/list': (url) =>
      new URL(url).searchParams.get('page') === '1'
        ? {
            code: 200,
            data: {
              records: {
                result: [
                  { id: 9001, status: 12, submitTime: 1700000000, language: 'C++17', problem: { pid: 'P1001', title: 'A+B Problem', difficulty: 4 } },
                  { id: 9002, status: 12, submitTime: 1699999000, language: 'C++17', problem: { pid: 'P1002', title: 'T2', difficulty: 0 } },
                ],
              },
            },
          }
        : { code: 200, data: { records: { result: [] } } },
    '_lfe/tags': () => ({ tags: [] }),
    '/problem/': () => ({ code: 200, data: { problem: { tags: [] } } }),
  });
  const rows = await createLuoguAdapter(fetchFn).fetchUserSubmissions('123', { cookie: '_uid=123', csrf: 't', pageDelayMs: 0 });
  const withDiff = rows.find((r) => r.problem.problemKey === 'P1001')!;
  assert.equal(withDiff.problem.difficulty, 1800); // 难度 4 → CF 1800（统一表）
  assert.equal(withDiff.problem.nativeDifficulty, '4');
  assert.equal(withDiff.problem.difficultyScale, 'luogu-2026-06');
  const unrated = rows.find((r) => r.problem.problemKey === 'P1002')!;
  assert.equal('difficulty' in unrated.problem, false); // 0 = 暂无评定 → 不下发
  assert.equal(unrated.problem.difficultyScale, 'luogu-2026-06');
});

test('AtCoder 适配器下发 kenkoooo 原文（θ 原文，钳位由统一模块负责）', async () => {
  const fetchFn = router({
    'atcoder-api/v3/user/submissions': () => [
      { id: 1, epoch_second: 1700000000, problem_id: 'abc321_a', contest_id: 'abc321', user_id: 'u', language: 'C++', result: 'AC' },
      { id: 2, epoch_second: 1700000001, problem_id: 'abc321_d', contest_id: 'abc321', user_id: 'u', language: 'C++', result: 'AC' },
      { id: 3, epoch_second: 1700000002, problem_id: 'abc321_b', contest_id: 'abc321', user_id: 'u', language: 'C++', result: 'AC' },
    ],
    'resources/problems.json': () => [
      { id: 'abc321_a', contest_id: 'abc321', title: 'A' },
      { id: 'abc321_b', contest_id: 'abc321', title: 'B' },
      { id: 'abc321_d', contest_id: 'abc321', title: 'D' },
    ],
    'resources/problem-models.json': () => ({
      abc321_a: { difficulty: 125 }, // 极低 θ：按首段斜率映射为 922（不再硬钳 800）
      abc321_b: { difficulty: null }, // 模型缺失 → 未知
      abc321_d: { difficulty: 1545 }, // 锚点值 → 1800
    }),
  });
  const rows = await createAtcoderAdapter(undefined, fetchFn).fetchUserSubmissions('u', { pageDelayMs: 0 });
  const byKey = new Map(rows.map((r) => [r.problem.problemKey, r.problem]));
  assert.equal(byKey.get('abc321_a')!.difficulty, 922);
  assert.equal(byKey.get('abc321_a')!.nativeDifficulty, '125'); // 原生 θ 原文，不是钳位后的 800
  assert.equal(byKey.get('abc321_a')!.difficultyScale, 'atcoder-kenkoooo-irt');
  assert.equal(byKey.get('abc321_d')!.difficulty, 1800);
  assert.equal(byKey.get('abc321_d')!.nativeDifficulty, '1545');
  assert.equal('difficulty' in byKey.get('abc321_b')!, false); // 模型缺难度 → 未知
  assert.equal(byKey.get('abc321_b')!.difficultyScale, 'atcoder-kenkoooo-irt');
});

// ---------- 4. 提交载荷无难度的平台：只给标度，不猜 ----------

test('无难度来源的平台只下发标度，不产出 difficulty 键', async () => {
  const luoguFetch = router({
    'record/list': (url) =>
      new URL(url).searchParams.get('page') === '1'
        ? { code: 200, data: { records: { result: [{ id: 1, status: 12, submitTime: 1700000000, problem: { pid: 'P1', title: 'T', difficulty: 4 } }] } } }
        : { code: 200, data: { records: { result: [] } } },
    '_lfe/tags': () => ({ tags: [] }),
    '/problem/': () => ({ code: 200, data: { problem: {} } }),
  });
  const ncHtml =
    '<table><thead><tr><th>运行ID</th><th>题目</th><th>运行结果</th><th>得分</th><th>运行时间(ms)</th><th>使用内存(KB)</th><th>代码长度</th><th>使用语言</th><th>提交时间</th></tr></thead><tbody>' +
    '<tr><td><a href="/acm/contest/view-submission?submissionId=5001&uid=1">5001</a></td>' +
    '<td><a href="/acm/problem/10001">A+B</a></td><td>答案正确</td>' +
    '<td>30</td><td>1000</td><td>0</td><td>528</td><td>C++</td><td>2026-08-02 20:29:23</td></tr></tbody></table>';
  const dmyBody = JSON.stringify({
    page: 1,
    rdocs: [{ _id: '65f0000000000000000000aa', pid: 1, status: 1, lang: 'C++', score: 100 }],
    pdict: { '1': { pid: 1, title: 'a' } },
  });

  const byPlatform = new Map<PlatformId, NormalizedProblem>();
  const push = (r: NormalizedSubmission): void => {
    byPlatform.set(r.problem.platform, r.problem);
  };

  for (const r of await createLuoguAdapter(luoguFetch).fetchUserSubmissions('1', { cookie: 'c', pageDelayMs: 0 })) push(r);
  for (const r of await createNowcoderAdapter(router({ 'contest-joined-history': () => ({ code: 0, data: { dataList: [], pageInfo: { pageCount: 0 } } }), 'submission-history': () => ({ code: 0, data: { records: [] } }), 'practice-coding': (url) => (new URL(url).searchParams.get('page') === '1' ? ncHtml : '<table></table>') })).fetchUserSubmissions('1', { pageDelayMs: 0 })) push(r);
  for (const r of await createLeetcodeAdapter(router({ '/graphql': () => ({ data: { submissionList: { hasNext: false, submissions: [{ id: '1', title: 'Two Sum', statusDisplay: 'Accepted', lang: 'cpp', timestamp: 1700000000, url: '/problems/two-sum/' }] } } }) })).fetchUserSubmissions('', { cookie: 'LEETCODE_SESSION=x; csrftoken=y', pageDelayMs: 0 })) push(r);
  for (const r of await createDaimayuanAdapter(router({ 'record?uidOrName': () => JSON.parse(dmyBody) as unknown })).fetchUserSubmissions('h', { cookie: 'sid=abc', pageDelayMs: 0 })) push(r);
  for (const r of await createJisuankeAdapter(router({
    'hasParticipated=true': () => [{ contestId: 37176, startTime: '2026-09-07 16:00:00' }],
    'api/contest/problems': () => [{ problemId: 90001, identifier: 'A', title: 'A 题' }],
    'api/contest/submissions': () => [{ hashId: 'h1', identifier: 'A', title: 'A 题', time: 1788768000, status: 'AC', language: 'c++' }],
  })).fetchUserSubmissions('nick', { cookie: 'session=x', pageDelayMs: 0 })) push(r);
  const qoj = normalizeQojRow({
    submissionId: '1', problemKey: '1000', problemUrl: 'https://qoj.ac/problem/1000',
    title: 'A', result: 'AC', timeText: '2026-01-02 03:04:05',
  });
  assert.ok(qoj);
  push(qoj);
  void createQojAdapter; // 适配器装配由 qoj.test.ts 覆盖

  assert.deepEqual(
    [...byPlatform.keys()].sort(),
    ['daimayuan', 'jisuanke', 'leetcode', 'luogu', 'nowcoder', 'qoj'],
  );
  for (const id of ['nowcoder', 'leetcode', 'daimayuan', 'jisuanke', 'qoj'] as const) {
    const p = byPlatform.get(id)!;
    assert.equal('difficulty' in p, false, `${id}: 提交载荷无难度，不得猜`);
    assert.equal('nativeDifficulty' in p, false, `${id}: 无原生难度就不写原生值`);
    assert.equal(p.difficultyScale, difficultyFields(id, null).difficultyScale);
  }
  // 洛谷（有难度来源）照常带上三字段，证明上面的断言不是"整页都没难度"
  const lg = byPlatform.get('luogu')!;
  assert.equal(lg.difficulty, 1800);
  assert.equal(lg.nativeDifficulty, '4');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAtcoderAdapter } from '../src/adapters/atcoder.ts';

function router(
  handlers: Record<string, (url: string) => unknown>,
): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        return new Response(JSON.stringify(handler(u)), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

const PROBLEMS = [
  { id: 'abc321_a', contest_id: 'abc321', title: '321-like Checker' },
  { id: 'abc321_b', contest_id: 'abc321', title: 'Cutoff' },
  { id: 'abc321_c', contest_id: 'abc321', title: '321-like Checker (Easy)' },
  { id: 'abc321_d', contest_id: 'abc321', title: 'Polygon' },
];

const MODELS = {
  abc321_a: { difficulty: 125 },
  abc321_b: { difficulty: null },
  abc321_c: { difficulty: -1152 }, // kenkoooo 对极简题给出负值
  abc321_d: { difficulty: 926.4 }, // 非整数难度（四舍五入）
};

function submission(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1001,
    epoch_second: 1700000000,
    problem_id: 'abc321_a',
    contest_id: 'abc321',
    user_id: 'u',
    language: 'C++ 23 (gcc 12.2)',
    result: 'AC',
    ...over,
  };
}

function makeAdapter(
  subHandler: (url: string) => unknown,
  cacheDir?: string,
) {
  const fetchFn = router({
    'atcoder-api/v3/user/submissions': subHandler,
    'resources/problems.json': () => PROBLEMS,
    'resources/problem-models.json': () => MODELS,
  });
  return createAtcoderAdapter(cacheDir, fetchFn);
}

test('normalizes AtCoder submissions with title/difficulty/link', async () => {
  const adapter = makeAdapter(() => [
    submission({}),
    submission({ id: 1002, problem_id: 'abc321_b', result: 'WA' }),
  ]);
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(rows.length, 2);
  const r = rows[0];
  assert.equal(r.verdict, 'AC');
  assert.equal(r.problem.problemKey, 'abc321_a');
  assert.equal(r.problem.title, '321-like Checker');
  assert.equal(r.problem.difficulty, 800); // 125 低于 CF 下限 → 钳到 800（与题库路径一致）
  assert.equal(r.problem.url, 'https://atcoder.jp/contests/abc321/tasks/abc321_a');
  assert.equal(new Date(r.submittedAt).toISOString(), new Date(1700000000 * 1000).toISOString());
  assert.equal(rows[1].verdict, 'WA');
  assert.equal('difficulty' in rows[1].problem, false); // null 难度省略
});

test('负难度钳到 CF 下限 800，非整数难度四舍五入（与题库路径一致）', async () => {
  const adapter = makeAdapter(() => [
    submission({ id: 1003, problem_id: 'abc321_c' }),
    submission({ id: 1004, problem_id: 'abc321_d' }),
  ]);
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(rows[0].problem.difficulty, 800); // -1152 → 800
  assert.equal(rows[1].problem.difficulty, 926); // 926.4 → 926
});

test('pages through 500-per-page until short page, dedupes by id', async () => {
  const calls: string[] = [];
  const adapter = makeAdapter((url) => {
    calls.push(url);
    const from = new URL(url).searchParams.get('from_second');
    if (from === '0') {
      return Array.from({ length: 500 }, (_, i) => submission({ id: i + 1 }));
    }
    return [submission({ id: 500 }), submission({ id: 501 })];
  });
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 501);
  // 第二页与第一页重复的 id 500 被去重
});

test('passes since as from_second for incremental sync', async () => {
  let requested = '';
  const adapter = makeAdapter((url) => {
    requested = url;
    return [];
  });
  await adapter.fetchUserSubmissions('u', { since: '2024-01-01T00:00:00.000Z' });
  assert.ok(requested.includes('from_second=1704067200'), requested);
});

test('caches resources to disk and skips refetch within TTL', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atcoder-cache-'));
  try {
    const adapter = makeAdapter(() => [submission({})], cacheDir);
    await adapter.fetchUserSubmissions('u');
    assert.ok(fs.existsSync(path.join(cacheDir, 'atcoder-problems.json')));
    // 再次调用：资源命中缓存，仅 user/submissions 请求发生
    let statusCalls = 0;
    const fetchFn = async (input: string | URL | Request) => {
      if (String(input).includes('user/submissions')) statusCalls += 1;
      throw new Error(`unexpected fetch: ${String(input)}`);
    };
    const adapter2 = createAtcoderAdapter(cacheDir, fetchFn);
    await assert.rejects(() => adapter2.fetchUserSubmissions('u'), /unexpected fetch: .*user\/submissions/);
    assert.equal(statusCalls, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('throws on API error object', async () => {
  const adapter = makeAdapter(() => ({ message: 'user not found' }));
  await assert.rejects(() => adapter.fetchUserSubmissions('ghost'), /user not found/);
});

test('problemUrl uses /tasks/ shortcut', () => {
  const adapter = makeAdapter(() => []);
  assert.equal(
    adapter.problemUrl({ problemKey: 'abc321_a' }),
    'https://atcoder.jp/tasks/abc321_a',
  );
});

test('maxSubmissions: stops at cap and sets opts.truncated (分批防封号)', async () => {
  // 第 1 页满 500 条，第 2 页再给若干；maxSubmissions=600 → 第 2 页拉到 100 条达上限
  let callCount = 0;
  const adapter = makeAdapter(() => {
    callCount += 1;
    if (callCount === 1) {
      return Array.from({ length: 500 }, (_, i) => submission({ id: i + 1, epoch_second: 1700000000 + i }));
    }
    // 第 2 页：从 maxSecond+1 续拉，给 200 条（拉到 100 即达 600 上限）
    return Array.from({ length: 200 }, (_, i) => submission({ id: 501 + i, epoch_second: 1700000500 + i }));
  });
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 600 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 600); // 恰好到上限
  assert.equal(opts.truncated, true);
  assert.equal(callCount, 2); // 第 3 页不应被请求
});

test('maxSubmissions: empty result before cap does NOT truncate (natural end)', async () => {
  const adapter = makeAdapter(() => [submission({ id: 1 })]);
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 500 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 1);
  assert.equal(opts.truncated, undefined); // 第 2 页空 → 自然结束不截断
});


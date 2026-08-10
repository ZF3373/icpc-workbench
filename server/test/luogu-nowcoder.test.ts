import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLuoguAdapter } from '../src/adapters/luogu.ts';
import { createNowcoderAdapter } from '../src/adapters/nowcoder.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

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

const COOKIE = '__client_id=abc; _uid=123';

// ---------- 洛谷 ----------

test('luogu: without cookie throws ManualImportRequiredError, url works', async () => {
  const adapter = createLuoguAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('uid'), ManualImportRequiredError);
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://www.luogu.com.cn/problem/P1001',
  );
});

test('luogu: with cookie normalizes records and problem info', async () => {
  const fetchFn = router({
    'record/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') {
        return { code: 200, currentData: { records: { result: [] } } };
      }
      return {
        code: 200,
        currentData: {
          records: {
            result: [
              { id: 9001, status: 2, submitTime: 1700000000000, language: 'C++17', problem: { pid: 'P1001', title: 'A+B Problem' } },
              { id: 9002, status: 3, submitTime: 1700000100000, language: 'Python3', problem: { pid: 'P1002' } },
              { id: 9003, status: 9, submitTime: 1700000200000, problem: { pid: 'P1003' } },
              { id: 9004, status: 1, submitTime: 1700000300000, problem: { pid: 'P1004' } }, // 评测中：应被过滤
            ],
          },
        },
      };
    },
    '/problem/': (url) => {
      const pid = url.includes('P1001') ? 'P1001' : url.includes('P1002') ? 'P1002' : 'P1003';
      return {
        code: 200,
        currentData: {
          problem: {
            pid,
            title: pid === 'P1001' ? 'A+B Problem' : `T ${pid}`,
            difficulty: pid === 'P1001' ? 2 : undefined,
            tags: pid === 'P1001' ? [{ name: '入门' }, { name: '模拟' }] : [],
          },
        },
      };
    },
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE, csrf: 'tok' });

  assert.equal(rows.length, 3); // 9004（评测中）被过滤
  const r0 = rows[0];
  assert.equal(r0.verdict, 'AC');
  assert.equal(r0.problem.problemKey, 'P1001');
  assert.equal(r0.problem.title, 'A+B Problem');
  assert.equal(r0.problem.difficulty, 2);
  assert.deepEqual(r0.problem.tags, ['入门', '模拟']);
  assert.equal(r0.problem.url, 'https://www.luogu.com.cn/problem/P1001');
  assert.equal(r0.externalId, '9001');
  assert.equal(new Date(r0.submittedAt).toISOString(), new Date(1700000000000).toISOString());
  assert.equal(rows[1].verdict, 'WA');
  assert.equal(rows[1].problem.title, 'T P1002'); // 题目信息接口无 difficulty 时不写入
  assert.equal('difficulty' in rows[1].problem, false);
  assert.equal(rows[2].verdict, 'SKIPPED'); // status 9 → SKIPPED
});

test('luogu: non-success code throws (cookie invalid/risk control)', async () => {
  const fetchFn = router({
    'record/list': () => ({ code: 401, message: 'invalid token' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: 'bad' }),
    /响应异常/,
  );
});

test('luogu: missing structure throws instead of silent empty', async () => {
  const fetchFn = router({
    'record/list': () => ({ code: 200 }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: 'c' }),
    /响应异常/,
  );
});

// ---------- 牛客 ----------

test('nowcoder: without cookie throws ManualImportRequiredError, url works', async () => {
  const adapter = createNowcoderAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('uid'), ManualImportRequiredError);
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://ac.nowcoder.com/acm/problem/P1001',
  );
});

test('nowcoder: with cookie normalizes submission list', async () => {
  const fetchFn = router({
    'submission/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') {
        return { code: 0, data: { list: [] } };
      }
      return {
        code: 0,
        data: {
          list: [
            { id: 5001, problemId: 10001, result: 'Accepted', submitTime: 1700000000000, language: 'C++' },
            { id: 5002, problemId: 10002, result: 'Wrong Answer', submitTime: 1700000100000, language: 'Java' },
            { problemId: 10003, result: 'Time Limit Exceeded', submitTime: 1700000200000 },
          ],
        },
      };
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].verdict, 'AC');
  assert.equal(rows[0].problem.problemKey, '10001');
  assert.equal(rows[0].problem.url, 'https://ac.nowcoder.com/acm/problem/10001');
  assert.equal(rows[0].externalId, '5001'); // 有 id 用 id
  assert.equal(rows[1].verdict, 'WA');
  assert.equal(rows[2].verdict, 'TLE');
  assert.ok(rows[2].externalId.startsWith('nc:10003:TLE:')); // 无 id 用稳定组合
});

test('nowcoder: non-success code throws (cookie invalid/risk control)', async () => {
  const fetchFn = router({
    'submission/list': () => ({ code: 401, message: 'unauthorized' }),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: 'bad' }),
    /响应异常/,
  );
});

test('manual-required error carries code MANUAL_REQUIRED', () => {
  const e = new ManualImportRequiredError('luogu', '说明');
  assert.equal(e.code, 'MANUAL_REQUIRED');
  assert.match(e.message, /luogu/);
});

test('luogu/nowcoder registered in registry', () => {
  initAdapters();
  assert.ok(getAdapter('luogu'));
  assert.ok(getAdapter('nowcoder'));
});

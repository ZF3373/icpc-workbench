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
        const v = handler(u);
        if (typeof v === 'string') return new Response(v, { status: 200 });
        if (v && typeof v === 'object' && 'status' in v && 'body' in v) {
          const r = v as { status: number; body: string };
          return new Response(r.body, { status: r.status });
        }
        return new Response(JSON.stringify(v), { status: 200 });
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

test('luogu: HTML login page (302 follow) throws clear not-logged-in error', async () => {
  const fetchFn = router({
    'record/list': () => ({ status: 200, body: '<!DOCTYPE html><html><head><title>登录</title></head><body>登录洛谷</body></html>' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: '__client_id=test; _uid=1' }),
    /未登录页面.*Cookie 无效或已过期/,
  );
});

test('luogu: 302 redirect (not logged in) throws clear login-required error', async () => {
  const fetchFn = router({
    'record/list': () => ({ status: 302, body: '' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: '__client_id=test; _uid=1' }),
    /登录跳转.*Cookie 无效或已过期/,
  );
});

// ---------- 牛客 ----------

/** 构造牛客 practice-coding 页 HTML（表头 <th> + 数据行） */
function ncPage(rows: Array<[sid: string, pid: string, title: string, result: string, lang: string, time: string]>): string {
  const trs = rows
    .map(
      ([sid, pid, title, result, lang, time]) =>
        `<tr>
          <td><a href="/acm/contest/view-submission?submissionId=${sid}&uid=123">${sid}</a></td>
          <td><a href="/acm/problem/${pid}">${title}</a></td>
          <td><span>${result}</span></td>
          <td>30</td><td>1000</td><td>0</td><td>528</td>
          <td>${lang}</td><td>${time}</td>
        </tr>`,
    )
    .join('');
  return `<table><thead><tr><th>运行ID</th><th>题目</th><th>运行结果</th><th>得分</th><th>运行时间(ms)</th><th>使用内存(KB)</th><th>代码长度</th><th>使用语言</th><th>提交时间</th></tr></thead><tbody>${trs}</tbody></table>`;
}

test('nowcoder: parses practice-coding HTML without cookie, url works', async () => {
  const fetchFn = router({
    'practice-coding': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') return ncPage([]); // 第二页空 → 停止
      return ncPage([
        ['5001', '10001', 'A+B', '答案正确', 'C++', '2026-08-02 20:29:23'],
        ['5002', '10002', 'B+C', '答案错误', 'Java', '2026-08-02 20:20:00'],
        ['5003', '10003', 'C+D', '运行超时', 'Python', '2026-08-02 19:59:55'],
      ]);
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  // 无需 cookie（公开页面）
  const rows = await adapter.fetchUserSubmissions('100000002', {});

  assert.equal(rows.length, 3);
  assert.equal(rows[0].verdict, 'AC');
  assert.equal(rows[0].problem.problemKey, '10001');
  assert.equal(rows[0].problem.title, 'A+B');
  assert.equal(rows[0].problem.url, 'https://ac.nowcoder.com/acm/problem/10001');
  assert.equal(rows[0].externalId, '5001');
  assert.equal(rows[0].language, 'C++');
  assert.equal(rows[0].submittedAt, '2026-08-02T12:29:23.000Z'); // +08:00 → UTC
  assert.equal(rows[1].verdict, 'WA');
  assert.equal(rows[2].verdict, 'TLE');
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://ac.nowcoder.com/acm/problem/P1001',
  );
});

test('nowcoder: incremental sync stops when page is older than since', async () => {
  const fetchFn = router({
    'practice-coding': () =>
      ncPage([['5001', '10001', 'A+B', '答案正确', 'C++', '2026-08-01 10:00:00']]),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  // since 晚于页内最早提交 → 首条已旧 → 停止，返回空
  const rows = await adapter.fetchUserSubmissions('100000002', {
    since: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(rows.length, 0);
});

test('nowcoder: HTTP failure throws', async () => {
  const fetchFn = router({
    'practice-coding': () => ({ status: 403, body: '<html>blocked</html>' }),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('100000002', {}),
    /HTTP 403/,
  );
});

test('nowcoder: first page with no rows throws (structure changed / risk control)', async () => {
  const fetchFn = router({
    'practice-coding': () => ncPage([]),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('100000002', {}),
    /未解析到提交记录/,
  );
});

test('nowcoder: unknown result maps to SKIPPED, short rows skipped', async () => {
  const html =
    '<table><tbody>' +
    // 正常行：未知状态
    '<tr><td><a href="/acm/contest/view-submission?submissionId=6001&uid=1">6001</a></td>' +
    '<td><a href="/acm/problem/20001">X</a></td><td>系统异常状态</td><td>0</td><td>1</td><td>2</td><td>3</td><td>C++</td><td>2026-08-01 10:00:00</td></tr>' +
    // 异常行：仅 8 列（缺提交时间）→ 应跳过不崩溃
    '<tr><td><a href="/acm/contest/view-submission?submissionId=6002&uid=1">6002</a></td>' +
    '<td><a href="/acm/problem/20002">Y</a></td><td>答案正确</td><td>0</td><td>1</td><td>2</td><td>3</td><td>C++</td></tr>' +
    '</tbody></table>';
  const fetchFn = router({
    'practice-coding': (url) => {
      const page = new URL(url).searchParams.get('page');
      return page === '1' ? html : ncPage([]);
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('100000002', {});
  assert.equal(rows.length, 1); // 6002（8 列异常行）被跳过
  assert.equal(rows[0].externalId, '6001');
  assert.equal(rows[0].verdict, 'SKIPPED'); // 未知状态 → SKIPPED
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

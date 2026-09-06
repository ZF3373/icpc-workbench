import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaimayuanAdapter, parseUojSubmissionRows } from '../src/adapters/daimayuan.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/** 按 UOJ echoSubmission 的列顺序渲染一行提交（10 列） */
function uojRow(o: {
  id: number;
  pid: number;
  title: string;
  /** result 单元格内容 */
  result: string;
  time?: string;
  language?: string;
}): string {
  return `<tr>
<td><a href="/submission/${o.id}">#${o.id}</a></td>
<td><a href="/problem/${o.pid}">#${o.pid}. ${o.title}</a></td>
<td><a href="/user/profile/tester" class="uoj-username">tester</a></td>
<td>${o.result}</td>
<td>26ms</td>
<td>4096kb</td>
<td><a href="/submission/${o.id}">${o.language ?? 'C++17'}</a></td>
<td>521b</td>
<td><small>${o.time ?? '2026-09-01 10:00:00'}</small></td>
<td><small>2026-09-01 10:00:05</small></td>
</tr>`;
}

const scoreCell = (id: number, score: number): string =>
  `<a href="/submission/${id}" class="uoj-score">${score}</a>`;
const textCell = (id: number, text: string): string =>
  `<a href="/submission/${id}" class="small">${text}</a>`;

/** UOJ 空表占位（echoLongTable isEmpty 分支） */
const EMPTY_TABLE = '<table class="table"><tbody><tr><td colspan="233">无</td></tr></tbody></table>';

function page(rows: string[]): string {
  return `<div class="table-responsive"><table><thead></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function router(
  pages: Record<string, string | (() => string)>,
  opts: { status?: number; seenHeaders?: Record<string, string>[] } = {},
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.seenHeaders) opts.seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    const u = String(input);
    for (const [key, value] of Object.entries(pages)) {
      if (u.includes(key)) return new Response(typeof value === 'function' ? value() : value, { status: opts.status ?? 200 });
    }
    return new Response(EMPTY_TABLE, { status: opts.status ?? 200 });
  };
}

const COOKIE = 'uoj_username=tester; uoj_remember_token=tok123';

// ---------- 解析 ----------

test('daimayuan: parseUojSubmissionRows extracts id/problem/result/time', () => {
  const html = page([
    uojRow({ id: 101, pid: 1052, title: 'Two Pointers', result: scoreCell(101, 100) }),
    uojRow({ id: 102, pid: 1001, title: 'A+B Problem', result: scoreCell(102, 70) }),
    uojRow({ id: 103, pid: 1002, title: '编译失败', result: textCell(103, 'Compile Error') }),
    uojRow({ id: 104, pid: 1003, title: '评测中', result: textCell(104, 'Judging') }),
  ]);
  const rows = parseUojSubmissionRows(html);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].submissionId, '101');
  assert.equal(rows[0].pid, '1052');
  assert.equal(rows[0].title, 'Two Pointers'); // "#1052. " 前缀被剥离
  assert.deepEqual(rows[0].result, { kind: 'score', score: 100 });
  assert.deepEqual(rows[1].result, { kind: 'score', score: 70 });
  assert.deepEqual(rows[2].result, { kind: 'text', text: 'Compile Error' });
  assert.deepEqual(rows[3].result, { kind: 'text', text: 'Judging' });
});

test('daimayuan: status_details 展开行 / 表头行被跳过', () => {
  const html = `<table><tbody>
<tr><td colspan="233">status details row</td></tr>
${uojRow({ id: 1, pid: 1, title: 'x', result: scoreCell(1, 100) })}
</tbody></table>`;
  assert.equal(parseUojSubmissionRows(html).length, 1);
});

// ---------- fetchUserSubmissions ----------

test('daimayuan: without cookie throws ManualImportRequiredError', async () => {
  const adapter = createDaimayuanAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('tester'), ManualImportRequiredError);
});

test('daimayuan: fetch maps verdicts, skips judging, builds urls', async () => {
  const fetchFn = router({
    'submitter=tester&page=1': page([
      uojRow({ id: 201, pid: 1052, title: 'Two Pointers', result: scoreCell(201, 100), time: '2026-09-01 18:00:00' }),
      uojRow({ id: 202, pid: 1001, title: 'A+B', result: scoreCell(202, 0) }),
      uojRow({ id: 203, pid: 1002, title: 'CE', result: textCell(203, 'Compile Error') }),
      uojRow({ id: 204, pid: 1003, title: '评测中', result: textCell(204, 'Waiting') }),
    ]),
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('tester', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 3); // Waiting 跳过
  assert.equal(subs[0].verdict, 'AC');
  assert.equal(subs[0].problem.problemKey, '1052');
  assert.equal(subs[0].problem.url, 'http://oj.daimayuan.top/problem/1052');
  assert.equal(subs[0].language, 'C++17');
  assert.equal(subs[0].externalId, '201');
  // 北京时间 18:00 → UTC 10:00
  assert.equal(subs[0].submittedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(subs[1].verdict, 'WA'); // 0 分 = 未满分 WA
  assert.equal(subs[2].verdict, 'CE');
});

test('daimayuan: full-page known ids stops pagination (增量提前终止)', async () => {
  let page2Fetched = false;
  const fetchFn = router({
    'submitter=tester&page=1': page([uojRow({ id: 301, pid: 1, title: 'a', result: scoreCell(301, 100) })]),
    'submitter=tester&page=2': () => {
      page2Fetched = true;
      return page([uojRow({ id: 299, pid: 1, title: 'b', result: scoreCell(299, 100) })]);
    },
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('tester', {
    cookie: COOKIE,
    knownExternalIds: new Set(['301']),
    pageDelayMs: 0,
  });
  assert.equal(page2Fetched, false);
  assert.equal(subs.length, 0);
});

test('daimayuan: known rows skipped, unknown rows appended across pages', async () => {
  // 第 1 页满页 10 条：401 未知 + 402-410 已知 → 不满足整页已知终止，继续翻页；
  // 第 2 页只有 1 条新记录（不足一页 → 最后一页）
  const page1 = [
    uojRow({ id: 401, pid: 1, title: 'new-401', result: scoreCell(401, 100) }),
    ...Array.from({ length: 9 }, (_, i) =>
      uojRow({ id: 402 + i, pid: 1, title: `old-${402 + i}`, result: scoreCell(402 + i, 100) }),
    ),
  ];
  const fetchFn = router({
    'submitter=tester&page=1': page(page1),
    'submitter=tester&page=2': page([uojRow({ id: 399, pid: 1, title: 'new-399', result: scoreCell(399, 100) })]),
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('tester', {
    cookie: COOKIE,
    knownExternalIds: new Set(['402', '403', '404', '405', '406', '407', '408', '409', '410']),
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), ['401', '399']);
});

test('daimayuan: expired login (403 / login page) raises ManualImportRequiredError', async () => {
  const adapter403 = createDaimayuanAdapter(router({}, { status: 403 }));
  await assert.rejects(
    () => adapter403.fetchUserSubmissions('tester', { cookie: 'stale', pageDelayMs: 0 }),
    /登录态已失效/,
  );
  const adapterLogin = createDaimayuanAdapter(
    router({ 'submitter=tester': '<html><a href="/login">登录</a></html>' }),
  );
  await assert.rejects(
    () => adapterLogin.fetchUserSubmissions('tester', { cookie: 'stale', pageDelayMs: 0 }),
    ManualImportRequiredError,
  );
});

test('daimayuan: sends cookie header and HTTP base url', async () => {
  const seen: Record<string, string>[] = [];
  const fetchFn = router({ 'submitter=tester&page=1': EMPTY_TABLE }, { seenHeaders: seen });
  const adapter = createDaimayuanAdapter(fetchFn);
  await adapter.fetchUserSubmissions('tester', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(seen[0].Cookie, COOKIE);
});

// ---------- checkAuth / 注册 ----------

test('daimayuan: checkAuth validates via /submissions access', async () => {
  const ok = createDaimayuanAdapter(router({ '/submissions': page([uojRow({ id: 1, pid: 1, title: 'a', result: scoreCell(1, 100) })]) }));
  const rOk = await ok.checkAuth!({ cookie: COOKIE });
  assert.equal(rOk.ok, true);

  const bad = createDaimayuanAdapter(router({}, { status: 403 }));
  const rBad = await bad.checkAuth!({ cookie: 'stale' });
  assert.equal(rBad.ok, false);
  assert.match(rBad.message, /Cookie 无效或已过期/);

  const netFail = createDaimayuanAdapter((async () => {
    throw new Error('fetch failed');
  }) as typeof fetch);
  const rNet = await netFail.checkAuth!({ cookie: 'c' });
  assert.equal(rNet.ok, false);
  assert.match(rNet.message, /无法连接/);
});

test('daimayuan: registered via initAdapters, problemUrl format', () => {
  initAdapters();
  assert.equal(getAdapter('daimayuan')?.platform, 'daimayuan');
  const adapter = createDaimayuanAdapter();
  assert.equal(adapter.problemUrl({ problemKey: '1052' }), 'http://oj.daimayuan.top/problem/1052');
});

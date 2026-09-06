import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaimayuanAdapter, parseDaimayuanRows } from '../src/adapters/daimayuan.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/** 按 Hydro record_main_tr.html 渲染一行提交（7 列，tr 带 data-rid） */
function hydroRow(o: {
  rid: string;
  pid: number;
  title: string;
  /** 结果单元格文本（含/不含前导分数均可） */
  result: string;
  ts: number;
  language?: string;
}): string {
  return `<tr data-rid="${o.rid}">
<td class="col--status record-status--border pass"><div class="col--status__text"><span class="icon record-status--icon pass"></span><a href="/record/${o.rid}" class="record-status--text pass">${o.result}</a></div></td>
<td class="col--problem col--problem-name"><a href="/p/${o.pid}"><b>${o.pid}</b>&nbsp;&nbsp;${o.title}</a></td>
<td class="col--submit-by"><a href="/user/profile/5441" class="uoj-username">hieZF1123</a></td>
<td class="col--time">10ms</td>
<td class="col--memory">760 KiB</td>
<td class="col--lang"><a href="/record/${o.rid}">${o.language ?? 'C++23(O2)'}</a></td>
<td class="col--submit-at"><span class="time relative" data-timestamp="${o.ts}">1 分钟前</span></td>
</tr>`;
}

const EMPTY_PAGE = '<form method="get"><input name="uidOrName" type="text">no tasks that match the filter</form>';

function page(rows: string[]): string {
  return `<div class="section__body no-padding"><table class="data-table record_main__table"><tbody>${rows.join('')}</tbody></table></div>`;
}

function router(
  pages: Record<string, string | (() => string)>,
  opts: { status?: number; location?: string; seenHeaders?: Record<string, string>[] } = {},
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.seenHeaders) opts.seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    const u = String(input);
    for (const [key, value] of Object.entries(pages)) {
      if (u.includes(key)) {
        if (opts.status === 302) return new Response('', { status: 302, headers: { location: opts.location ?? '/login' } });
        return new Response(typeof value === 'function' ? value() : value, { status: 200 });
      }
    }
    return new Response(EMPTY_PAGE, { status: 200 });
  };
}

const COOKIE = 'sid=s-session-token';

// ---------- 解析 ----------

test('daimayuan: parseDaimayuanRows extracts rid/problem/status/time', () => {
  const html = page([
    hydroRow({ rid: '6a1', pid: 7, title: '[R2A]三人组队', result: '100 Accepted', ts: 1788768000 }),
    hydroRow({ rid: '6a2', pid: 7, title: '[R2A]三人组队', result: '0 Compile Error', ts: 1788767940 }),
    hydroRow({ rid: '6a3', pid: 8, title: '两数之和', result: 'Wrong Answer', ts: 1788767880 }),
    hydroRow({ rid: '6a4', pid: 9, title: '评测中', result: 'Running', ts: 1788767820 }),
  ]);
  const rows = parseDaimayuanRows(html);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].recordId, '6a1');
  assert.equal(rows[0].pid, '7');
  assert.equal(rows[0].title, '[R2A]三人组队'); // "<b>7</b>&nbsp;&nbsp;" 前缀被剥离
  assert.equal(rows[0].statusText, 'Accepted'); // 前导分数剥离
  assert.equal(rows[1].statusText, 'Compile Error');
  assert.equal(rows[2].statusText, 'Wrong Answer'); // 无分数行原样保留
  assert.equal(rows[0].timeSec, 1788768000);
  assert.equal(rows[0].language, 'C++23(O2)');
});

test('daimayuan: rows without /p/ link or data-timestamp are skipped', () => {
  const html = `<table><tbody>
<tr data-rid="x"><td>100 Accepted</td><td>*</td><td>u</td><td>-</td><td>-</td><td>cpp</td><td></td></tr>
${hydroRow({ rid: 'ok', pid: 1, title: 'a', result: '100 Accepted', ts: 1000 })}
</tbody></table>`;
  assert.equal(parseDaimayuanRows(html).length, 1);
});

// ---------- fetchUserSubmissions ----------

test('daimayuan: without cookie throws ManualImportRequiredError', async () => {
  const adapter = createDaimayuanAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('hieZF1123'), ManualImportRequiredError);
});

test('daimayuan: fetch maps verdicts, skips judging, builds urls and ISO time', async () => {
  const fetchFn = router({
    'uidOrName=hieZF1123&page=1': page([
      hydroRow({ rid: 'r1', pid: 7, title: '[R2A]三人组队', result: '100 Accepted', ts: 1788768000 }),
      hydroRow({ rid: 'r2', pid: 7, title: '[R2A]三人组队', result: '0 Compile Error', ts: 1788767940 }),
      hydroRow({ rid: 'r3', pid: 8, title: 'TLE 题', result: '30 Time Exceeded', ts: 1788767880 }),
      hydroRow({ rid: 'r4', pid: 9, title: '评测中', result: 'Waiting', ts: 1788767820 }),
    ]),
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('hieZF1123', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 3); // Waiting 跳过
  assert.equal(subs[0].verdict, 'AC');
  assert.equal(subs[0].problem.problemKey, '7');
  assert.equal(subs[0].problem.url, 'https://bs.daimayuan.top/p/7');
  assert.equal(subs[0].language, 'C++23(O2)');
  assert.equal(subs[0].externalId, 'r1');
  assert.equal(subs[0].submittedAt, '2026-09-07T08:00:00.000Z'); // data-timestamp 秒 → ISO
  assert.equal(subs[1].verdict, 'CE');
  assert.equal(subs[2].verdict, 'TLE'); // 非满分超时按状态文本映射
});

test('daimayuan: full-page known ids stops pagination (增量提前终止)', async () => {
  let page2Fetched = false;
  const fetchFn = router({
    'uidOrName=h&page=1': page([hydroRow({ rid: 'k1', pid: 1, title: 'a', result: '100 Accepted', ts: 10 })]),
    'uidOrName=h&page=2': () => {
      page2Fetched = true;
      return page([hydroRow({ rid: 'k0', pid: 1, title: 'b', result: '100 Accepted', ts: 5 })]);
    },
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', {
    cookie: COOKIE,
    knownExternalIds: new Set(['k1']),
    pageDelayMs: 0,
  });
  assert.equal(page2Fetched, false);
  assert.equal(subs.length, 0);
});

test('daimayuan: known rows skipped, unknown appended across pages (满页才翻页)', async () => {
  // 第 1 页满页 100 条：r100 未知 + 99 条已知 → 继续翻页；第 2 页 1 条新记录（不足一页 → 最后一页）
  const page1 = [
    hydroRow({ rid: 'r100', pid: 1, title: 'new-100', result: '100 Accepted', ts: 2000 }),
    ...Array.from({ length: 99 }, (_, i) =>
      hydroRow({ rid: `old-${99 - i}`, pid: 1, title: `old-${99 - i}`, result: '100 Accepted', ts: 1999 - i }),
    ),
  ];
  const fetchFn = router({
    'uidOrName=h&page=1': page(page1),
    'uidOrName=h&page=2': page([hydroRow({ rid: 'r0', pid: 1, title: 'new-0', result: '100 Accepted', ts: 1 })]),
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', {
    cookie: COOKIE,
    knownExternalIds: new Set(Array.from({ length: 99 }, (_, i) => `old-${99 - i}`)),
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), ['r100', 'r0']);
});

test('daimayuan: expired login (302 / login page) raises ManualImportRequiredError', async () => {
  const adapter302 = createDaimayuanAdapter(
    router({ 'uidOrName=h': EMPTY_PAGE }, { status: 302, location: '/login?redirect=%2Frecord' }),
  );
  await assert.rejects(
    () => adapter302.fetchUserSubmissions('h', { cookie: 'stale', pageDelayMs: 0 }),
    /登录态已失效/,
  );
  const adapterLogin = createDaimayuanAdapter(
    router({ 'uidOrName=h': '<html><a href="/login">登录</a></html>' }),
  );
  await assert.rejects(
    () => adapterLogin.fetchUserSubmissions('h', { cookie: 'stale', pageDelayMs: 0 }),
    ManualImportRequiredError,
  );
});

test('daimayuan: empty first page with table = 0 records (valid), sends cookie header', async () => {
  const seen: Record<string, string>[] = [];
  const fetchFn = router({ 'uidOrName=h&page=1': EMPTY_PAGE }, { seenHeaders: seen });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 0);
  assert.equal(seen[0].Cookie, COOKIE);
  // 无表格的空页视为结构变化
  const broken = createDaimayuanAdapter(router({ 'uidOrName=h&page=1': '<html>unexpected</html>' }));
  await assert.rejects(() => broken.fetchUserSubmissions('h', { cookie: COOKIE, pageDelayMs: 0 }), /页面结构变化/);
});

// ---------- checkAuth / 注册 ----------

test('daimayuan: checkAuth validates via /record access', async () => {
  const ok = createDaimayuanAdapter(
    router({ '/record': page([hydroRow({ rid: '1', pid: 1, title: 'a', result: '100 Accepted', ts: 1 })]) }),
  );
  const rOk = await ok.checkAuth!({ cookie: COOKIE });
  assert.equal(rOk.ok, true);

  const bad = createDaimayuanAdapter(router({ '/record': EMPTY_PAGE }, { status: 302 }));
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
  assert.equal(adapter.problemUrl({ problemKey: '7' }), 'https://bs.daimayuan.top/p/7');
});

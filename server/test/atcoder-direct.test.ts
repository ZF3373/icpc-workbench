import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAtcoderAdapter } from '../src/adapters/atcoder.ts';
import { parseOwnSubmissionsHtml, type KenkoooSubmission } from '../src/adapters/atcoderDirect.ts';
import type { FetchOptions } from '../src/adapters/types.ts';

// ---------- 解析器（纯函数） ----------

const PAGE_HTML = `
<html><head><title>My Submissions - AtCoder Beginner Contest 478</title></head><body>
<table>
<tr><th>Submission Time</th><th>Task</th></tr>
<tr>
<td class="text-center"><time class="submission-time" title="2026-10-06T11:44:02+0900">2026-10-06 11:44:02+0900</time></td>
<td><a href="/contests/abc478/tasks/abc478_d">D - Range Set Insertion Query</a></td>
<td class="text-center"><a href="/users/hieZF123">hieZF123</a><span>(湛蓝)</span></td>
<td class="text-center">C++23 (GCC 15.2.0)</td>
<td class="text-center">400</td>
<td class="text-right">931 Byte</td>
<td class="text-center"><span class="label label-success" data-toggle="tooltip" title="Accepted">AC</span></td>
<td class="text-right">197 ms</td>
<td class="text-right">24432 KiB</td>
<td class="text-center"><a href="/contests/abc478/submissions/79730001">Detail</a></td>
</tr>
<tr>
<td class="text-center"><time class="submission-time">2026-10-03 20:46:19+0900</time></td>
<td><a href="/contests/abc478/tasks/abc478_d">D - Range Set Insertion Query</a></td>
<td class="text-center"><a href="/users/hieZF123">hieZF123</a></td>
<td class="text-center">C++23 (GCC 15.2.0)</td>
<td class="text-center">0</td>
<td class="text-right">300 Byte</td>
<td class="text-center"><span class="label label-warning">TLE</span></td>
<td class="text-right">&gt;2000 ms</td>
<td class="text-right">&gt;1048576 KiB</td>
<td class="text-center"><a href="/contests/abc478/submissions/79727830">Detail</a></td>
</tr>
</table>
<table><tr><td class="text-center"> standings 行：无 Detail 链接，必须被忽略 </td></tr></table>
</body></html>`;

test('parseOwnSubmissionsHtml: 提取提交号/时刻/题号/语言/判定，忽略无 Detail 链接的表格行', () => {
  const rows = parseOwnSubmissionsHtml(PAGE_HTML);
  assert.equal(rows.length, 2);
  const [latest, old] = rows;
  assert.equal(latest!.id, 79730001);
  assert.equal(latest!.contest_id, 'abc478');
  assert.equal(latest!.problem_id, 'abc478_d');
  assert.equal(latest!.language, 'C++23 (GCC 15.2.0)');
  assert.equal(latest!.result, 'AC');
  assert.equal(latest!.user_id, 'hieZF123');
  // title 属性带 +0900 时区：2026-10-06T11:44:02+0900 == 02:44:02Z
  assert.equal(latest!.epoch_second, Date.parse('2026-10-06T02:44:02.000Z') / 1000);
  // 第二行没有 title 属性，回退到 <time> 文本（空格分隔 + 无冒号时区）也要解析成功
  assert.equal(old!.id, 79727830);
  assert.equal(old!.result, 'TLE');
  assert.equal(old!.epoch_second, Date.parse('2026-10-03T11:46:19.000Z') / 1000);
});

test('parseOwnSubmissionsHtml: HTML 实体被正确反解码（&gt; 回归）', () => {
  /**
   * decodeEntities 曾把 `&gt;` 写成 `>`（自替换空操作），于是 `&gt;` 原样进入
   * language/result；判定文本带实体时还会匹配不上 RESULT_MAP、静默降级成 SKIPPED。
   * 这里用与官方页面同款的 `&gt;` 形态回归。
   */
  const html = `<html><body><table>
<tr>
<td class="text-center"><time class="submission-time" title="2026-10-06T11:44:02+0900">t</time></td>
<td><a href="/contests/abc478/tasks/abc478_d">D</a></td>
<td><a href="/users/u">u</a></td>
<td class="text-center">C&#43;&#43;23 &gt;=17</td>
<td class="text-center">0</td>
<td class="text-right">300 Byte</td>
<td class="text-center"><span class="label label-warning">TLE</span></td>
<td class="text-right">&gt;2000 ms</td>
<td class="text-right">&gt;1048576 KiB</td>
<td class="text-center"><a href="/contests/abc478/submissions/1">Detail</a></td>
</tr></table></body></html>`;
  const rows = parseOwnSubmissionsHtml(html);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.ok(!String(row.language).includes('&gt;'), `language 残留实体: ${row.language}`);
  assert.ok(String(row.language).includes('>='), `language 未解码: ${row.language}`);
  assert.ok(!String(row.result).includes('&gt;'), `result 残留实体: ${row.result}`);
  // 判定单元格（第 7 列）是 TLE，必须仍能映射成 TLE 而不是因实体失配降级
  assert.equal(row.result, 'TLE');
});

// ---------- 适配器接入（cookie 注入 / 合并 / 降级 / 翻页） ----------

const PROBLEMS = [{ id: 'abc478_d', contest_id: 'abc478', title: 'Range Set Insertion Query' }];

function rowOf(id: number, user = 'hieZF123', result = 'AC'): string {
  return `<tr>
<td class="text-center"><time class="submission-time" title="2026-10-06T11:44:02+0900">2026-10-06 11:44:02+0900</time></td>
<td><a href="/contests/abc478/tasks/abc478_d">D - Range Set Insertion Query</a></td>
<td class="text-center"><a href="/users/${user}">${user}</a></td>
<td class="text-center">C++23 (GCC 15.2.0)</td>
<td class="text-center">400</td><td class="text-right">931 Byte</td>
<td class="text-center"><span class="label label-success">AC</span></td>
<td class="text-right">197 ms</td><td class="text-right">24432 KiB</td>
<td class="text-center"><a href="/contests/abc478/submissions/${id}">Detail</a></td>
</tr>`;
}

function pageHtml(rows: string[], loggedIn = true): string {
  if (!loggedIn) {
    return '<html><head><meta property="og:title" content="Sign In - AtCoder" /></head><body>login form</body></html>';
  }
  return `<html><body><table>${rows.join('\n')}</table></body></html>`;
}

interface MockCall {
  url: string;
  cookie?: string;
}

/** kenkoooo 路由 + atcoder.jp own-submissions 路由的 mock fetch（记录请求头供断言） */
function makeFetch(opts: {
  kenkooooRows?: KenkoooSubmission[];
  pages: string[]; // 按请求次序返回的 own-submissions HTML；超出范围返回空表
  atcoderStatus?: number;
}) {
  const calls: MockCall[] = [];
  let atcoderRequests = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, cookie: headers.cookie });
    if (url.includes('kenkoooo.com')) {
      if (url.includes('/resources/')) {
        const body = url.includes('problems.json')
          ? JSON.stringify(PROBLEMS)
          : JSON.stringify({});
        return new Response(body, { status: 200 });
      }
      return new Response(JSON.stringify(opts.kenkooooRows ?? []), { status: 200 });
    }
    // atcoder.jp own-submissions
    const idx = atcoderRequests;
    atcoderRequests += 1;
    if (opts.atcoderStatus !== undefined) {
      return new Response('error', { status: opts.atcoderStatus });
    }
    const html = opts.pages[idx] ?? pageHtml([]);
    return new Response(html, { status: 200 });
  };
  return {
    fetchFn,
    calls,
    atcoderUrls: () => calls.map((c) => c.url).filter((u) => u.includes('atcoder.jp')),
  };
}

async function makeAdapter(fetchFn: typeof fetch) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atcoder-direct-'));
  const adapter = createAtcoderAdapter(cacheDir, fetchFn);
  return { adapter, cleanup: () => fs.rmSync(cacheDir, { recursive: true, force: true }) };
}

test('配置 Cookie 时直连扫描 own-submissions，新行入库、已入库行跳过', async () => {
  const { fetchFn, calls } = makeFetch({
    pages: [pageHtml([rowOf(79730001), rowOf(79727830, 'hieZF123', 'TLE')])],
  });
  const { adapter, cleanup } = await makeAdapter(fetchFn);
  try {
    const opts: FetchOptions = {
      cookie: 'REVEL_SESSION=s3cret',
      knownExternalIds: new Set(['79727830']),
      knownProblemKeys: new Map([['79727830', 'abc478_d']]),
      pageDelayMs: 0,
    };
    const rows = await adapter.fetchUserSubmissions('hieZF123', opts);
    // kenkoooo 返回空（未收录），直连补上新提交；已入库的 79727830 不重发
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.externalId, '79730001');
    assert.equal(rows[0]!.verdict, 'AC');
    assert.equal(rows[0]!.problem.problemKey, 'abc478_d');
    assert.equal(rows[0]!.problem.title, 'Range Set Insertion Query');
    assert.equal(rows[0]!.submittedAt, '2026-10-06T02:44:02.000Z');
    // 登录态送到了 atcoder.jp
    const atcoderCalls = calls.filter((c) => c.url.includes('atcoder.jp'));
    assert.ok(atcoderCalls.length >= 1);
    assert.equal(atcoderCalls[0]!.cookie, 'REVEL_SESSION=s3cret');
    assert.equal(opts.directScanAdded, 1);
    assert.equal(opts.directScanNote, undefined);
  } finally {
    cleanup();
  }
});

test('未配置 Cookie 时零直连请求（行为与旧版完全一致）', async () => {
  const { fetchFn, calls } = makeFetch({ pages: [] });
  const { adapter, cleanup } = await makeAdapter(fetchFn);
  try {
    const rows = await adapter.fetchUserSubmissions('hieZF123', {});
    assert.equal(rows.length, 0);
    assert.equal(calls.filter((c) => c.url.includes('atcoder.jp')).length, 0);
  } finally {
    cleanup();
  }
});

test('Cookie 失效（登录墙）只降级为 note，不拖垮镜像同步', async () => {
  const { fetchFn } = makeFetch({ pages: [pageHtml([], false)] });
  const { adapter, cleanup } = await makeAdapter(fetchFn);
  try {
    const opts: FetchOptions = {
      cookie: 'REVEL_SESSION=expired',
      knownProblemKeys: new Map([['79727830', 'abc478_d']]),
      pageDelayMs: 0,
    };
    const rows = await adapter.fetchUserSubmissions('hieZF123', opts);
    assert.equal(rows.length, 0);
    assert.match(opts.directScanNote ?? '', /Cookie 已失效/);
  } finally {
    cleanup();
  }
});

test('Cookie 贴错账号槽位：归属不符的行被丢弃并提示', async () => {
  const { fetchFn } = makeFetch({ pages: [pageHtml([rowOf(79730001, 'someoneElse')])] });
  const { adapter, cleanup } = await makeAdapter(fetchFn);
  try {
    const opts: FetchOptions = {
      cookie: 'REVEL_SESSION=s3cret',
      knownProblemKeys: new Map([['79727830', 'abc478_d']]),
      pageDelayMs: 0,
    };
    const rows = await adapter.fetchUserSubmissions('hieZF123', opts);
    assert.equal(rows.length, 0, '别人的提交绝不能挂到本账号');
    assert.match(opts.directScanNote ?? '', /归属不符/);
  } finally {
    cleanup();
  }
});

test('整页都是新行才翻页；页内全已知即停', async () => {
  const page1 = Array.from({ length: 20 }, (_, i) => rowOf(80000000 - i));
  const page2 = Array.from({ length: 20 }, (_, i) => rowOf(70000000 - i)); // 全部已入库
  const { fetchFn, calls } = makeFetch({ pages: [pageHtml(page1), pageHtml(page2)] });
  const { adapter, cleanup } = await makeAdapter(fetchFn);
  try {
    const known = new Set(Array.from({ length: 20 }, (_, i) => String(70000000 - i)));
    const opts: FetchOptions = {
      cookie: 'REVEL_SESSION=s3cret',
      knownExternalIds: known,
      knownProblemKeys: new Map([...known].map((id) => [id, 'abc478_d'])),
      pageDelayMs: 0,
    };
    const rows = await adapter.fetchUserSubmissions('hieZF123', opts);
    assert.equal(rows.length, 20, '第 1 页的 20 条新行全部入库');
    const atcoderCalls = calls.filter((c) => c.url.includes('atcoder.jp'));
    assert.equal(atcoderCalls.length, 2, '第 2 页全已知后不再请求第 3 页');
    assert.ok(atcoderCalls[1]!.url.includes('page=2'));
  } finally {
    cleanup();
  }
});

test('直连请求被风控（429）时中止本轮直连扫描，镜像结果不受影响', async () => {
  const { fetchFn } = makeFetch({ pages: [], atcoderStatus: 429 });
  const { adapter, cleanup } = await makeAdapter(fetchFn);
  try {
    const opts: FetchOptions = {
      cookie: 'REVEL_SESSION=s3cret',
      knownProblemKeys: new Map([['79727830', 'abc478_d']]),
      pageDelayMs: 0,
    };
    const rows = await adapter.fetchUserSubmissions('hieZF123', opts);
    assert.equal(rows.length, 0);
    assert.match(opts.directScanNote ?? '', /防风控/);
  } finally {
    cleanup();
  }
});

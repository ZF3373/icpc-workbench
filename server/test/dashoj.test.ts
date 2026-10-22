import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashojAdapter, objectIdToTimestamp, isLoginRedirect, parseDashojJson, submissionTimeIso } from '../src/adapters/dashoj.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/**
 * DashOJ 适配器测试（Hydro JSON 模式，与代码源同结构）。
 * 差异：记录页对游客开放（无需 Cookie）；rdoc 直接带 judgeAt（ISO8601 UTC）。
 *   /record?uidOrName=...&page=N + Accept:application/json →
 *   { page, rdocs: [{_id, pid, status, lang, score?, judgeAt?}], pdict: {pid:{pid,title}} }
 */

function oidPrefix(ts: number): string {
  return ts.toString(16).padStart(8, '0');
}
function oid(ts: number, suffix: string): string {
  return `${oidPrefix(ts)}${suffix.padEnd(16, '0').slice(0, 16)}`;
}

/** Hydro STATUS 数字枚举（见 @hydrooj/common/status.ts） */
const ST = {
  WAITING: 0, ACCEPTED: 1, WRONG_ANSWER: 2, TIME_EXCEEDED: 3, MEMORY_EXCEEDED: 4,
  OUTPUT_EXCEEDED: 5, RUNTIME_ERROR: 6, COMPILE_ERROR: 7, SYSTEM_ERROR: 8,
  CANCELED: 9, ETC: 10, HACKED: 11, JUDGING: 20, COMPILING: 21, FETCHED: 22,
  IGNORED: 30, FORMAT_ERROR: 31, HACK_SUCCESSFUL: 32, HACK_UNSUCCESSFUL: 33,
} as const;

function rdoc(o: { rid: string; pid: number; status: number; lang?: string; judgeAt?: string }): Record<string, unknown> {
  return {
    _id: o.rid,
    pid: o.pid,
    status: o.status,
    lang: o.lang ?? 'cc.cc17o2',
    score: o.status === ST.ACCEPTED ? 100 : 0,
    ...(o.judgeAt ? { judgeAt: o.judgeAt } : {}),
  };
}

function jsonPage(rdocs: Record<string, unknown>[], pdict?: Record<string, { pid: number; title: string }>): string {
  return JSON.stringify({ page: 1, rdocs, pdict: pdict ?? {} });
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
        return new Response(typeof value === 'function' ? value() : value, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(jsonPage([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const PDICT = {
  '1308': { pid: 1308, title: 'A+B' },
  '150': { pid: 150, title: 'TLE 题' },
  '9': { pid: 9, title: '评测中' },
};

// ---------- 纯函数 ----------

test('dashoj: objectIdToTimestamp extracts epoch seconds from ObjectId prefix', () => {
  assert.equal(objectIdToTimestamp(oid(1788768000, 'aabb')), 1788768000);
  assert.equal(objectIdToTimestamp('6a9e6f00deadbeefcafe1234'), 1788768000);
});

test('dashoj: isLoginRedirect detects Hydro login redirect body', () => {
  assert.equal(isLoginRedirect({ url: '/login?redirect=%2Frecord' }), true);
  assert.equal(isLoginRedirect({ url: '/record?x=1' }), false);
  assert.equal(isLoginRedirect({ rdocs: [] }), false);
  assert.equal(isLoginRedirect(null), false);
});

test('dashoj: submissionTimeIso prefers judgeAt, falls back to ObjectId prefix', () => {
  // judgeAt 优先
  assert.equal(
    submissionTimeIso({ _id: oid(10, 'aa'), judgeAt: '2026-10-22T13:14:50.086Z' }),
    '2026-10-22T13:14:50.086Z',
  );
  // judgeAt 缺失 → ObjectId 前缀（epoch 秒）
  assert.equal(submissionTimeIso({ _id: oid(1788768000, 'a1') }), '2026-09-07T08:00:00.000Z');
  // judgeAt 非法 + ObjectId 非 hex → null（坏行跳过）
  assert.equal(submissionTimeIso({ _id: 'zzzzzzzz-nothex', judgeAt: 'not-a-date' }), null);
});

test('dashoj: parseDashojJson merges rdocs + pdict into titled rows (keeps judgeAt)', () => {
  const rows = parseDashojJson({
    page: 1,
    rdocs: [
      rdoc({ rid: oid(1788768000, 'a1'), pid: 1308, status: ST.ACCEPTED, judgeAt: '2026-10-22T13:14:50.086Z' }) as never,
    ],
    pdict: PDICT,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 1308);
  assert.equal(rows[0].title, 'A+B');
  assert.equal(rows[0].status, ST.ACCEPTED);
  assert.equal(rows[0].judgeAt, '2026-10-22T13:14:50.086Z');
  // pdict 缺失的题目回退 pid 字符串
  const rows2 = parseDashojJson({
    page: 1,
    rdocs: [rdoc({ rid: oid(10, 'cc'), pid: 99, status: ST.ACCEPTED }) as never],
    pdict: {},
  });
  assert.equal(rows2[0].title, '99');
});

// ---------- fetchUserSubmissions ----------

test('dashoj: works WITHOUT cookie (records are public), maps verdicts, skips judging, ISO time from judgeAt', async () => {
  const fetchFn = router({
    'uidOrName=h&page=1': jsonPage([
      rdoc({ rid: oid(1788768000, 'a1'), pid: 1308, status: ST.ACCEPTED, judgeAt: '2026-10-22T13:14:50.086Z' }),
      rdoc({ rid: oid(1788767940, 'b2'), pid: 1308, status: ST.COMPILE_ERROR, judgeAt: '2026-10-22T13:12:46.000Z' }),
      rdoc({ rid: oid(1788767880, 'c3'), pid: 150, status: ST.TIME_EXCEEDED, judgeAt: '2026-10-22T13:11:00.000Z' }),
      rdoc({ rid: oid(1788767820, 'd4'), pid: 9, status: ST.WAITING, judgeAt: '2026-10-22T13:10:00.000Z' }),
    ], PDICT),
  });
  const adapter = createDashojAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', { pageDelayMs: 0 });
  assert.equal(subs.length, 3); // Waiting(status=0) 跳过
  assert.equal(subs[0].verdict, 'AC');
  assert.equal(subs[0].problem.platform, 'dashoj');
  assert.equal(subs[0].problem.problemKey, '1308');
  assert.equal(subs[0].problem.title, 'A+B');
  assert.equal(subs[0].problem.url, 'https://dashoj.com/p/1308');
  assert.equal(subs[0].language, 'cc.cc17o2');
  assert.equal(subs[0].externalId, oid(1788768000, 'a1'));
  assert.equal(subs[0].submittedAt, '2026-10-22T13:14:50.086Z');
  assert.equal(subs[1].verdict, 'CE');
  assert.equal(subs[2].verdict, 'TLE');
});

test('dashoj: empty handle throws', async () => {
  const adapter = createDashojAdapter(router({}));
  await assert.rejects(() => adapter.fetchUserSubmissions('   '), /账号名为空/);
});

test('dashoj: bad-timestamp row skipped, valid rows kept', async () => {
  const fetchFn = router({
    'uidOrName=h&page=1': jsonPage([
      rdoc({ rid: 'zzzzzzzz-nothex', pid: 1308, status: ST.ACCEPTED }), // 无 judgeAt + 坏 _id → 跳过
      rdoc({ rid: oid(1788768000, 'a1'), pid: 1308, status: ST.ACCEPTED, judgeAt: '2026-10-22T13:14:50.086Z' }),
    ], PDICT),
  });
  const adapter = createDashojAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', { pageDelayMs: 0 });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].externalId, oid(1788768000, 'a1'));
});

test('dashoj: full-page known ids stops pagination (增量提前终止)', async () => {
  let page2Fetched = false;
  const fetchFn = router({
    'uidOrName=h&page=1': jsonPage([rdoc({ rid: oid(10, 'aa'), pid: 1, status: ST.ACCEPTED, judgeAt: '2026-01-01T00:00:00.000Z' })], { '1': { pid: 1, title: 'a' } }),
    'uidOrName=h&page=2': () => {
      page2Fetched = true;
      return jsonPage([rdoc({ rid: oid(5, 'bb'), pid: 1, status: ST.ACCEPTED, judgeAt: '2026-01-01T00:00:00.000Z' })], { '1': { pid: 1, title: 'b' } });
    },
  });
  const adapter = createDashojAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', {
    knownExternalIds: new Set([oid(10, 'aa')]),
    pageDelayMs: 0,
  });
  assert.equal(page2Fetched, false);
  assert.equal(subs.length, 0);
});

// ---------- 错误路径 ----------

test('dashoj: non-JSON response raises structure-changed error', async () => {
  const broken = createDashojAdapter(
    async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(() => broken.fetchUserSubmissions('h', { pageDelayMs: 0 }), /非 JSON/);
});

test('dashoj: login redirect body (site tightened) raises readable error', async () => {
  const adapter = createDashojAdapter(
    router({ 'uidOrName=h': JSON.stringify({ url: '/login?redirect=%2Frecord' }) }),
  );
  await assert.rejects(() => adapter.fetchUserSubmissions('h', { pageDelayMs: 0 }), /跳转登录/);
});

test('dashoj: empty rdocs = 0 records (valid), sends Accept json header', async () => {
  const seen: Record<string, string>[] = [];
  const fetchFn = router({ 'uidOrName=h&page=1': jsonPage([]) }, { seenHeaders: seen });
  const adapter = createDashojAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', { pageDelayMs: 0 });
  assert.equal(subs.length, 0);
  assert.equal(seen[0].Accept, 'application/json');
});

// ---------- 注册 / problemUrl ----------

test('dashoj: registered via initAdapters, problemUrl format', () => {
  initAdapters();
  assert.equal(getAdapter('dashoj')?.platform, 'dashoj');
  const adapter = createDashojAdapter();
  assert.equal(adapter.problemUrl({ problemKey: '1308' }), 'https://dashoj.com/p/1308');
});

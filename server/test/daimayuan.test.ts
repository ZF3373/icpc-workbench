import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaimayuanAdapter, objectIdToTimestamp, isLoginRedirect, parseDaimayuanJson } from '../src/adapters/daimayuan.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/**
 * 代码源适配器测试（JSON 模式）。
 * Hydro /record?uidOrName=...&page=N 加 Accept:application/json 返回：
 *   { page, rdocs: [{_id, pid, status, lang, score?}], pdict: {pid:{pid,title}}, ... }
 * 登录失效时返回 200 + {url:"/login?redirect=..."}。
 */

/** epoch 秒 → 8 位十六进制 ObjectId 前缀（MongoDB ObjectId 前 4 字节 = 提交时间） */
function oidPrefix(ts: number): string {
  return ts.toString(16).padStart(8, '0');
}
/** 构造一个合法的 24 位 ObjectId：前 8 位=时间戳，后 16 位固定填充（测试不关心唯一性以外） */
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

function rdoc(o: { rid: string; pid: number; status: number; ts: number; lang?: string }): Record<string, unknown> {
  return { _id: o.rid, pid: o.pid, status: o.status, lang: o.lang ?? 'C++23(O2)', score: o.status === ST.ACCEPTED ? 100 : 0 };
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

const COOKIE = 'sid=s-session-token';
const PDICT = {
  '7': { pid: 7, title: '[R2A]三人组队' },
  '8': { pid: 8, title: 'TLE 题' },
  '9': { pid: 9, title: '评测中' },
};

// ---------- 纯函数 ----------

test('daimayuan: objectIdToTimestamp extracts epoch seconds from ObjectId prefix', () => {
  assert.equal(objectIdToTimestamp(oid(1788768000, 'aabb')), 1788768000);
  assert.equal(objectIdToTimestamp('6a9e6f00deadbeefcafe1234'), 1788768000);
  assert.equal(objectIdToTimestamp('0000000a0000000000000000'), 10);
});

test('daimayuan: isLoginRedirect detects Hydro login redirect body', () => {
  assert.equal(isLoginRedirect({ url: '/login?redirect=%2Frecord' }), true);
  assert.equal(isLoginRedirect({ url: '/record?x=1' }), false);
  assert.equal(isLoginRedirect({ rdocs: [] }), false);
  assert.equal(isLoginRedirect(null), false);
});

test('daimayuan: parseDaimayuanJson merges rdocs + pdict into titled rows', () => {
  const rows = parseDaimayuanJson({
    page: 1,
    rdocs: [
      rdoc({ rid: oid(1788768000, 'a1'), pid: 7, status: ST.ACCEPTED, ts: 1788768000 }) as never,
      rdoc({ rid: oid(1788767940, 'b2'), pid: 7, status: ST.COMPILE_ERROR, ts: 1788767940 }) as never,
    ],
    pdict: PDICT,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]._id, oid(1788768000, 'a1'));
  assert.equal(rows[0].pid, 7);
  assert.equal(rows[0].title, '[R2A]三人组队');
  assert.equal(rows[0].status, ST.ACCEPTED);
  // pdict 缺失的题目回退 pid 字符串
  const rows2 = parseDaimayuanJson({
    page: 1,
    rdocs: [rdoc({ rid: oid(10, 'cc'), pid: 99, status: ST.ACCEPTED, ts: 10 }) as never],
    pdict: {},
  });
  assert.equal(rows2[0].title, '99');
});

// ---------- fetchUserSubmissions ----------

test('daimayuan: without cookie throws ManualImportRequiredError', async () => {
  const adapter = createDaimayuanAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('hieZF1123'), ManualImportRequiredError);
});

test('daimayuan: fetch maps verdicts, skips judging, builds urls and ISO time', async () => {
  const fetchFn = router({
    'uidOrName=hieZF1123&page=1': jsonPage([
      rdoc({ rid: oid(1788768000, 'a1'), pid: 7, status: ST.ACCEPTED, ts: 1788768000 }),
      rdoc({ rid: oid(1788767940, 'b2'), pid: 7, status: ST.COMPILE_ERROR, ts: 1788767940 }),
      rdoc({ rid: oid(1788767880, 'c3'), pid: 8, status: ST.TIME_EXCEEDED, ts: 1788767880 }),
      rdoc({ rid: oid(1788767820, 'd4'), pid: 9, status: ST.WAITING, ts: 1788767820 }),
    ], PDICT),
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('hieZF1123', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 3); // Waiting(status=0) 跳过
  assert.equal(subs[0].verdict, 'AC');
  assert.equal(subs[0].problem.problemKey, '7');
  assert.equal(subs[0].problem.title, '[R2A]三人组队');
  assert.equal(subs[0].problem.url, 'https://bs.daimayuan.top/p/7');
  assert.equal(subs[0].language, 'C++23(O2)');
  assert.equal(subs[0].externalId, oid(1788768000, 'a1'));
  assert.equal(subs[0].submittedAt, '2026-09-07T08:00:00.000Z'); // ObjectId 时间戳秒 → ISO
  assert.equal(subs[1].verdict, 'CE');
  assert.equal(subs[2].verdict, 'TLE');
});

test('daimayuan: full-page known ids stops pagination (增量提前终止)', async () => {
  let page2Fetched = false;
  const fetchFn = router({
    'uidOrName=h&page=1': jsonPage([rdoc({ rid: oid(10, 'aa'), pid: 1, status: ST.ACCEPTED, ts: 10 })], { '1': { pid: 1, title: 'a' } }),
    'uidOrName=h&page=2': () => {
      page2Fetched = true;
      return jsonPage([rdoc({ rid: oid(5, 'bb'), pid: 1, status: ST.ACCEPTED, ts: 5 })], { '1': { pid: 1, title: 'b' } });
    },
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', {
    cookie: COOKIE,
    knownExternalIds: new Set([oid(10, 'aa')]),
    pageDelayMs: 0,
  });
  assert.equal(page2Fetched, false);
  assert.equal(subs.length, 0);
});

test('daimayuan: known rows skipped, unknown appended across pages (满页才翻页)', async () => {
  // 第 1 页满页 100 条：r100 未知 + 99 条已知 → 继续翻页；第 2 页 1 条新记录（不足一页 → 最后一页）
  const page1 = [
    rdoc({ rid: oid(2000, '10'), pid: 1, status: ST.ACCEPTED, ts: 2000 }),
    ...Array.from({ length: 99 }, (_, i) =>
      rdoc({ rid: oid(1999 - i, String(i).padStart(2, '0')), pid: 1, status: ST.ACCEPTED, ts: 1999 - i }),
    ),
  ];
  const fetchFn = router({
    'uidOrName=h&page=1': jsonPage(page1, { '1': { pid: 1, title: 'x' } }),
    'uidOrName=h&page=2': jsonPage([rdoc({ rid: oid(1, 'ff'), pid: 1, status: ST.ACCEPTED, ts: 1 })], { '1': { pid: 1, title: 'x' } }),
  });
  const adapter = createDaimayuanAdapter(fetchFn);
  const known = new Set(Array.from({ length: 99 }, (_, i) => oid(1999 - i, String(i).padStart(2, '0'))));
  const subs = await adapter.fetchUserSubmissions('h', {
    cookie: COOKIE,
    knownExternalIds: known,
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), [oid(2000, '10'), oid(1, 'ff')]);
});

// ---------- 登录失效 ----------

test('daimayuan: expired login (302 / JSON redirect) raises ManualImportRequiredError', async () => {
  const adapter302 = createDaimayuanAdapter(
    router({ 'uidOrName=h': jsonPage([]) }, { status: 302, location: '/login?redirect=%2Frecord' }),
  );
  await assert.rejects(
    () => adapter302.fetchUserSubmissions('h', { cookie: 'stale', pageDelayMs: 0 }),
    /登录态已失效/,
  );
  // JSON 模式下登录失效：Hydro 返回 200 + {url:"/login?redirect=..."}
  const adapterJson = createDaimayuanAdapter(
    router({ 'uidOrName=h': JSON.stringify({ url: '/login?redirect=%2Frecord%3FuidOrName%3Dh' }) }),
  );
  await assert.rejects(
    () => adapterJson.fetchUserSubmissions('h', { cookie: 'stale', pageDelayMs: 0 }),
    ManualImportRequiredError,
  );
});

test('daimayuan: empty rdocs = 0 records (valid), sends cookie + Accept headers', async () => {
  const seen: Record<string, string>[] = [];
  const fetchFn = router({ 'uidOrName=h&page=1': jsonPage([]) }, { seenHeaders: seen });
  const adapter = createDaimayuanAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('h', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 0);
  assert.equal(seen[0].Cookie, COOKIE);
  assert.equal(seen[0].Accept, 'application/json');
  // 非 JSON 响应视为结构变化
  const broken = createDaimayuanAdapter(
    async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(() => broken.fetchUserSubmissions('h', { cookie: COOKIE, pageDelayMs: 0 }), /非 JSON/);
});

// ---------- checkAuth / 注册 ----------

test('daimayuan: checkAuth validates via own /record page (needs handle)', async () => {
  const ok = createDaimayuanAdapter(
    router({ 'uidOrName=hieZF1123': jsonPage([rdoc({ rid: oid(1, 'ab'), pid: 1, status: ST.ACCEPTED, ts: 1 })], { '1': { pid: 1, title: 'a' } }) }),
  );
  const rOk = await ok.checkAuth!({ cookie: COOKIE, handle: 'hieZF1123' });
  assert.equal(rOk.ok, true);

  // 未绑定账号时给出引导而非误判 Cookie 失效
  const noHandle = createDaimayuanAdapter(router({}));
  const rNo = await noHandle.checkAuth!({ cookie: COOKIE });
  assert.equal(rNo.ok, false);
  assert.match(rNo.message, /填写用户名/);

  const bad = createDaimayuanAdapter(router({ 'uidOrName=h': jsonPage([]) }, { status: 302 }));
  const rBad = await bad.checkAuth!({ cookie: 'stale', handle: 'h' });
  assert.equal(rBad.ok, false);
  assert.match(rBad.message, /Cookie 无效或已过期/);

  // JSON 模式登录失效
  const badJson = createDaimayuanAdapter(
    router({ 'uidOrName=h': JSON.stringify({ url: '/login?redirect=x' }) }),
  );
  const rBadJson = await badJson.checkAuth!({ cookie: 'stale', handle: 'h' });
  assert.equal(rBadJson.ok, false);
  assert.match(rBadJson.message, /Cookie 无效或已过期/);

  const netFail = createDaimayuanAdapter((async () => {
    throw new Error('fetch failed');
  }) as typeof fetch);
  const rNet = await netFail.checkAuth!({ cookie: 'c', handle: 'h' });
  assert.equal(rNet.ok, false);
  assert.match(rNet.message, /无法连接/);
});

test('daimayuan: registered via initAdapters, problemUrl format', () => {
  initAdapters();
  assert.equal(getAdapter('daimayuan')?.platform, 'daimayuan');
  const adapter = createDaimayuanAdapter();
  assert.equal(adapter.problemUrl({ problemKey: '7' }), 'https://bs.daimayuan.top/p/7');
});

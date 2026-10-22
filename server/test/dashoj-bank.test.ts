import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDashojBank, type BankCursor } from '../src/adapters/problemBank.ts';

/**
 * DashOJ 题库「按总数差值只拉新增」增量逻辑测试。
 *
 * 站点模型：题目按 docId 升序（1..total），每页 50 条，/p?page=N 返回
 * `{ pcount: total, ppcount: ceil(total/50), pdocs: [本页] }`。新题只追加在尾部（更高 docId）。
 * 用 requestedPages 断言「增量只扫了尾页、没白扫全表」。
 */

const PAGE = 50;

function mockSite(total: number): { fetchFn: typeof fetch; requestedPages: number[]; ppcount: number } {
  const ppcount = Math.max(1, Math.ceil(total / PAGE));
  const docs = Array.from({ length: total }, (_, i) => ({
    docId: i + 1,
    title: `P${i + 1}`,
    difficulty: 3, // 站点手工难度，避开 hydroDifficulty 复算路径（本测试只关心增量取页）
    nSubmit: 100,
    nAccept: 50,
    tag: ['蓝桥杯'],
  }));
  const requestedPages: number[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const u = String(input);
    const page = Number(/page=(\d+)/.exec(u)?.[1] ?? 1);
    requestedPages.push(page);
    const slice = docs.slice((page - 1) * PAGE, page * PAGE);
    return new Response(JSON.stringify({ pcount: total, ppcount, pdocs: slice }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn: fetchFn as typeof fetch, requestedPages, ppcount };
}

test('dashoj bank: 无游标 = 全量扫描，产出全部题 + 游标', async () => {
  const site = mockSite(120); // 3 页：50 / 50 / 20
  const r = await fetchDashojBank(site.fetchFn, { pageDelayMs: 0 });
  assert.equal(r.problems.length, 120);
  assert.equal(r.total, 120);
  assert.deepEqual(r.cursor, { maxDocId: 120, pcount: 120 } satisfies BankCursor);
  assert.deepEqual(site.requestedPages, [1, 2, 3]);
  // 题目字段正确（键 = docId、url、标签透传）
  assert.equal(r.problems[0].problemKey, '1');
  assert.equal(r.problems[0].url, 'https://dashoj.com/p/1');
  assert.deepEqual(r.problems[0].tags, ['蓝桥杯']);
});

test('dashoj bank: 增量且无新增 → 返回空、只请求首页+尾页（不白扫全表）', async () => {
  const site = mockSite(120);
  const r = await fetchDashojBank(site.fetchFn, {
    pageDelayMs: 0,
    incrementalFrom: { maxDocId: 120, pcount: 120 },
  });
  assert.equal(r.problems.length, 0);
  assert.equal(r.total, 120);
  assert.deepEqual(r.cursor, { maxDocId: 120, pcount: 120 });
  // 关键：只打了第 1 页（拿 pcount/ppcount）与第 3 页（拿当前最高 docId），没有扫第 2 页
  assert.deepEqual(site.requestedPages, [1, 3]);
});

test('dashoj bank: 增量且尾部新增 20 题 → 只收 docId>游标 的新题，游标前移', async () => {
  const site = mockSite(140); // ppcount=3，第 3 页 = docId 101..140
  const r = await fetchDashojBank(site.fetchFn, {
    pageDelayMs: 0,
    incrementalFrom: { maxDocId: 120, pcount: 120 },
  });
  // delta=20 → tailPages=ceil(20/50)+1=1 → 只扫第 3 页；其中 docId 101..120 属已知被跳过
  assert.equal(r.problems.length, 20);
  assert.deepEqual(
    r.problems.map((p) => p.problemKey),
    Array.from({ length: 20 }, (_, i) => String(121 + i)),
  );
  assert.deepEqual(r.cursor, { maxDocId: 140, pcount: 140 });
  // 取页：首页(1) + 尾页判定(3) + 尾部扫描(2,3)。delta=20 → tailPages=ceil(20/50)+1=2 →
  // startPage=2；第 2 页(docId 51..100)全 ≤ 游标被跳过，属 +1 边界冗余，只多打 1 页。
  assert.deepEqual(site.requestedPages, [1, 3, 2, 3]);
});

test('dashoj bank: 总数下降（站点删题）→ 全量重扫兜底，游标回落到真实最高 docId', async () => {
  const site = mockSite(100); // ppcount=2；游标却记着旧的 120/120
  const r = await fetchDashojBank(site.fetchFn, {
    pageDelayMs: 0,
    incrementalFrom: { maxDocId: 120, pcount: 120 },
  });
  // pcount(100) < 游标 pcount(120) → 结构变化，全量重扫收全部 100 题
  assert.equal(r.problems.length, 100);
  // 游标 maxDocId 必须回落到真实值 100，而非停在旧高位 120
  //（否则此后 docId ≤120 的新题会被永远漏掉）
  assert.deepEqual(r.cursor, { maxDocId: 100, pcount: 100 });
});

test('dashoj bank: 增量新增跨越整页（delta>50）→ 扫足够尾页且只收新题', async () => {
  const site = mockSite(230); // ppcount=5，尾页 docId 201..230
  const r = await fetchDashojBank(site.fetchFn, {
    pageDelayMs: 0,
    incrementalFrom: { maxDocId: 120, pcount: 120 },
  });
  // delta=110 → tailPages=ceil(110/50)+1=4 → 扫第 2..5 页，收 docId 121..230 共 110 题
  assert.equal(r.problems.length, 110);
  assert.equal(r.problems[0].problemKey, '121');
  assert.equal(r.problems[r.problems.length - 1].problemKey, '230');
  assert.deepEqual(r.cursor, { maxDocId: 230, pcount: 230 });
  // 取页序列：首页(1) + 尾页判定(5) + 尾部扫描(2..5)。startPage 因 +1 边界冗余落到第 2 页
  //（docId 51..100 全部 ≤ 游标 120 被跳过），不影响结果，只多打 1 页。
  assert.deepEqual(site.requestedPages, [1, 5, 2, 3, 4, 5]);
});

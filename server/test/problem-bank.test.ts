import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { fetchLuoguBank, fetchNowcoderBank, fetchAtcoderBank, fetchDaimayuanBank } from '../src/adapters/problemBank.ts';
import { upsertBankProblems } from '../src/import/bankService.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import { practicePool } from '../src/plans/planService.ts';
import { insertNormalized } from '../src/import/importService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

/** mock fetch 路由器（与 luogu-nowcoder.test.ts 相同模式） */
function router(
  handlers: Record<string, (url: string) => unknown>,
): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        const v = handler(u);
        if (typeof v === 'string') return new Response(v, { status: 200 });
        if (v && typeof v === 'object' && 'status' in v) {
          const r = v as { status: number; body: string; headers?: Record<string, string> };
          return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
        }
        return new Response(JSON.stringify(v), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

// ---------- 洛谷题库拉取 ----------

function luoguPage(pids: string[], count: number): unknown {
  // 注意：不能带 status 字段（与 router 的 {status, body} Response 构造约定冲突）
  return {
    data: {
      problems: {
        count,
        perPage: 50,
        result: pids.map((pid, i) => ({
          pid,
          type: 'P',
          name: `题目 ${pid}`,
          difficulty: 2 + (i % 3),
          tags: [2, 108],
        })),
      },
    },
  };
}

test('luogu bank: parses Lentille list, maps difficulty & tags, paginates and stops', async () => {
  const pages: string[] = [];
  // 第 1 页返回满页（50 题，但 max=100 截断在拉取层之前仍需翻页判断），
  // 第 2 页空 → 终止。构造 50 题：P1000..P1049
  const fullPage = Array.from({ length: 50 }, (_, i) => `P10${String(i).padStart(2, '0')}`);
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [{ id: 2, name: '字符串' }, { id: 108, name: '模拟' }] }),
    'problem/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      pages.push(page ?? '');
      if (page === '1') return luoguPage(fullPage, 12000);
      return luoguPage([], 12000); // 第 2 页空 → 终止
    },
  });
  const r = await fetchLuoguBank(fetchFn, { max: 100 });
  assert.equal(r.platform, 'luogu');
  assert.equal(r.total, 12000);
  assert.equal(r.problems.length, 50);
  const p0 = r.problems[0];
  assert.equal(p0.problemKey, 'P1000');
  assert.equal(p0.title, '题目 P1000');
  assert.equal(p0.difficulty, 1300); // 洛谷难度 2 → CF 1300
  assert.equal(p0.url, 'https://www.luogu.com.cn/problem/P1000');
  assert.deepEqual(p0.tags, ['字符串', '模拟']);
  assert.equal(pages.length, 2); // 空页后停止
});

test('luogu bank: max option truncates result', async () => {
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [] }),
    'problem/list': () => luoguPage(['P1001', 'P1002', 'P1003'], 100),
  });
  const r = await fetchLuoguBank(fetchFn, { max: 2 });
  assert.equal(r.problems.length, 2);
});

test('luogu bank: difficulty filter param passed to server', async () => {
  const seen: string[] = [];
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [] }),
    'problem/list': (url) => {
      seen.push(new URL(url).searchParams.get('difficulty') ?? '');
      return luoguPage(['P1001'], 100);
    },
  });
  await fetchLuoguBank(fetchFn, { max: 1, luoguMinDifficulty: 5 });
  assert.deepEqual(seen, ['5']);
});

test('luogu bank: non-JSON response throws (risk control)', async () => {
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [] }),
    'problem/list': () => ({ status: 200, body: '<html>challenge</html>' }),
  });
  await assert.rejects(() => fetchLuoguBank(fetchFn, {}), /非 JSON/);
});

test('luogu bank: tag dict failure degrades to no tags', async () => {
  const fetchFn = router({
    '_lfe/tags': () => ({ status: 403, body: '' }),
    'problem/list': () => luoguPage(['P1001'], 100),
  });
  const r = await fetchLuoguBank(fetchFn, { max: 1 });
  assert.equal(r.problems.length, 1);
  assert.deepEqual(r.problems[0].tags, []);
});

// ---------- 牛客题库拉取 ----------

function ncBankPage(rows: Array<[id: string, title: string, diff: string]>, total?: number): string {
  const trs = rows
    .map(
      ([id, title, diff]) =>
        `<tr data-problemId="${id}"><td> <a href="/acm/problem/${id}">NC${id}</a> </td>` +
        `<td class="fn-right" colspan="2"> <a href="/acm/problem/${id}" class="title">${title}</a> </td>` +
        `<td> ${diff} </td><td>100</td><td><a href="javascript:void(0);"></a></td></tr>`,
    )
    .join('');
  const totalDiv = total === undefined ? '' : `<div>共 ${total} 条</div>`;
  return `<html><body><table><tbody>${trs}</tbody></table>${totalDiv}</body></html>`;
}

test('nowcoder bank: parses rows, difficulty as CF-style score, dedupes', async () => {
  const fetchFn = router({
    'acm/problem/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '1') {
        return ncBankPage(
          [
            ['321126', '小红的权值', '700'],
            ['321118', '小红的01矩阵', '1100'],
          ],
          14317,
        );
      }
      // 第 2 页重复 id（跨页重复）→ 去重后为空 → 终止
      return ncBankPage([['321126', '小红的权值', '700']]);
    },
  });
  const r = await fetchNowcoderBank(fetchFn, { max: 100 });
  assert.equal(r.platform, 'nowcoder');
  assert.equal(r.total, 14317);
  assert.equal(r.problems.length, 2); // 跨页重复被去重
  assert.deepEqual(r.problems[0], {
    platform: 'nowcoder',
    problemKey: '321126',
    title: '小红的权值',
    difficulty: 700,
    url: 'https://ac.nowcoder.com/acm/problem/321126',
    tags: [],
  });
  assert.equal(r.problems[1].difficulty, 1100);
});

test('nowcoder bank: empty first page returns empty without error', async () => {
  const fetchFn = router({
    'acm/problem/list': () => ncBankPage([]),
  });
  const r = await fetchNowcoderBank(fetchFn, {});
  assert.equal(r.problems.length, 0);
  assert.equal(r.total, null);
});

test('nowcoder bank: HTTP failure throws', async () => {
  const fetchFn = router({
    'acm/problem/list': () => ({ status: 403, body: '' }),
  });
  await assert.rejects(() => fetchNowcoderBank(fetchFn, {}), /HTTP 403/);
});

// ---------- AtCoder 题库拉取 ----------

function kenkoooProblems(): unknown {
  return [
    { id: 'abc138_a', contest_id: 'abc138', problem_index: 'A', name: 'Red or Not', title: 'A - Red or Not' },
    { id: 'abc138_b', contest_id: 'abc138', problem_index: 'B', name: 'Resistors in Parallel', title: 'B - Resistors in Parallel' },
    { id: 'abc138_c', contest_id: 'abc138', problem_index: 'C', name: 'Alchemist', title: 'C - Alchemist' },
  ];
}

function kenkoooModels(): unknown {
  return {
    abc138_a: { difficulty: -848, is_experimental: false },
    abc138_b: { difficulty: -364, is_experimental: false },
    abc138_c: { difficulty: 1200, is_experimental: false },
    abc138_d: { difficulty: 631 },
  };
}

test('atcoder bank: parses problems + models, maps difficulty, clamps negatives', async () => {
  const fetchFn = router({
    'resources/problems.json': () => kenkoooProblems(),
    'resources/problem-models.json': () => kenkoooModels(),
  });
  const r = await fetchAtcoderBank(fetchFn, { max: 100 });
  assert.equal(r.platform, 'atcoder');
  assert.equal(r.total, 3);
  assert.equal(r.problems.length, 3);
  const p0 = r.problems[0];
  assert.equal(p0.problemKey, 'abc138_a');
  assert.equal(p0.title, 'A - Red or Not');
  assert.equal(p0.difficulty, 800); // 负值 -848 钳到 800
  assert.equal(p0.url, 'https://atcoder.jp/contests/abc138/tasks/abc138_a');
  assert.deepEqual(p0.tags, []);
  // 正常值（>= 800）四舍五入后原样保留
  assert.equal(r.problems[1].difficulty, 800); // -364 也钳到 800
  assert.equal(r.problems[2].difficulty, 1200); // 1200 原样
});

test('atcoder bank: missing difficulty model → null', async () => {
  const fetchFn = router({
    'resources/problems.json': () => [
      { id: 'xyz_a', contest_id: 'xyz', name: 'X', title: 'A - X' },
    ],
    'resources/problem-models.json': () => ({}),
  });
  const r = await fetchAtcoderBank(fetchFn, { max: 10 });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].difficulty, null);
});

test('atcoder bank: max option truncates result', async () => {
  const fetchFn = router({
    'resources/problems.json': () => kenkoooProblems(),
    'resources/problem-models.json': () => kenkoooModels(),
  });
  const r = await fetchAtcoderBank(fetchFn, { max: 2 });
  assert.equal(r.problems.length, 2);
  assert.equal(r.total, 3); // total 仍为服务端报告的题库总数
});

test('atcoder bank: HTTP failure throws', async () => {
  const fetchFn = router({
    'resources/problems.json': () => ({ status: 500, body: '' }),
    'resources/problem-models.json': () => kenkoooModels(),
  });
  await assert.rejects(() => fetchAtcoderBank(fetchFn, {}), /HTTP 500/);
});

// ---------- 代码源题库拉取 ----------

function dmyBankPage(rows: Array<[pid: string, title: string, diff: string, tags: string[]]>, total?: number): string {
  const trs = rows
    .map(([pid, title, diff, tags]) => {
      const tagLis = tags
        .map((t) => `<li class="problem__tag"><a class="problem__tag-link" href="/p?q=category%3A${encodeURIComponent(t)}">${t}</a></li>`)
        .join('');
      return `<tr data-pid="${pid}">` +
        `<td class="col--checkbox"><input type="checkbox"></td>` +
        `<td class="col--pid">${pid}</td>` +
        `<td class="col--name col--problem-name" data-star-action="/p/${pid}">` +
        `<a href="/p/${pid}"><b>${pid}</b>&nbsp;&nbsp;${title}</a>` +
        `<ul class="problem__tags">${tagLis}</ul>` +
        `</td>` +
        `<td class="col--ac-tried">100 / 200</td>` +
        `<td class="col--difficulty">${diff}</td>` +
        `</tr>`;
    })
    .join('');
  const totalP = total === undefined ? '' : `<p>${total} problems</p>`;
  return `<html><body><table><tbody>${trs}</tbody></table>${totalP}</body></html>`;
}

test('daimayuan bank: parses rows, maps difficulty 1-10 to CF rating, extracts tags', async () => {
  const fetchFn = router({
    '/p?page': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '1') {
        return dmyBankPage(
          [
            ['1', '[R1A]最大奇数', '4', ['模拟']],
            ['2', '[R1B]砖块覆盖', '2', ['其他', '数学']],
          ],
          459,
        );
      }
      return dmyBankPage([]); // 第 2 页空 → 终止
    },
  });
  const r = await fetchDaimayuanBank(fetchFn, { max: 100 });
  assert.equal(r.platform, 'daimayuan');
  assert.equal(r.total, 459);
  assert.equal(r.problems.length, 2);
  const p0 = r.problems[0];
  assert.equal(p0.problemKey, '1');
  assert.equal(p0.title, '[R1A]最大奇数');
  assert.equal(p0.difficulty, 1400); // 难度 4 → CF 1400
  assert.equal(p0.url, 'https://bs.daimayuan.top/p/1');
  assert.deepEqual(p0.tags, ['模拟']);
  const p1 = r.problems[1];
  assert.equal(p1.difficulty, 1000); // 难度 2 → CF 1000
  assert.deepEqual(p1.tags, ['其他', '数学']);
});

test('daimayuan bank: empty first page returns empty without error', async () => {
  const fetchFn = router({
    '/p?page': () => dmyBankPage([]),
  });
  const r = await fetchDaimayuanBank(fetchFn, {});
  assert.equal(r.problems.length, 0);
  assert.equal(r.total, null);
});

test('daimayuan bank: max option truncates result', async () => {
  const fetchFn = router({
    '/p?page': () => dmyBankPage([
      ['1', '题 A', '3', []],
      ['2', '题 B', '5', ['dp']],
      ['3', '题 C', '7', []],
    ], 459),
  });
  const r = await fetchDaimayuanBank(fetchFn, { max: 2 });
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[1].difficulty, 1600); // 难度 5 → CF 1600
});

test('daimayuan bank: HTTP failure throws', async () => {
  const fetchFn = router({
    '/p?page': () => ({ status: 503, body: '' }),
  });
  await assert.rejects(() => fetchDaimayuanBank(fetchFn, {}), /HTTP 503/);
});

// ---------- 入库服务 ----------

test('upsertBankProblems: inserts new, updates existing, keeps manual difficulty', () => {
  // 预置一道已存在题（手动导入途径，difficulty=1800）
  db.prepare(
    "INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES ('luogu', 'P1001', '旧标题', 1800, 'https://x', '[]')",
  ).run();
  const r = upsertBankProblems(db, [
    { platform: 'luogu', problemKey: 'P1001', title: '新标题', difficulty: 1300, url: 'https://www.luogu.com.cn/problem/P1001', tags: ['dp'] },
    { platform: 'luogu', problemKey: 'P2002', title: '题 B', difficulty: 1700, url: 'https://www.luogu.com.cn/problem/P2002', tags: ['图论'] },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].inserted, 1);
  assert.equal(r[0].updated, 1);
  const rows = db
    .prepare('SELECT problem_key, title, difficulty, tags FROM problems ORDER BY problem_key')
    .all() as Array<{ problem_key: string; title: string; difficulty: number; tags: string }>;
  assert.equal(rows.length, 2);
  // 已存在：标题更新、难度保留手动值（1800）、标签更新
  assert.equal(rows[0].problem_key, 'P1001');
  assert.equal(rows[0].title, '新标题');
  assert.equal(rows[0].difficulty, 1800);
  assert.deepEqual(JSON.parse(rows[0].tags), ['dp']);
  // 新增
  assert.equal(rows[1].problem_key, 'P2002');
  assert.equal(rows[1].difficulty, 1700);
});

test('upsertBankProblems: empty tags do not overwrite existing tags', () => {
  db.prepare(
    "INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES ('nowcoder', '10001', 'T', 1000, 'https://x', '[\"dp\"]')",
  ).run();
  upsertBankProblems(db, [
    { platform: 'nowcoder', problemKey: '10001', title: 'T', difficulty: 1000, url: null, tags: [] },
  ]);
  const row = db
    .prepare('SELECT tags FROM problems WHERE problem_key = 10001')
    .get() as { tags: string };
  assert.deepEqual(JSON.parse(row.tags), ['dp']);
});

test('upsertBankProblems: bank problems do not create submissions (stats unaffected)', () => {
  upsertBankProblems(db, [
    { platform: 'luogu', problemKey: 'P9001', title: '题库题', difficulty: 1500, url: 'https://x', tags: [] },
  ]);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number }).c,
    0,
  );
});

// ---------- practicePool 受益于题库题 ----------

function sub(key: string, diff: number, externalId: string, verdict: 'AC' | 'WA' = 'AC'): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces' as const,
      problemKey: key,
      title: `T ${key}`,
      difficulty: diff,
      url: `https://codeforces.com/problem/${key}`,
      tags: ['dp'],
    },
    verdict,
    language: 'C++',
    submittedAt: '2026-08-01T00:00:00.000Z',
    externalId,
  };
}

test('practicePool: includes bank problems in level range, excludes far-below-level ones', () => {
  // 构造用户水平：15 道 AC，难度 1400-1600 → suggestedRange 约 [1300, 1800]
  const subs: NormalizedSubmission[] = [];
  for (let i = 0; i < 15; i += 1) {
    subs.push(sub(`AC${i}`, 1400 + (i % 3) * 100, `e${i}`));
  }
  insertNormalized(db, 1, subs);
  // 题库题：区间内 1500 / 远低于区间 800
  upsertBankProblems(db, [
    { platform: 'luogu', problemKey: 'P_IN', title: '区间内题', difficulty: 1500, url: 'https://www.luogu.com.cn/problem/P_IN', tags: ['dp'] },
    { platform: 'luogu', problemKey: 'P_EASY', title: '水题', difficulty: 800, url: 'https://www.luogu.com.cn/problem/P_EASY', tags: [] },
  ]);
  const pool = practicePool(db, ['dp']);
  const keys = pool.map((p) => p.problemKey);
  assert.ok(keys.includes('P_IN'), '区间内题库题应进入候选池');
  assert.ok(!keys.includes('P_EASY'), '远低于用户水平的题库题应被过滤');
  assert.ok(!keys.includes('AC0'), '已 AC 的题不应进入候选池');
});

// ---------- 路由 ----------

async function withServer(
  fn: (base: string) => Promise<void>,
  fetchFn?: typeof fetch,
  seed?: (db: Db) => void,
): Promise<void> {
  const app = express();
  app.use(express.json());
  const db = createDb(':memory:');
  if (seed) seed(db);
  app.use('/api/problems', problemsRoutes(db, fetchFn));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/problems`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

test('GET /api/problems: 做过题超过 300 时返回全部，不被截断', async () => {
  // 回归：洛谷提交 >1999 的用户同步后题目管理只显示 300 题（原 SQL 硬编码 LIMIT 300）
  const subs: NormalizedSubmission[] = Array.from({ length: 400 }, (_, i) =>
    sub(`R${i}`, 800 + i, `ext-${i}`),
  );
  await withServer(
    async (base) => {
      const list = (await (await fetch(base)).json()) as Array<{ problem_key: string }>;
      assert.equal(list.length, 400);
    },
    undefined,
    (db) => insertNormalized(db, 1, subs),
  );
});

test('GET /api/problems: tag 筛选命中同义别名（二分 ↔ binary search）', async () => {
  const cfSub = sub('1001A', 1500, 'e-alias');
  cfSub.problem.tags = ['binary search'];
  await withServer(
    async (base) => {
      const byCn = (await (await fetch(`${base}?tag=二分`)).json()) as Array<{ problem_key: string }>;
      assert.equal(byCn.length, 1);
      assert.equal(byCn[0].problem_key, '1001A');
      // 反向：用英文 tag 查同样命中
      const byEn = (await (await fetch(`${base}?tag=binary%20search`)).json()) as Array<{ problem_key: string }>;
      assert.equal(byEn.length, 1);
      assert.equal(byEn[0].problem_key, '1001A');
    },
    undefined,
    (db) => insertNormalized(db, 1, [cfSub]),
  );
});

test('POST /api/problems/bank: rejects invalid platform', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'topcoder' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /luogu \/ nowcoder \/ codeforces/);
  });
});

test('POST /api/problems/bank: fetches atcoder bank and persists problems', async () => {
  const fetchFn = router({
    'resources/problems.json': () => [
      { id: 'abc138_a', contest_id: 'abc138', name: 'Red or Not', title: 'A - Red or Not' },
    ],
    'resources/problem-models.json': () => ({ abc138_a: { difficulty: 800 } }),
  });
  await withServer(async (base) => {
    const res = await fetch(`${base}/bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'atcoder', max: 50 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; fetched: number; inserted: number; total: number };
    assert.equal(body.ok, true);
    assert.equal(body.fetched, 1);
    assert.equal(body.inserted, 1);
    assert.equal(body.total, 1);
    const list = (await (await fetch(`${base}?bank=1&platform=atcoder`)).json()) as Array<{
      problem_key: string;
      status: string;
    }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].problem_key, 'abc138_a');
    assert.equal(list[0].status, 'none');
  }, fetchFn);
});

test('POST /api/problems/bank: fetches nowcoder bank and persists problems', async () => {
  const fetchFn = router({
    'acm/problem/list': () =>
      ncBankPage(
        [
          ['321126', '小红的权值', '700'],
          ['321118', '小红的01矩阵', '1100'],
        ],
        14317,
      ),
  });
  await withServer(async (base) => {
    const res = await fetch(`${base}/bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'nowcoder', max: 50 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; fetched: number; inserted: number; total: number | null };
    assert.equal(body.ok, true);
    assert.equal(body.fetched, 2);
    assert.equal(body.inserted, 2);
    assert.equal(body.total, 14317);
    // 已入库：bank=1 可见
    const list = (await (await fetch(`${base}?bank=1&platform=nowcoder`)).json()) as Array<{
      problem_key: string;
      status: string;
    }>;
    assert.equal(list.length, 2);
    assert.equal(list[0].status, 'none');
    // 缺省（bank 不传）：无提交记录的题库题不可见
    const listDefault = (await (await fetch(`${base}?platform=nowcoder`)).json()) as unknown[];
    assert.equal(listDefault.length, 0);
  }, fetchFn);
});

test('POST /api/problems/bank: upstream failure returns 502 with message', async () => {
  const fetchFn = router({
    'acm/problem/list': () => ({ status: 403, body: '' }),
  });
  await withServer(async (base) => {
    const res = await fetch(`${base}/bank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'nowcoder' }),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /HTTP 403/);
  }, fetchFn);
});

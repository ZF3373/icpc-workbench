import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import {
  parseNcSearchRow,
  cleanNcTitle,
  backfillDifficulties,
} from '../src/analysis/difficultyBackfill.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

/** mock fetch 路由器（与 problem-bank.test.ts 相同模式） */
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

// ---------- 牛客搜索行解析 ----------

const NC_ROW_HTML = `
<tr data-problemId="16640">
  <td><a href="/acm/problem/16640">NC16640</a></td>
  <td class="fn-right" colspan="2">
    <a href="/acm/problem/16640" target="_blank" class="title">[NOIP2007]纪念品分组</a>
    <a href="javascript:void(0);" class="tag-label js-tag" data-id="1">构造</a>
    <a href="javascript:void(0);" class="tag-label js-tag" data-id="2">贪心</a>
  </td>
  <td> 1049 </td><td>100</td><td></td>
</tr>`;

test('parseNcSearchRow: separates title/tags/difficulty', () => {
  const info = parseNcSearchRow(NC_ROW_HTML, '16640');
  assert.ok(info);
  assert.equal(info!.difficulty, 1049);
  assert.equal(info!.title, '[NOIP2007]纪念品分组');
  assert.deepEqual(info!.tags, ['构造', '贪心']);
});

test('parseNcSearchRow: no hit returns null; no-difficulty row returns null difficulty', () => {
  assert.equal(parseNcSearchRow('<html></html>', '99999'), null);
  const noDiff = NC_ROW_HTML.replace('<td> 1049 </td>', '<td> </td>');
  const info = parseNcSearchRow(noDiff, '16640');
  assert.ok(info);
  assert.equal(info!.difficulty, null);
});

// ---------- 标题清洗 ----------

test('cleanNcTitle: strips tag residue from polluted title', () => {
  assert.equal(cleanNcTitle('小红的好数组\n              暴力'), '小红的好数组');
  assert.equal(cleanNcTitle('正常标题'), '正常标题');
});

// ---------- 回填服务（牛客） ----------

function insertProblem(
  platform: string,
  key: string,
  title: string,
  difficulty: number | null,
  tags: string[],
): void {
  db.prepare(
    'INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(platform, key, title, difficulty, `https://x/${key}`, JSON.stringify(tags));
}

function ncListPage(info: { id: string; title: string; diff: string; tags: string[] }): string {
  const tagLinks = info.tags
    .map((t) => `<a href="javascript:void(0);" class="tag-label js-tag">${t}</a>`)
    .join('');
  return `<table><tr data-problemId="${info.id}">
    <td><a href="/acm/problem/${info.id}">NC${info.id}</a></td>
    <td><a href="/acm/problem/${info.id}" class="title">${info.title}</a>${tagLinks}</td>
    <td>${info.diff}</td><td>100</td><td></td>
  </tr></table>`;
}

test('backfill: fills nowcoder difficulty + repairs polluted title/empty tags', async () => {
  insertProblem('nowcoder', '16640', '[NOIP2007]纪念品分组\n     构造', null, []);
  insertProblem('nowcoder', '50039', 'kotori和气球', null, []);
  // 已有难度但标题污染 → 参与修复
  insertProblem('nowcoder', '280771', '小红的好数组\n     暴力', 700, []);
  // 健康题：不参与
  insertProblem('nowcoder', '321126', '小红的权值', 700, ['dp']);
  // CF：不参与（服务只处理 luogu/nowcoder）
  insertProblem('codeforces', '1662A', 'A', null, []);

  const fetchFn = router({
    'keyword=16640': () => ncListPage({ id: '16640', title: '纪念品分组', diff: '1049', tags: ['构造', '排序', '贪心'] }),
    'keyword=50039': () => ncListPage({ id: '50039', title: 'kotori和气球', diff: '800', tags: ['数学'] }),
    'keyword=280771': () => ncListPage({ id: '280771', title: '小红的好数组', diff: '700', tags: ['暴力'] }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const nc = results.find((r) => r.platform === 'nowcoder')!;
  assert.equal(nc.scanned, 3);
  assert.equal(nc.filled, 2); // 16640 / 50039
  assert.equal(nc.repaired, 1); // 280771
  assert.equal(nc.missing, 0);
  assert.equal(nc.failed, 0);

  const row = db.prepare("SELECT difficulty, title, tags FROM problems WHERE platform='nowcoder' AND problem_key='16640'").get() as any;
  assert.equal(row.difficulty, 1049);
  assert.equal(row.title, '纪念品分组');
  assert.deepEqual(JSON.parse(row.tags), ['构造', '排序', '贪心']);
  // CF 不动
  const cf = db.prepare("SELECT difficulty FROM problems WHERE platform='codeforces' AND problem_key='1662A'").get() as any;
  assert.equal(cf.difficulty, null);
});

test('backfill: keeps existing difficulty on repair, records official-missing', async () => {
  // 已有难度 700、标题污染；上游仍返回 700
  insertProblem('nowcoder', '280771', '小红的好数组\n     暴力', 700, []);
  // 未知难度；上游无难度分
  insertProblem('nowcoder', '20319', '红黑树', null, []);
  const fetchFn = router({
    'keyword=280771': () => ncListPage({ id: '280771', title: '小红的好数组', diff: '700', tags: ['暴力'] }),
    'keyword=20319': () => ncListPage({ id: '20319', title: '红黑树', diff: '', tags: ['树形dp'] }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const nc = results.find((r) => r.platform === 'nowcoder')!;
  assert.equal(nc.filled, 0);
  assert.equal(nc.repaired, 1);
  assert.equal(nc.missing, 1);
  const row = db.prepare("SELECT difficulty FROM problems WHERE problem_key='280771'").get() as any;
  assert.equal(row.difficulty, 700);
  // 官方无分但标签可用：元信息仍更新
  const m = db.prepare("SELECT difficulty, tags FROM problems WHERE problem_key='20319'").get() as any;
  assert.equal(m.difficulty, null);
  assert.deepEqual(JSON.parse(m.tags), ['树形dp']);
});

test('backfill: consecutive failures abort nowcoder queries (risk control)', async () => {
  for (let i = 0; i < 12; i += 1) insertProblem('nowcoder', String(90000 + i), `T${i}`, null, []);
  const fetchFn = router({
    'acm/problem/list': () => '<html>empty</html>', // 全部未命中
  });
  const results = await backfillDifficulties(db, fetchFn);
  const nc = results.find((r) => r.platform === 'nowcoder')!;
  assert.equal(nc.failed, 12);
  assert.equal(nc.filled, 0);
});

// ---------- 回填服务（洛谷） ----------

function luoguProblemJson(pid: string, difficulty: number, title: string, tags: number[] | string[]): unknown {
  // 新版 Lentille 结构：{ data: { problem: { name, tags: id[] } } }；tags 需经字典转换
  return { data: { problem: { pid, name: title, difficulty, tags } } };
}

test('backfill: fills luogu difficulty via single-problem API', async () => {
  insertProblem('luogu', 'P1001', 'A+B', null, ['入门', '模拟']);
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [{ id: 1, name: '入门' }, { id: 108, name: '模拟' }] }),
    'problem/P1001': () => luoguProblemJson('P1001', 1, 'A+B Problem', [1, 108]),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const lg = results.find((r) => r.platform === 'luogu')!;
  assert.equal(lg.scanned, 1);
  assert.equal(lg.filled, 1);
  const row = db.prepare("SELECT difficulty FROM problems WHERE problem_key='P1001'").get() as any;
  assert.equal(row.difficulty, 1000); // 洛谷难度 1（入门）→ CF 1000
});

test('backfill: luogu tag dict failure degrades (difficulty still filled)', async () => {
  insertProblem('luogu', 'P1002', 'X', null, []);
  const fetchFn = router({
    '_lfe/tags': () => ({ status: 403, body: '' }),
    'problem/P1002': () => luoguProblemJson('P1002', 3, 'X', [5, 9]),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const lg = results.find((r) => r.platform === 'luogu')!;
  assert.equal(lg.filled, 1);
  const row = db.prepare("SELECT difficulty FROM problems WHERE problem_key='P1002'").get() as any;
  assert.equal(row.difficulty, 1500);
});

test('backfill: luogu unrated difficulty (0) recorded as missing', async () => {
  insertProblem('luogu', 'P9999', 'X', null, []);
  const fetchFn = router({
    'problem/P9999': () => luoguProblemJson('P9999', 0, 'X', []),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const lg = results.find((r) => r.platform === 'luogu')!;
  assert.equal(lg.filled, 0);
  assert.equal(lg.missing, 1);
});

test('backfill: no targets returns empty results without any fetch', async () => {
  let fetched = 0;
  const fetchFn = router({
    'acm/problem/list': () => { fetched += 1; return ''; },
    'luogu.com.cn/problem': () => { fetched += 1; return ''; },
  });
  insertProblem('nowcoder', '1', 'ok', 800, ['dp']);
  insertProblem('luogu', 'P1000', 'ok', 1200, ['dp']);
  const results = await backfillDifficulties(db, fetchFn);
  assert.equal(results.length, 0);
  assert.equal(fetched, 0);
});

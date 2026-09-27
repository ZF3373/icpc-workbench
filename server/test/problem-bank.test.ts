import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import {
  fetchLuoguBank,
  fetchNowcoderBank,
  fetchAtcoderBank,
  fetchDaimayuanBank,
  hydroDifficulty,
  parseNcBankRows,
  parseJisuankeProblemTags,
} from '../src/adapters/problemBank.ts';
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
  assert.equal(p0.difficulty, 1000); // 洛谷难度 2 → CF 1000（统一实测表：2 → 1000）
  assert.equal(p0.nativeDifficulty, '2'); // 原生档位原文
  assert.equal(p0.difficultyScale, 'luogu-2026-06');
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
        `<td> ${diff} </td><td>100</td>` +
        // 操作列（收藏/加入题单）是真实页面恒定存在的最后一格，解析层用它做列结构校验（见 parseNcRowCells）
        `<td><a href="javascript:void(0);" data-id="${id}" class="js-collect-question ico-bank-item"></a></td></tr>`,
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
    difficulty: 800, // 站点分 700 低于 CF 下限 → 钳到 800（统一标尺）
    nativeDifficulty: '700', // 原生分原文（钳位前）
    difficultyScale: 'nowcoder-score',
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

/** 牛客题库每页 50 行：返回一个**满页**（含给定行 + 填充行），用于验证翻页与早停 */
function ncFullPage(extra: Array<[string, string, string]>, offset: number): string {
  const rows: Array<[string, string, string]> = [...extra];
  for (let i = rows.length; i < 50; i += 1) rows.push([String(900000 + offset + i), `填充${i}`, '1000']);
  return ncBankPage(rows, 14317);
}

test('nowcoder bank: pageDelayMs 覆盖页间间隔（回填把兜底抬到主机安全下限）', async () => {
  // 页间 sleep 是「不走全局节流层时的最后一道防线」：适配器自带的 500ms/页 远快于
  // ac.nowcoder.com 的安全下限，回填因此显式传入 FLOOR。这里断言该选项真的生效。
  const fetchFn = router({
    'acm/problem/list': (url) => (new URL(url).searchParams.get('page') === '1' ? ncFullPage([], 0) : ncFullPage([], 100)),
  });
  const fast0 = Date.now();
  await fetchNowcoderBank(fetchFn, { max: 100, pageDelayMs: 0 });
  const fast = Date.now() - fast0;
  const slow0 = Date.now();
  await fetchNowcoderBank(fetchFn, { max: 100, pageDelayMs: 2000 });
  const slow = Date.now() - slow0;
  assert.ok(fast < 2000, `pageDelayMs=0 不应等待（实测 ${fast}ms）`);
  assert.ok(slow >= 2000, `pageDelayMs=2000 必须等到 2000ms（实测 ${slow}ms）`);
});

test('nowcoder bank: wantKeys 全部命中即停（回填只为库里几道题，不必扫完整表）', async () => {
  const pages: string[] = [];
  const fetchFn = router({
    'acm/problem/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      pages.push(page ?? '');
      // 第 1 页含目标 50039；第 2 页另有目标 16640（不该被请求到）
      if (page === '1') return ncFullPage([['50039', 'kotori和气球', '800']], 0);
      return ncFullPage([['16640', '纪念品分组', '1500']], 100);
    },
  });
  const r = await fetchNowcoderBank(fetchFn, { max: 1000, wantKeys: new Set(['50039']) });
  assert.deepEqual(pages, ['1'], '目标题齐了就不再翻页');
  assert.ok(r.problems.some((p) => p.problemKey === '50039'));

  // 未给 wantKeys 时保持原行为：按 max 上限收工（每页恒满 → 靠 max 终止，不扫到 200 页）
  pages.length = 0;
  const r2 = await fetchNowcoderBank(fetchFn, { max: 100 });
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(r2.problems.length, 100);
});

test('nowcoder bank: wantKeys 未全部命中时照常翻页（不得提前收工）', async () => {
  const pages: string[] = [];
  const fetchFn = router({
    'acm/problem/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      pages.push(page ?? '');
      if (page === '1') return ncFullPage([], 0);
      return ncFullPage([['50039', 'kotori和气球', '800'], ['16640', '纪念品分组', '1500']], 100);
    },
  });
  const r = await fetchNowcoderBank(fetchFn, { max: 1000, wantKeys: new Set(['50039', '16640']) });
  assert.deepEqual(pages, ['1', '2'], '两个目标都在第 2 页才齐 → 必须翻到第 2 页');
  assert.ok(r.problems.some((p) => p.problemKey === '16640'));
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

test('atcoder bank: parses problems + models, maps θ through shared anchors', async () => {
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
  // θ 低于首锚点 -386 → 800（与同步路径同源，不再自行钳位）
  assert.equal(p0.difficulty, 800);
  assert.equal(p0.nativeDifficulty, '-848'); // 原生 θ 原文
  assert.equal(p0.difficultyScale, 'atcoder-kenkoooo-irt');
  assert.equal(p0.url, 'https://atcoder.jp/contests/abc138/tasks/abc138_a');
  assert.deepEqual(p0.tags, []);
  // θ=-364 刚过首锚点 -386：在 [-386,451] 段内线性插值 → 800 + 22/837×200 ≈ 805
  assert.equal(r.problems[1].difficulty, 805);
  // θ=1200 落在 [973,1545] 段（1500→1800）→ 1500 + 227/572×300 ≈ 1619
  assert.equal(r.problems[2].difficulty, 1619);
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

/**
 * 代码源（Hydro）题库 JSON 单页。实测 `GET /p?page=N` + `Accept: application/json` 返回
 * `{ page, pcount, ppcount, pdocs: [{ docId, title, tag, nSubmit, nAccept, difficulty }] }`
 * （difficulty=0 表示站点未设定档位，需按 Hydro difficultyAlgorithm 本地复算）。
 */
function dmyJsonPage(
  rows: Array<{ docId: number; title: string; tags?: string[]; difficulty?: number; nSubmit?: number; nAccept?: number }>,
  counts: { pcount?: number; ppcount?: number } = {},
): unknown {
  return {
    page: 1,
    ...counts,
    pdocs: rows.map((r) => ({
      docId: r.docId,
      title: r.title,
      tag: r.tags ?? [],
      difficulty: r.difficulty ?? 0,
      nSubmit: r.nSubmit ?? 0,
      nAccept: r.nAccept ?? 0,
    })),
  };
}

test('daimayuan bank: 读 JSON pdocs，难度按站点档位/Hydro 算法复算，标签取 tag', async () => {
  const fetchFn = router({
    '/p?page': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '1') {
        return dmyJsonPage(
          [
            // 站点未设定档位（difficulty=0）→ 本地复算：2136 提交 / 947 通过 → 4 档 → CF 1200
            { docId: 1, title: '[R1A]最大奇数', tags: ['模拟'], nSubmit: 2136, nAccept: 947 },
            // 站点手工档位优先于算法
            { docId: 2, title: '[R1B]砖块覆盖', tags: ['其他', '数学'], difficulty: 2 },
          ],
          { pcount: 466, ppcount: 5 },
        );
      }
      return dmyJsonPage([], { pcount: 466, ppcount: 5 }); // 第 2 页空 → 终止
    },
  });
  const r = await fetchDaimayuanBank(fetchFn, { max: 100 });
  assert.equal(r.platform, 'daimayuan');
  assert.equal(r.total, 466);
  assert.equal(r.problems.length, 2);
  const p0 = r.problems[0];
  assert.equal(p0.problemKey, '1');
  assert.equal(p0.title, '[R1A]最大奇数'); // JSON title 已是纯标题（HTML 路径需自行剥题号）
  assert.equal(p0.difficulty, 1200); // 4 档 → CF 1200（统一 Hydro 表：4 → 1200）
  assert.equal(p0.nativeDifficulty, '4');
  assert.equal(p0.difficultyScale, 'hydro-1-10');
  assert.equal(p0.url, 'https://bs.daimayuan.top/p/1');
  assert.deepEqual(p0.tags, ['模拟']);
  const p1 = r.problems[1];
  assert.equal(p1.difficulty, 900); // 2 档 → CF 900（统一 Hydro 表：2 → 900）
  assert.deepEqual(p1.tags, ['其他', '数学']);
});

test('daimayuan bank: 无提交统计且站点未设定档位 → 难度未知（null）', async () => {
  const fetchFn = router({
    '/p?page': () => dmyJsonPage([{ docId: 7, title: '新题', tags: ['模拟'] }], { pcount: 1, ppcount: 1 }),
  });
  const r = await fetchDaimayuanBank(fetchFn, { max: 10 });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].difficulty, null);
  assert.equal(r.problems[0].nativeDifficulty, null);
  assert.equal(r.problems[0].difficultyScale, 'hydro-1-10');
});

test('daimayuan bank: empty first page returns empty without error', async () => {
  const fetchFn = router({
    '/p?page': () => ({ pdocs: [] }),
  });
  const r = await fetchDaimayuanBank(fetchFn, {});
  assert.equal(r.problems.length, 0);
  assert.equal(r.total, null);
});

test('daimayuan bank: max option truncates result', async () => {
  const fetchFn = router({
    '/p?page': () => dmyJsonPage([
      { docId: 1, title: '题 A', tags: [], difficulty: 3 },
      { docId: 2, title: '题 B', tags: ['动态规划'], difficulty: 5 },
      { docId: 3, title: '题 C', tags: [], difficulty: 7 },
    ], { pcount: 466, ppcount: 5 }),
  });
  const r = await fetchDaimayuanBank(fetchFn, { max: 2 });
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[1].difficulty, 1400); // 难度 5 → CF 1400（统一 Hydro 表：5 → 1400）
});

test('daimayuan bank: HTTP failure throws', async () => {
  const fetchFn = router({
    '/p?page': () => ({ status: 503, body: '' }),
  });
  await assert.rejects(() => fetchDaimayuanBank(fetchFn, {}), /HTTP 503/);
});

// ---------- Task 4：按平台修正（牛客标签 / 代码源算法 / 计蒜客标签 / AtCoder 标签桥） ----------

test('代码源：Hydro 难度本地复算（站点 7 条实测样本表驱动）', () => {
  // 站点显示值 = pdoc.difficulty 优先（>0），否则 round(10 − 13·s·acRate)（s 为 nSubmit 的数值积分）
  const samples: Array<[nSubmit: number, nAccept: number, stored: number, displayed: number]> = [
    [2136, 947, 0, 4], // 算法分支（实测 R1A 最大奇数：JSON 原值 0，页面显示 4）
    [1280, 382, 4, 4],
    [618, 349, 5, 5],
    [766, 165, 6, 6],
    [341, 10, 9, 9],
    [1992, 602, 1, 1],
    [1030, 586, 2, 2],
  ];
  for (const [nSubmit, nAccept, stored, displayed] of samples) {
    assert.equal(
      hydroDifficulty(nSubmit, nAccept, stored),
      displayed,
      `样本 nSubmit=${nSubmit} nAccept=${nAccept} stored=${stored}`,
    );
  }
  assert.equal(hydroDifficulty(2136, 947, 4), 4); // 站点手工设定值优先于算法
  assert.equal(hydroDifficulty(0, 0, null), null); // 无提交统计 → 未知（不猜）
});

test('计蒜客：problemTags 双类型解析（difficulty / knowledge）', () => {
  const parsed = parseJisuankeProblemTags([
    { tagName: '入门', type: 'difficulty' },
    { tagName: '输入和输出', type: 'knowledge' },
    { tagName: '数学', type: 'knowledge' },
  ]);
  assert.equal(parsed.difficulty, '入门');
  assert.deepEqual(parsed.knowledge, ['输入和输出', '数学']);
  assert.deepEqual(parseJisuankeProblemTags(undefined), { difficulty: null, knowledge: [] });
});

test('牛客：题库行解析出算法标签，且标题不混入标签文本', () => {
  const html = `<tr data-problemId="19842">
    <td><a href="/acm/problem/19842">NC19842</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/19842">约数</a>
      <a class="tag-label js-tag" data-id="145480">gcd与exgcd</a>
      <a class="tag-label js-tag" data-id="145607">数论</a></td>
    <td> 1500 </td><td>926</td>
    <td><a href="javascript:void(0);" data-id="19842" class="js-collect-question"></a></td></tr>`;
  const rows = parseNcBankRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].problemId, '19842');
  assert.equal(rows[0].difficulty, 1500); // 难度恒紧随标题单元格（colspan 行不得按列下标硬取）
  assert.equal(rows[0].nativeScore, 1500); // 原生分原文（映射前的站点值）
  assert.deepEqual(rows[0].tags, ['gcd与exgcd', '数论']);
  assert.equal(rows[0].title, '约数');
});

test('牛客：非整百分值的真实难度分照常采纳（老题实测 926 / 623 / 1049 都存在）', () => {
  // 历史缺陷：校验器曾要求「100 的倍数」，把老题的真实难度判成未知 —— 2026-09-27 逐题实测纠正，
  // 站上难度列确实给出 NC22014=623、NC22158=726、NC24739=972、NC16640=1049 这类值。
  // 注意：原生分照原文采纳（nativeScore），映射后的 CF 难度按统一标尺钳到 [800,3500]。
  for (const diff of ['926', '623', '726', '972', '1049']) {
    const html = `<tr data-problemId="1"><td><a href="/acm/problem/1">NC1</a></td>
      <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/1">Hello</a></td>
      <td> ${diff} </td><td>100</td>
      <td><a href="javascript:void(0);" data-id="1" class="js-collect-question"></a></td></tr>`;
    const rows = parseNcBankRows(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].nativeScore, Number(diff), `难度分 ${diff} 应被采纳为原生值`);
    assert.equal(rows[0].difficulty, Math.max(800, Math.min(3500, Number(diff))));
    assert.deepEqual(rows[0].tags, []);
  }
});

test('牛客：难度单元格为空时取未知，绝不顺延到相邻列（通过数不得被伪造成难度）', () => {
  // 通过数恰好也是 200..4000 内的整数：若扫描顺延到相邻列就会凭空造出难度
  const html = `<tr data-problemId="2"><td><a href="/acm/problem/2">NC2</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/2">空难度题</a></td>
    <td></td><td>100</td>
    <td><a href="javascript:void(0);" data-id="2" class="js-collect-question"></a></td></tr>
    <tr data-problemId="3"><td><a href="/acm/problem/3">NC3</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/3">空难度题二</a></td>
    <td> </td><td>200</td>
    <td><a href="javascript:void(0);" data-id="3" class="js-collect-question"></a></td></tr>`;
  const rows = parseNcBankRows(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].difficulty, null);
  assert.equal(rows[0].nativeScore, null);
  assert.equal(rows[1].difficulty, null);
  assert.equal(rows[1].nativeScore, null);
});

test('牛客：列结构异常（缺操作列）时不猜难度 —— 结构校验替代了「整百分值」护栏', () => {
  // 放宽数值域后，防串列必须靠结构：这里把操作列去掉（真实页面恒有），难度数字本身合法也不采纳。
  const html = `<tr data-problemId="7"><td><a href="/acm/problem/7">NC7</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/7">结构异常行</a></td>
    <td>1500</td><td>245</td></tr>`;
  const rows = parseNcBankRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].difficulty, null);
  assert.equal(rows[0].nativeScore, null);
});

test('牛客：没有标题单元格时不猜难度（数字题号列不得被当作难度）', () => {
  // 行内无 class="title" 锚点 → 位置关系无从判断 → 难度未知（不得从 tds[0] 起顺延：
  // 修复前 tds[0] 的数字题号 400 会被当成难度分 → difficulty 800）。
  // 该行带一个算法标签，避免被「标题与标签皆空 → 跳过」规则吞掉，从而能断言难度为 null。
  const html = `<tr data-problemId="400"><td>400</td><td class="fn-right" colspan="2">无标题锚点
    <a class="tag-label js-tag">模拟</a></td><td>1500</td><td>245</td>
    <td><a href="javascript:void(0);" data-id="400" class="js-collect-question"></a></td></tr>`;
  const rows = parseNcBankRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '');
  assert.equal(rows[0].difficulty, null);
  assert.equal(rows[0].nativeScore, null);
  assert.deepEqual(rows[0].tags, ['模拟']);
});

test('牛客：越界/非数字难度分一律未知（1049 这类真实老题值是合法难度，不再被误杀）', () => {
  const row = (diff: string): string => `<tr data-problemId="9"><td><a href="/acm/problem/9">NC9</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/9">题</a></td>
    <td> ${diff} </td><td>245</td>
    <td><a href="javascript:void(0);" data-id="9" class="js-collect-question"></a></td></tr>`;
  for (const diff of ['100', '5000', 'abc']) {
    const rows = parseNcBankRows(row(diff));
    assert.equal(rows[0].difficulty, null, `难度分 ${diff} 应为未知`);
    assert.equal(rows[0].nativeScore, null);
  }
  assert.equal(parseNcBankRows(row('1049'))[0].difficulty, 1049); // 实测存在的真实难度（NC16640）
});

test('luogu bank: luoguTypes 多类型依次拉取（默认仅 P）', async () => {
  const seen: string[] = [];
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [] }),
    'problem/list': (url) => {
      const u = new URL(url);
      const type = u.searchParams.get('type') ?? '';
      const page = u.searchParams.get('page') ?? '';
      seen.push(`${type}:${page}`);
      // 首页满页（50）→ 继续翻页；第 2 页空 → 该类型结束，进入下一类型
      return page === '1'
        ? luoguPage(Array.from({ length: 50 }, (_, i) => `${type}${1000 + i}`), 100)
        : luoguPage([], 100);
    },
  });
  await fetchLuoguBank(fetchFn, { max: 200, luoguTypes: ['P', 'CF'] });
  assert.deepEqual(seen, ['P:1', 'P:2', 'CF:1', 'CF:2']); // 每类型翻到空页为止
});

test('atcoder bank: 洛谷 AT 镜像标签桥（默认关闭，计数如实上报）', async () => {
  const luoguList = {
    data: {
      problems: {
        count: 3,
        perPage: 50,
        result: [
          { pid: 'AT_abc300_a', tags: [2] },
          { pid: 'AT_abc300_b', tags: [] },
          { pid: 'AT1202Contest_a', tags: [2] }, // 洛谷自定义比赛号：无法映射为 AtCoder 题号
        ],
      },
    },
  };
  const kenkoooo = [
    { id: 'abc300_a', contest_id: 'abc300', name: 'A', title: 'A - A' },
    { id: 'abc300_b', contest_id: 'abc300', name: 'B', title: 'B - B' },
  ];
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [{ id: 2, name: '模拟' }] }),
    'problem/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      // 第 2 页空 → 标签桥终止（否则 mock 会对每一页都回同一份数据）
      return page === '1' ? luoguList : { data: { problems: { count: 3, perPage: 50, result: [] } } };
    },
    'resources/problems.json': () => kenkoooo,
    'resources/problem-models.json': () => ({ abc300_a: { difficulty: 800 }, abc300_b: { difficulty: 800 } }),
  });
  const r = await fetchAtcoderBank(fetchFn, { max: 10, atcoderTagsFromLuogu: true });
  assert.equal(r.tagScanned, 3);
  assert.equal(r.tagMatched, 2); // 洛谷 AT 镜像中 id 命中 kenkoooo 的行数
  assert.equal(r.tagWithTags, 1); // 其中真正带洛谷标签的行数
  assert.equal(r.tagSkipped, 1); // 不可映射 / 未命中
  assert.deepEqual(r.problems[0].tags, ['模拟']);
  assert.deepEqual(r.problems[1].tags, []);
});

test('atcoder bank: 无桥时不做洛谷请求，也不上报标签计数', async () => {
  let luoguCalls = 0;
  const fetchFn = router({
    'problem/list': () => {
      luoguCalls += 1;
      return { data: { problems: { result: [] } } };
    },
    'resources/problems.json': () => [{ id: 'abc300_a', contest_id: 'abc300', title: 'A - A' }],
    'resources/problem-models.json': () => ({ abc300_a: { difficulty: 800 } }),
  });
  const r = await fetchAtcoderBank(fetchFn, { max: 10 });
  assert.equal(luoguCalls, 0);
  assert.equal(r.tagMatched, undefined);
  assert.equal(r.tagScanned, undefined);
  assert.deepEqual(r.problems[0].tags, []);
});

// ---------- 入库服务 ----------

test('upsertBankProblems: inserts new, updates existing, keeps manual difficulty', () => {
  // 预置一道已存在题（手动导入途径，difficulty=1800 且标为 manual 来源）
  db.prepare(
    "INSERT INTO problems (platform, problem_key, title, difficulty, difficulty_source, url, tags) VALUES ('luogu', 'P1001', '旧标题', 1800, 'manual', 'https://x', '[]')",
  ).run();
  const r = upsertBankProblems(db, [
    { platform: 'luogu', problemKey: 'P1001', title: '新标题', difficulty: 1300, nativeDifficulty: null, difficultyScale: null, url: 'https://www.luogu.com.cn/problem/P1001', tags: ['dp'] },
    { platform: 'luogu', problemKey: 'P2002', title: '题 B', difficulty: 1700, nativeDifficulty: null, difficultyScale: null, url: 'https://www.luogu.com.cn/problem/P2002', tags: ['图论'] },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].inserted, 1);
  assert.equal(r[0].updated, 1);
  const rows = db
    .prepare('SELECT problem_key, title, difficulty, tags FROM problems ORDER BY problem_key')
    .all() as Array<{ problem_key: string; title: string; difficulty: number; tags: string }>;
  assert.equal(rows.length, 2);
  // 已存在：标题更新、难度保留手动值（1800，来源优先级 manual(4) > bank(1)）、标签写入即净化
  assert.equal(rows[0].problem_key, 'P1001');
  assert.equal(rows[0].title, '新标题');
  assert.equal(rows[0].difficulty, 1800);
  assert.deepEqual(JSON.parse(rows[0].tags), ['动态规划']); // 'dp' 写入即归并为规范名
  // 新增
  assert.equal(rows[1].problem_key, 'P2002');
  assert.equal(rows[1].difficulty, 1700);
});

test('upsertBankProblems: 题库难度不覆盖同步来的难度（bank(1) < sync(2)）', () => {
  db.prepare(
    "INSERT INTO problems (platform, problem_key, title, difficulty, difficulty_source, url, tags) VALUES ('luogu', 'P3003', '旧标题', 2000, 'sync', 'https://x', '[]')",
  ).run();
  upsertBankProblems(db, [
    { platform: 'luogu', problemKey: 'P3003', title: '新标题', difficulty: 1200, nativeDifficulty: null, difficultyScale: null, url: null, tags: [] },
  ]);
  const row = db.prepare("SELECT difficulty, difficulty_source FROM problems WHERE problem_key = 'P3003'").get() as {
    difficulty: number;
    difficulty_source: string;
  };
  assert.equal(row.difficulty, 2000);
  assert.equal(row.difficulty_source, 'sync');
});

test('upsertBankProblems: empty tags do not overwrite existing tags', () => {
  db.prepare(
    "INSERT INTO problems (platform, problem_key, title, difficulty, url, tags) VALUES ('nowcoder', '10001', 'T', 1000, 'https://x', '[\"dp\"]')",
  ).run();
  upsertBankProblems(db, [
    { platform: 'nowcoder', problemKey: '10001', title: 'T', difficulty: 1000, nativeDifficulty: null, difficultyScale: null, url: null, tags: [] },
  ]);
  const row = db
    .prepare('SELECT tags FROM problems WHERE problem_key = 10001')
    .get() as { tags: string };
  assert.deepEqual(JSON.parse(row.tags), ['dp']);
});

test('upsertBankProblems: bank problems do not create submissions (stats unaffected)', () => {
  upsertBankProblems(db, [
    { platform: 'luogu', problemKey: 'P9001', title: '题库题', difficulty: 1500, nativeDifficulty: null, difficultyScale: null, url: 'https://x', tags: [] },
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
    { platform: 'luogu', problemKey: 'P_IN', title: '区间内题', difficulty: 1500, nativeDifficulty: null, difficultyScale: null, url: 'https://www.luogu.com.cn/problem/P_IN', tags: ['dp'] },
    { platform: 'luogu', problemKey: 'P_EASY', title: '水题', difficulty: 800, nativeDifficulty: null, difficultyScale: null, url: 'https://www.luogu.com.cn/problem/P_EASY', tags: [] },
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

// ---------- 服务端分页与分面（P0-2 / P1-2） ----------

interface PageBody {
  items: Array<{ problem_key: string; difficulty: number | null; status: string; tags: string[] }>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 造 n 道有提交记录的题：难度 800..800+n-1（键唯一，供分页/分桶测试用） */
function seedMany(db: Db, n: number): void {
  const subs: NormalizedSubmission[] = Array.from({ length: n }, (_, i) =>
    sub(`PG${i}`, 800 + i, `pg-${i}`),
  );
  insertNormalized(db, 1, subs);
}

test('GET /api/problems/page: 分页返回总数，且各页无重叠无遗漏', async () => {
  await withServer(
    async (base) => {
      const p1 = (await (await fetch(`${base}/page?page=1&pageSize=10`)).json()) as PageBody;
      assert.equal(p1.total, 25);
      assert.equal(p1.items.length, 10);
      assert.equal(p1.page, 1);
      assert.equal(p1.hasMore, true);

      const p3 = (await (await fetch(`${base}/page?page=3&pageSize=10`)).json()) as PageBody;
      assert.equal(p3.items.length, 5);
      assert.equal(p3.hasMore, false);

      // 三页并集 = 全集，且互不重叠（游标稳定：ORDER BY 带 p.id 兜底，无重复/漏行）
      const p2 = (await (await fetch(`${base}/page?page=2&pageSize=10`)).json()) as PageBody;
      const keys = [...p1.items, ...p2.items, ...p3.items].map((i) => i.problem_key);
      assert.equal(new Set(keys).size, 25);
    },
    undefined,
    (d) => seedMany(d, 25),
  );
});

test('GET /api/problems/page: total 与状态过滤口径一致（ac/tried/none）', async () => {
  // 10 题：4 AC / 3 仅尝试 / 3 无提交（无提交者需 bank=1 才在候选集内）
  await withServer(
    async (base) => {
      const ac = (await (await fetch(`${base}/page?status=ac&pageSize=50`)).json()) as PageBody;
      assert.equal(ac.total, 4);
      assert.ok(ac.items.every((i) => i.status === 'ac'));

      const tried = (await (await fetch(`${base}/page?status=tried&pageSize=50`)).json()) as PageBody;
      assert.equal(tried.total, 3);
      assert.ok(tried.items.every((i) => i.status === 'tried'));

      // none 需要 bank=1 才可能命中（无提交的题缺省不可见）
      const noneBank = (await (await fetch(`${base}/page?status=none&bank=1&pageSize=50`)).json()) as PageBody;
      assert.equal(noneBank.total, 3);
      assert.ok(noneBank.items.every((i) => i.status === 'none'));

      // 与旧数组路径交叉核对：不带 status 时总数一致（口径未漂移）
      const all = (await (await fetch(`${base}/page?bank=1&pageSize=50`)).json()) as PageBody;
      assert.equal(all.total, 10);
    },
    undefined,
    (d) => {
      const subs: NormalizedSubmission[] = [];
      for (let i = 0; i < 4; i += 1) subs.push(sub(`AC${i}`, 900 + i, `ac-${i}`, 'AC'));
      for (let i = 0; i < 3; i += 1) subs.push(sub(`TRIED${i}`, 1500 + i, `tried-${i}`, 'WA'));
      insertNormalized(d, 1, subs);
      // 3 道纯题库题（无提交记录）
      upsertBankProblems(d, Array.from({ length: 3 }, (_, i) => ({
        platform: 'luogu' as const,
        problemKey: `NONE${i}`,
        title: `未做题 ${i}`,
        difficulty: 1200,
        nativeDifficulty: null,
        difficultyScale: null,
        url: `https://www.luogu.com.cn/problem/NONE${i}`,
        tags: [],
      })));
    },
  );
});

test('GET /api/problems/page: 难度分桶与区间过滤下推到 SQL（含「未知」桶）', async () => {
  await withServer(
    async (base) => {
      // 造数难度 800..822，全部落在 <1200 桶内
      const low = (await (await fetch(`${base}/page?difficulty=${encodeURIComponent('<1200')}&pageSize=50`)).json()) as PageBody;
      assert.equal(low.total, 23);
      assert.ok(low.items.every((i) => (i.difficulty ?? 0) < 1200));

      // 显式区间：800..1000 闭区间
      const range = (await (await fetch(`${base}/page?diffMin=800&diffMax=1000&pageSize=50`)).json()) as PageBody;
      assert.equal(range.total, 23);
      assert.ok(range.items.every((i) => i.difficulty !== null && i.difficulty >= 800 && i.difficulty <= 1000));

      // 空桶
      const high = (await (await fetch(`${base}/page?difficulty=${encodeURIComponent('1200-1399')}&pageSize=50`)).json()) as PageBody;
      assert.equal(high.total, 0);

      // 「未知」桶只含 difficulty IS NULL 的题（1 道题库题）
      const unknown = (await (await fetch(`${base}/page?difficulty=${encodeURIComponent('未知')}&bank=1&pageSize=50`)).json()) as PageBody;
      assert.equal(unknown.total, 1);
      assert.equal(unknown.items[0].difficulty, null);
    },
    undefined,
    (d) => {
      seedMany(d, 23);
      upsertBankProblems(d, [
        { platform: 'luogu', problemKey: 'NODIFF', title: '无难度题', difficulty: null, nativeDifficulty: null, difficultyScale: null, url: 'https://www.luogu.com.cn/problem/NODIFF', tags: [] },
      ]);
    },
  );
});

test('GET /api/problems/page: tag 筛选命中同义别名（与旧数组路径同口径）', async () => {
  await withServer(
    async (base) => {
      const cfSub = sub('1001A', 1500, 'e-pg-alias');
      cfSub.problem.tags = ['binary search'];
      const byCn = (await (await fetch(`${base}/page?tag=${encodeURIComponent('二分')}`)).json()) as PageBody;
      assert.equal(byCn.total, 1);
      assert.equal(byCn.items[0].problem_key, '1001A');
    },
    undefined,
    (d) => {
      const cfSub = sub('1001A', 1500, 'e-pg-alias');
      cfSub.problem.tags = ['binary search'];
      insertNormalized(d, 1, [cfSub]);
    },
  );
});

test('GET /api/problems/facets: 返回难度/平台/标签分面计数（标签已归并规范名）', async () => {
  await withServer(
    async (base) => {
      const f = (await (await fetch(`${base}/facets`)).json()) as {
        total: number;
        difficulty: Record<string, number>;
        platforms: Array<{ id: string; count: number }>;
        tags: Array<{ tag: string; count: number }>;
      };
      assert.equal(f.total, 3);
      assert.equal(f.difficulty['<1200'], 2);
      assert.equal(f.difficulty['1400-1599'], 1);
      assert.equal(f.platforms.find((p) => p.id === 'codeforces')?.count, 3);
      // dp → 动态规划 归并计数；噪声标签（年份）不出现
      assert.equal(f.tags.find((t) => t.tag === '动态规划')?.count, 2);
      assert.equal(f.tags.find((t) => t.tag === 'dp'), undefined);
      assert.equal(f.tags.find((t) => t.tag === '2026'), undefined);
    },
    undefined,
    (d) => {
      const a = sub('F1', 900, 'f-1');
      a.problem.tags = ['dp', '2026']; // dp → 动态规划；2026 为噪声标签
      const b = sub('F2', 1000, 'f-2');
      b.problem.tags = ['动态规划']; // 与 a 归并到同一规范名
      const c = sub('F3', 1500, 'f-3');
      c.problem.tags = ['greedy']; // greedy → 贪心
      insertNormalized(d, 1, [a, b, c]);
    },
  );
});

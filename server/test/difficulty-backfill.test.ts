import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import {
  parseNcSearchRow,
  cleanNcTitle,
  backfillDifficulties,
  pickBackfillTargets,
} from '../src/analysis/difficultyBackfill.ts';
import { parseNcBankRows } from '../src/adapters/problemBank.ts';

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
        // 仅数字 status 视为 {status, body} Response 约定（CF 响应自带 status:'OK' 字符串字段）
        if (v && typeof v === 'object' && 'status' in v && typeof (v as { status: unknown }).status === 'number') {
          const r = v as { status: number; body: string; headers?: Record<string, string> };
          return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
        }
        return new Response(JSON.stringify(v), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

// ---------- 回填目标选择（Task 5：全平台） ----------

test('回填目标选择：未知难度/无原生值/无标签，且排除 QOJ', () => {
  const db = createDb(':memory:');
  const ins = db.prepare(`INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, difficulty_source, native_difficulty, difficulty_scale)
    VALUES (?, ?, ?, ?, NULL, ?, 'sync', ?, ?)`);
  ins.run('luogu', 'P1', 'A', 1800, '["dp"]', '4', 'luogu-2026-06'); // 完整 → 不入选
  ins.run('luogu', 'P2', 'B', null, '["dp"]', null, null); // 无难度 → 入选
  ins.run('nowcoder', 'NC1', 'C', 1500, '[]', '1500', 'nowcoder-score'); // 无标签 → 入选（覆盖 NC 标签缺失）
  ins.run('qoj', 'Q1', 'D', null, '[]', null, null); // QOJ 无数据来源 → 排除
  const targets = pickBackfillTargets(db);
  assert.deepEqual(
    targets.map((t) => `${t.platform}:${t.problemKey}`).sort(),
    ['luogu:P2', 'nowcoder:NC1'],
  );
  assert.deepEqual(targets.find((t) => t.problemKey === 'P2'), {
    platform: 'luogu',
    problemKey: 'P2',
    title: 'B',
    difficulty: null,
    nativeDifficulty: null,
    tags: ['dp'],
  });
  db.close();
});

// ---------- 全平台元数据回填 ----------

test('回填：codeforces 整表一次补齐难度/原生/标签，并计入 nativeFilled', async () => {
  const calls: string[] = [];
  // 无难度的题 + 有难度无原生的题（两条都要走 CF 整表）
  insertProblem('codeforces', '1001A', 'Theatre Square', null, []);
  insertProblem('codeforces', '1001B', 'B', 1200, [], { scale: null });
  // 过时难度（旧映射留下的 900，来源 sync）→ 回填按上游值修正
  insertProblem('codeforces', '1001C', 'C', 900, ['dp'], { scale: null });
  // 用户手动标定的难度（manual）→ 回填绝不覆盖
  insertProblem('codeforces', '1001D', 'D', 2500, ['dp'], { source: 'manual' });
  const fetchFn = router({
    'problemset.problems': (url) => {
      calls.push(url);
      return {
        status: 'OK',
        result: {
          problems: [
            { contestId: 1001, index: 'A', name: 'Theatre Square', rating: 1000, tags: ['math'] },
            { contestId: 1001, index: 'B', name: 'B', rating: 1200, tags: ['dp'] },
            { contestId: 1001, index: 'C', name: 'C', rating: 1500, tags: ['greedy'] },
            { contestId: 1001, index: 'D', name: 'D', rating: 800, tags: ['greedy'] },
          ],
        },
      };
    },
  });
  const results = await backfillDifficulties(db, fetchFn);
  const cf = results.find((r) => r.platform === 'codeforces')!;
  assert.equal(cf.scanned, 4);
  assert.equal(cf.filled, 1); // 只有 1001A 原本难度为空
  assert.equal(cf.nativeFilled, 3); // A/B/C 的原生难度由 NULL 补上（D 为 manual → 三元组整体不动）
  assert.equal(calls.length, 1); // 整表只拉一次（不是逐题）
  const a = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale, difficulty_source, tags FROM problems WHERE problem_key='1001A'").get() as any;
  assert.equal(a.difficulty, 1000);
  assert.equal(a.native_difficulty, '1000');
  assert.equal(a.difficulty_scale, 'cf-rating');
  assert.equal(a.difficulty_source, 'backfill');
  assert.deepEqual(JSON.parse(a.tags), ['数学（综合）']); // math → 数学（综合）（写入即净化）
  const b = db.prepare("SELECT difficulty, native_difficulty, tags FROM problems WHERE problem_key='1001B'").get() as any;
  assert.equal(b.difficulty, 1200); // 已有难度与上游一致 → 值不变
  assert.equal(b.native_difficulty, '1200');
  assert.deepEqual(JSON.parse(b.tags), ['动态规划']);
  const c = db.prepare("SELECT difficulty, difficulty_source FROM problems WHERE problem_key='1001C'").get() as any;
  assert.equal(c.difficulty, 1500); // sync 来源的过时值被回填修正
  assert.equal(c.difficulty_source, 'backfill');
  const d = db.prepare("SELECT difficulty, difficulty_source FROM problems WHERE problem_key='1001D'").get() as any;
  assert.equal(d.difficulty, 2500); // manual(4) 高于 backfill(3) → 不被覆盖
  assert.equal(d.difficulty_source, 'manual');
});

test('回填：leetcode 走 problemsetQuestionList 分页扫描（一次扫描覆盖全库）', async () => {
  insertProblem('leetcode', 'two-sum', '两数之和', null, []);
  insertProblem('leetcode', 'n-queens', 'N 皇后', null, []);
  const bodies: string[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ''));
    return new Response(
      JSON.stringify({
        data: {
          problemsetQuestionList: {
            total: 2,
            questions: [
              { frontendQuestionId: '1', title: 'Two Sum', titleCn: '两数之和', titleSlug: 'two-sum', difficulty: 'Easy', paidOnly: false, topicTags: [{ name: 'Array', nameTranslated: '数组' }] },
              { frontendQuestionId: '51', title: 'N-Queens', titleCn: 'N 皇后', titleSlug: 'n-queens', difficulty: 'Hard', paidOnly: false, topicTags: [{ name: 'Backtracking', nameTranslated: '回溯' }] },
            ],
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const results = await backfillDifficulties(db, fetchFn);
  const lc = results.find((r) => r.platform === 'leetcode')!;
  assert.equal(lc.scanned, 2);
  assert.equal(lc.filled, 2);
  assert.equal(lc.nativeFilled, 2);
  assert.ok(bodies[0].includes('problemsetQuestionList'), '力扣回填必须走 problemsetQuestionList 分页扫描');
  assert.ok(!bodies.some((b) => b.includes('question(')), '不得逐题 question(titleSlug) 查询');
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale, tags FROM problems WHERE problem_key='n-queens'").get() as any;
  assert.equal(row.difficulty, 2100); // Hard → 2100
  assert.equal(row.native_difficulty, 'Hard'); // 原生原文（首字母大写形态）
  assert.equal(row.difficulty_scale, 'leetcode-tier');
  assert.deepEqual(JSON.parse(row.tags), ['DFS 与回溯']); // 中文标签优先（回溯 → 规范名 DFS 与回溯）
});

test('回填：代码源逐题 JSON（/p/{docId}），难度按 Hydro 算法复算', async () => {
  insertProblem('daimayuan', '1', '[R1A]最大奇数', null, []);
  const fetchFn = router({
    'bs.daimayuan.top/p/1': () => ({
      pdoc: { docId: 1, title: '[R1A]最大奇数', tag: ['模拟'], nSubmit: 2136, nAccept: 947, difficulty: 0 },
    }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const dmy = results.find((r) => r.platform === 'daimayuan')!;
  assert.equal(dmy.scanned, 1);
  assert.equal(dmy.filled, 1);
  assert.equal(dmy.nativeFilled, 1);
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale, tags FROM problems WHERE problem_key='1'").get() as any;
  assert.equal(row.difficulty, 1200); // 算法复算 4 档 → CF 1200
  assert.equal(row.native_difficulty, '4');
  assert.equal(row.difficulty_scale, 'hydro-1-10');
  assert.deepEqual(JSON.parse(row.tags), ['模拟']);
});

test('回填：计蒜客题库批量一次扫描（problemTags 提供难度与知识点）', async () => {
  insertProblem('jisuanke', 'T1001', '计算A+B', null, []);
  const seenPages: string[] = [];
  const fetchFn = router({
    'jisuanke.com/api/problems': (url) => {
      const page = new URL(url).searchParams.get('page');
      seenPages.push(page ?? '');
      if (page !== '1') return { total: 2, problems: [] };
      return {
        total: 2,
        problems: [
          {
            problemId: 34486,
            problemIdentifier: 'T1001',
            title: '计算A+B',
            difficultyType: 'level1',
            problemTags: [
              { tagName: '入门', type: 'difficulty' },
              { tagName: '输入和输出', type: 'knowledge' },
            ],
          },
        ],
      };
    },
  });
  const results = await backfillDifficulties(db, fetchFn);
  const jsk = results.find((r) => r.platform === 'jisuanke')!;
  assert.equal(jsk.scanned, 1);
  assert.equal(jsk.filled, 1);
  assert.equal(jsk.nativeFilled, 1);
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale, tags FROM problems WHERE problem_key='T1001'").get() as any;
  assert.equal(row.difficulty, 800);
  assert.equal(row.native_difficulty, 'level1');
  assert.equal(row.difficulty_scale, 'jisuanke-level-8');
  assert.deepEqual(JSON.parse(row.tags), ['输入和输出']); // 只取 knowledge 类标签
  assert.deepEqual(seenPages, ['1']); // 目标题已找到 → 批量扫描提前结束
});

test('回填：atcoder 用 kenkoooo 整表，θ 走统一分段映射', async () => {
  insertProblem('atcoder', 'abc321_a', 'A - 321-like Checker', null, []);
  const fetchFn = router({
    'resources/problems.json': () => [{ id: 'abc321_a', contest_id: 'abc321', title: 'A - 321-like Checker' }],
    'resources/problem-models.json': () => ({ abc321_a: { difficulty: 125 } }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const at = results.find((r) => r.platform === 'atcoder')!;
  assert.equal(at.scanned, 1);
  assert.equal(at.filled, 1);
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_scale FROM problems WHERE problem_key='abc321_a'").get() as any;
  assert.equal(row.difficulty, 922); // θ=125 由低段斜率映射（不再硬钳 800）
  assert.equal(row.native_difficulty, '125');
  assert.equal(row.difficulty_scale, 'atcoder-kenkoooo-irt');
});

test('回填：上游无难度的题记 missing，且不写 difficulty_source', async () => {
  insertProblem('luogu', 'P9998', '无评定题', null, [], { source: 'sync' });
  const fetchFn = router({
    'problem/P9998': () => ({ data: { problem: { pid: 'P9998', name: '无评定题', difficulty: 0, tags: [] } } }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const lg = results.find((r) => r.platform === 'luogu')!;
  assert.equal(lg.filled, 0);
  assert.equal(lg.missing, 1);
  const row = db.prepare("SELECT difficulty, native_difficulty, difficulty_source FROM problems WHERE problem_key='P9998'").get() as any;
  assert.equal(row.difficulty, null);
  assert.equal(row.native_difficulty, '0'); // 洛谷 0 = 暂无评定：原生原文照落库（如实记录上游状态）
  // 注意：落了原生原文并不会让该题退出回填目标 —— 目标选择还看 difficulty IS NULL，
  // 所以永久未评级的题每次回填仍会被重新查询（本次运行上限 capped 之前，这是已知代价）
  assert.equal(row.difficulty_source, 'sync'); // 难度未变 → 来源不被改写
});

// ---------- 牛客搜索行解析 ----------

const NC_ROW_HTML = `
<tr data-problemId="16640">
  <td><a href="/acm/problem/16640">NC16640</a></td>
  <td class="fn-right" colspan="2">
    <a href="/acm/problem/16640" target="_blank" class="title">[NOIP2007]纪念品分组</a>
    <a href="javascript:void(0);" class="tag-label js-tag" data-id="1">构造</a>
    <a href="javascript:void(0);" class="tag-label js-tag" data-id="2">贪心</a>
  </td>
  <td> 1500 </td><td>100</td><td></td>
</tr>`;

test('parseNcSearchRow: separates title/tags/difficulty', () => {
  const info = parseNcSearchRow(NC_ROW_HTML, '16640');
  assert.ok(info);
  assert.equal(info!.difficulty, 1500); // 站点难度分网格值（200..4000、100 的倍数）
  assert.equal(info!.nativeDifficulty, '1500');
  assert.equal(info!.title, '[NOIP2007]纪念品分组');
  assert.deepEqual(info!.tags, ['构造', '贪心']);
});

test('parseNcSearchRow: no hit returns null; no-difficulty row returns null difficulty', () => {
  assert.equal(parseNcSearchRow('<html></html>', '99999'), null);
  const noDiff = NC_ROW_HTML.replace('<td> 1500 </td>', '<td> </td>');
  const info = parseNcSearchRow(noDiff, '16640');
  assert.ok(info);
  assert.equal(info!.difficulty, null);
});

test('parseNcSearchRow: 离网/越界难度分一律未知（与题库读取方共用同一校验器）', () => {
  // 通过数列的 1049 这类离网值过去会被本读取方当成有效难度（题库读取方却当未知），
  // 而 backfill(3) 又会覆盖 bank(1) → 同一行两套结论。统一校验器后两边一致为「未知」。
  for (const diff of ['1049', '100', '5000']) {
    const info = parseNcSearchRow(NC_ROW_HTML.replace('<td> 1500 </td>', `<td> ${diff} </td>`), '16640');
    assert.ok(info);
    assert.equal(info!.difficulty, null, `难度分 ${diff} 应为未知`);
    assert.equal(info!.nativeDifficulty, null);
  }
});

test('parseNcSearchRow: 与题库路径共用同一套「标题锚点 + 后一格」定位规则（列数变动不改变结论）', () => {
  // 真实页面形态：标题单元格带 colspan="2"，行内 td 数与列数并不对应；
  // 某些行还会多出一列（勾选框/序号），此时任何按列下标硬取（旧实现取 tds[2]）的读取方
  // 都会取到标题单元格 → 同一行对回填路径「未知」、对题库路径 1500，而 backfill(3) 优先级更高。
  const shifted = `<tr data-problemId="16640">
    <td class="text-center"><input type="checkbox"/></td>
    <td><a href="/acm/problem/16640">NC16640</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/16640">纪念品分组</a></td>
    <td> 1500 </td><td>1049</td><td></td>
  </tr>`;
  const info = parseNcSearchRow(shifted, '16640');
  assert.ok(info);
  assert.equal(info!.difficulty, 1500); // 难度恒紧随标题单元格
  assert.equal(info!.nativeDifficulty, '1500');
  assert.equal(info!.title, '纪念品分组');
  const rows = parseNcBankRows(shifted);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].difficulty, 1500); // 题库路径对同一行给出同一结论
  assert.equal(rows[0].nativeScore, 1500);
});

test('parseNcSearchRow: 难度单元格为空时取未知，不得顺延到相邻的通过数（不得臆造难度）', () => {
  // 通过数恰为难度网格值（1500）：若向后扫描找数字，就会把通过数当成难度，
  // 并以 backfill(3) 覆盖 bank(1)/sync(2) 已落定的正确难度。
  const html = `<tr data-problemId="50039">
    <td><a href="/acm/problem/50039">NC50039</a></td>
    <td class="fn-right" colspan="2"><a class="title" href="/acm/problem/50039">kotori和气球</a></td>
    <td> </td><td>1500</td><td></td>
  </tr>`;
  const info = parseNcSearchRow(html, '50039');
  assert.ok(info);
  assert.equal(info!.difficulty, null);
  assert.equal(info!.nativeDifficulty, null);
  assert.equal(parseNcBankRows(html)[0].difficulty, null); // 两个读取方一致为「未知」
  assert.equal(parseNcBankRows(html)[0].nativeScore, null);
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
  extra: { native?: string | null; scale?: string | null; source?: string | null } = {},
): void {
  db.prepare(
    'INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, native_difficulty, difficulty_scale, difficulty_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    platform,
    key,
    title,
    difficulty,
    `https://x/${key}`,
    JSON.stringify(tags),
    extra.native ?? null,
    extra.scale ?? null,
    extra.source ?? null,
  );
}

function ncListPage(info: { id: string; title: string; diff: string; tags: string[] }): string {
  const tagLinks = info.tags
    .map((t) => `<a href="javascript:void(0);" class="tag-label js-tag">${t}</a>`)
    .join('');
  // 真实页面形态：标题与算法标签同处一个 `colspan="2"` 单元格，难度是**紧随其后**的那一格。
  // fixture 必须带上 colspan，否则「按列下标硬取」与「标题锚点 + 后一格」两种规则在测试里看不出差别。
  return `<table><tr data-problemId="${info.id}">
    <td><a href="/acm/problem/${info.id}">NC${info.id}</a></td>
    <td class="fn-right" colspan="2"><a href="/acm/problem/${info.id}" class="title">${info.title}</a>${tagLinks}</td>
    <td>${info.diff}</td><td>100</td><td></td>
  </tr></table>`;
}

test('backfill: fills nowcoder difficulty + repairs polluted title/empty tags', async () => {
  insertProblem('nowcoder', '16640', '[NOIP2007]纪念品分组\n     构造', null, []);
  insertProblem('nowcoder', '50039', 'kotori和气球', null, []);
  // 已有难度但标题污染 → 参与修复
  insertProblem('nowcoder', '280771', '小红的好数组\n     暴力', 700, []);
  // 健康题：难度 + 原生值 + 标签齐备 → 不参与
  insertProblem('nowcoder', '321126', '小红的权值', 700, ['dp'], { native: '700', scale: 'nowcoder-score' });
  // CF：全平台回填后同为候选（本用例未 mock CF 接口 → 拉取失败，不得写坏已有数据）
  insertProblem('codeforces', '1662A', 'A', null, []);

  const fetchFn = router({
    'keyword=16640': () => ncListPage({ id: '16640', title: '纪念品分组', diff: '1500', tags: ['构造', '排序', '贪心'] }),
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
  assert.equal(row.difficulty, 1500);
  assert.equal(row.title, '纪念品分组');
  assert.deepEqual(JSON.parse(row.tags), ['构造', '排序', '贪心']);
  // CF 不动
  const cf = db.prepare("SELECT difficulty FROM problems WHERE platform='codeforces' AND problem_key='1662A'").get() as any;
  assert.equal(cf.difficulty, null);
});

test('backfill: keeps existing difficulty on repair, records official-missing', async () => {
  // 已有难度 700（manual 手动标定）、标题污染；上游返回 700（回填不得覆盖 manual 值）
  insertProblem('nowcoder', '280771', '小红的好数组\n     暴力', 700, [], { source: 'manual' });
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
  assert.equal(nc.nativeFilled, 0); // 280771 是 manual：难度三元组整体不动（原生值也不写）
  const row = db.prepare("SELECT difficulty, difficulty_source FROM problems WHERE problem_key='280771'").get() as any;
  assert.equal(row.difficulty, 700); // manual(4) > backfill(3)：难度与来源都不动
  assert.equal(row.difficulty_source, 'manual');
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
  assert.equal(row.difficulty, 800); // 洛谷难度 1（入门）→ CF 800（统一实测表：1 → 800）
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

test('backfill: 洛谷连续失败达阈值即熔断（与牛客同一套风控中止语义）', async () => {
  for (let i = 0; i < 10; i += 1) insertProblem('luogu', `P90${i}`, `T${i}`, null, []);
  let requests = 0;
  const fetchFn = router({
    // 逐题详情全部失败（HTTP 500 = 风控/上游异常）：洛谷是逐题型平台，一次点击可能上千请求，必须熔断
    'luogu.com.cn/problem': () => {
      requests += 1;
      return { status: 500, body: '' };
    },
    '_lfe/tags': () => ({ tags: [] }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const lg = results.find((r) => r.platform === 'luogu')!;
  assert.equal(lg.failed, 10); // 全部计入失败（含熔断后跳过的题）
  assert.equal(requests, 8); // 只发出 8 个请求（= failLimit）：第 9 题起判定风控并中止
  assert.ok(lg.details.some((d) => d.note?.includes('风控')), '中止的题需带风控说明');
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

test('回填：单平台单次运行题数上限（capped 如实回传，未处理的题留作下次目标）', async () => {
  // 上限存在的意义：一次点击的耗时必须有上界（逐题平台＝上限 × delayMs）。
  // 这里用整表平台 + 显式调低上限来验证截断语义（整表平台 delayMs=0，测试无需真实等待）。
  insertProblem('codeforces', '1001A', 'A', null, []);
  insertProblem('codeforces', '1001B', 'B', null, []);
  insertProblem('codeforces', '1001C', 'C', null, []);
  const fetchFn = router({
    'problemset.problems': () => ({
      status: 'OK',
      result: {
        problems: [
          { contestId: 1001, index: 'A', name: 'A', rating: 1000, tags: [] },
          { contestId: 1001, index: 'B', name: 'B', rating: 1200, tags: [] },
          { contestId: 1001, index: 'C', name: 'C', rating: 1400, tags: [] },
        ],
      },
    }),
  });
  const results = await backfillDifficulties(db, fetchFn, { maxTargetsPerPlatform: 2 });
  const cf = results.find((r) => r.platform === 'codeforces')!;
  assert.equal(cf.scanned, 2); // 目标按题号升序，只处理前 2 题
  assert.equal(cf.filled, 2);
  assert.equal(cf.capped, 1); // 剩余题数如实回传（前端据此提示「再点一次继续」）
  const done = db.prepare("SELECT difficulty FROM problems WHERE problem_key='1001A'").get() as any;
  assert.equal(done.difficulty, 1000);
  const left = db.prepare("SELECT difficulty FROM problems WHERE problem_key='1001C'").get() as any;
  assert.equal(left.difficulty, null); // 未处理的题保持原样 → 仍是下次运行的目标

  // 未设上限（默认 PLATFORM_LIMITS）时整表平台一次把剩余目标补完
  const again = await backfillDifficulties(db, fetchFn);
  const cf2 = again.find((r) => r.platform === 'codeforces')!;
  assert.equal(cf2.capped, 0);
  const filled = db.prepare("SELECT difficulty FROM problems WHERE problem_key='1001C'").get() as any;
  assert.equal(filled.difficulty, 1400);
});

test('回填：未登记的平台串不会让整轮回填抛错（限额回落默认值，其他平台照常出结果）', async () => {
  // platforms 表可被未来版本/迁移写入本代码未登记的平台（PLATFORM_LIMITS 查不到）：
  // 旧实现直接读 PLATFORM_LIMITS[platform].failLimit → 抛 TypeError → 整轮 502，
  // 所有平台的回填结果一起丢掉。
  db.prepare("INSERT INTO platforms (id, name) VALUES ('weird-oj', 'Weird OJ')").run();
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags)
     VALUES ('weird-oj', 'X1', '未知平台题', NULL, NULL, '[]')`,
  ).run();
  insertProblem('codeforces', '1001A', 'A', null, []);
  const fetchFn = router({
    'problemset.problems': () => ({
      status: 'OK',
      result: { problems: [{ contestId: 1001, index: 'A', name: 'A', rating: 1000, tags: [] }] },
    }),
  });
  const results = await backfillDifficulties(db, fetchFn);
  const weird = results.find((r) => r.platform === 'weird-oj')!;
  assert.equal(weird.scanned, 1);
  assert.equal(weird.failed, 1); // 无元数据来源 → 记单题失败（不抛错、不中断）
  assert.equal(weird.capped, 0);
  const cf = results.find((r) => r.platform === 'codeforces')!;
  assert.equal(cf.filled, 1); // 其他平台照常补完
  const row = db.prepare("SELECT difficulty FROM problems WHERE problem_key='1001A'").get() as any;
  assert.equal(row.difficulty, 1000);
});

test('backfill: no targets returns empty results without any fetch', async () => {
  let fetched = 0;
  const fetchFn = router({
    'acm/problem/list': () => { fetched += 1; return ''; },
    'luogu.com.cn/problem': () => { fetched += 1; return ''; },
  });
  // 完整题（难度 + 原生值 + 标签齐备）→ 不属于回填目标
  insertProblem('nowcoder', '1', 'ok', 800, ['dp'], { native: '800', scale: 'nowcoder-score' });
  insertProblem('luogu', 'P1000', 'ok', 1200, ['dp'], { native: '4', scale: 'luogu-2026-06' });
  const results = await backfillDifficulties(db, fetchFn);
  assert.equal(results.length, 0);
  assert.equal(fetched, 0);
});

test('回填：题目在回填途中被删除 → 记为跳过而非整轮 502', async () => {
  // before 快照按 problem_key 实时 .get()：详情请求返回后行已不存在（用户并发删除）时，
  // row.title 直接 TypeError，整个 backfillDifficulties reject → 其余平台结果全丢
  insertProblem('luogu', 'P7777', '将被删除', null, [], { source: 'sync' });
  const fetchFn = router({
    'problem/P7777': () => {
      db.prepare("DELETE FROM problems WHERE platform = 'luogu' AND problem_key = 'P7777'").run();
      return { data: { problem: { pid: 'P7777', name: '将被删除', difficulty: 3, tags: [] } } };
    },
  });
  const results = await backfillDifficulties(db, fetchFn); // 不得抛错
  const lg = results.find((r) => r.platform === 'luogu')!;
  assert.equal(lg.filled, 0);
  assert.equal(lg.failed, 0, '删除不是上游失败');
  assert.ok(
    lg.details.some((d) => d.problemKey === 'P7777' && d.action === 'skipped'),
    '应有一条 skipped（题目已被删除）明细',
  );
});

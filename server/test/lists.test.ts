import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { listsRoutes } from '../src/routes/lists.ts';
import { parseProblemListText } from '../src/problems/parseProblemList.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

// ---------- 解析器 ----------

test('parseProblemList: URLs of all supported platforms', () => {
  const raw = [
    'https://www.luogu.com.cn/problem/P1001 A+B Problem',
    'https://codeforces.com/contest/1234/problem/A',
    'https://atcoder.jp/contests/abc300/tasks/abc300_a',
    'https://bs.daimayuan.top/p/7',
    'https://ac.nowcoder.com/acm/problem/51000',
    'https://www.jisuanke.com/problem/T1001',
    'https://www.jisuanke.com/contest/37176/problem/12345',
    'https://qoj.ac/problem/9242',
    'https://qoj.ac/contest/3588/problem/17753',
  ].join('\n');
  const rows = parseProblemListText(raw);
  assert.equal(rows.length, 9);
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['luogu:P1001', 'codeforces:1234A', 'atcoder:abc300_a', 'daimayuan:7', 'nowcoder:51000', 'jisuanke:T1001', 'jisuanke:37176-12345', 'qoj:9242', 'qoj:3588-17753'],
  );
});

test('parseProblemList: VJudge 转发链接映射回原始平台', () => {
  const raw = [
    'https://vjudge.net/problem/Gym-104821A',
    'https://vjudge.net/problem/CF-1234A',
    'https://vjudge.net/problem/洛谷-P1001',
    'https://vjudge.net/problem/AtCoder-abc300_a',
    'https://vjudge.net/problem/QOJ-9242', // QOJ → qoj / 9242
    'https://vjudge.net/problem/SPOJ-TEST', // 不支持的 OJ → 跳过
  ].join('\n');
  const rows = parseProblemListText(raw);
  assert.equal(rows.length, 5); // SPOJ 被跳过
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['codeforces:104821A', 'codeforces:1234A', 'luogu:P1001', 'atcoder:abc300_a', 'qoj:9242'],
  );
  // 验证 URL 被正确还原
  assert.match(rows[0]!.url ?? '', /vjudge\.net\/problem\/Gym-104821A/);
});

test('parseProblemList: VJudge 真实 OJ 字面量（CodeForces）与 URL 编码往返', () => {
  // 线上 VJudge 的 oj 字段是 CodeForces，CF 是它并不使用的简写；
  // 修复前只认 gym/cf → 用户从 VJudge 复制的真实链接识别失败。
  const raw = [
    'https://vjudge.net/problem/CodeForces-1234A',
    'https://vjudge.net/problem/CodeForces-104821A', // Gym 题在 VJudge 里也可能标 CodeForces
    'https://vjudge.net/problem/codeforces-1234B', // 大小写混排
    'https://vjudge.net/problem/SGU-123', // 未接入的 OJ → 跳过
    'https://vjudge.net/problem/CodeChef-ABC123', // 同上
  ].join('\n');
  const rows = parseProblemListText(raw);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['codeforces:1234A', 'codeforces:104821A', 'codeforces:1234B'],
  );
});

test('parseProblemList: 应用自己生成的 VJudge 编码链接能被自己解析（往返一致）', () => {
  // vjudge.ts 的 problemUrl 用 encodeURIComponent 生成链接，洛谷键会编码成
  // %E6%B4%9B%E8%B0%B7-P1001；解析器若先匹配再解码，这条往返就是断的。
  for (const [encoded, platform, key] of [
    ['https://vjudge.net/problem/%E6%B4%9B%E8%B0%B7-P1001', 'luogu', 'P1001'],
    ['https://vjudge.net/problem/%E7%89%9B%E5%AE%A2-51000', 'nowcoder', '51000'],
  ] as const) {
    const rows = parseProblemListText(encoded);
    assert.equal(rows.length, 1, encoded);
    assert.equal(rows[0]!.platform, platform, encoded);
    assert.equal(rows[0]!.problemKey, key, encoded);
  }
});

test('parseProblemList: CF Gym 直接链接', () => {
  const raw = 'https://codeforces.com/gym/104821/problem/A';
  const rows = parseProblemListText(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.platform, 'codeforces');
  assert.equal(rows[0]!.problemKey, '104821A');
});

test('parseProblemList: tokens, serial prefix, dedup and title cleaning', () => {
  const raw = [
    '1. P1001 两遍',
    'CF1234A Yet Another Problem',
    '1234A', // 与上一行重复 → 去重
    'abc300_c',
    'AT_abc300_a', // 洛谷远程题号保持小写
    '7', // 纯数字短行 → 代码源
  ].join('\n');
  const rows = parseProblemListText(raw);
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['luogu:P1001', 'codeforces:1234A', 'atcoder:abc300_c', 'luogu:AT_abc300_a', 'daimayuan:7'],
  );
  assert.equal(rows[0].title, '两遍');
  assert.equal(rows[1].title, 'Yet Another Problem');
});

test('parseProblemList: unrecognized lines skipped, blank lines ok', () => {
  const rows = parseProblemListText(['第一题', '', '随便写点东西 NO_KEY_HERE'].join('\n'));
  assert.equal(rows.length, 0);
});

test('parseProblemList: 纯 URL 行不产生 "https://" 假标题', () => {
  // 之前 rest 残留 scheme 前缀，cleanTitle 把 "https://" 当题名入库，前端整列显示为 https://
  const rows = parseProblemListText(
    [
      'https://codeforces.com/problemset/problem/1100/A',
      'https://www.luogu.com.cn/problem/P1001',
      'https://vjudge.net/problem/CF-1234A',
      '1101B https://', // 复制粘贴把 scheme 拆到行尾的形态
    ].join('\n'),
  );
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['codeforces:1100A', 'luogu:P1001', 'codeforces:1234A', 'codeforces:1101B'],
  );
  assert.deepEqual(rows.map((r) => r.title ?? null), [null, null, null, null]);
  assert.equal(rows[0]!.url, 'https://codeforces.com/problemset/problem/1100/A');
});

test('parseProblemList: URL + 题名 → 题名不带 scheme 残留', () => {
  const rows = parseProblemListText('https://www.luogu.com.cn/problem/P1001 A+B Problem');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, 'A+B Problem');
});

// ---------- 路由 ----------

interface TestServer {
  base: string
  db: Db
  providerChats: string[]
}

async function withServer(
  fn: (s: TestServer) => Promise<void>,
  /** 注入自定义 AI 回复（测顺序块解析的异常路径）；缺省用内置回复（分类 JSON / 带顺序块的建议） */
  providerReply?: (prompt: string) => string,
): Promise<void> {
  const db = createDb(':memory:');
  const providerChats: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/lists',
    listsRoutes(db, () => ({ enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' }), {
      fetchStatementFn: async () => new Response(`<script>window.__INITIAL_STATE__ = ${JSON.stringify({ problem: { description: '题单专用正文：给定序列，求满足条件的区间数量。'.repeat(15), inputFormat: '输入 n 个数', outputFormat: '输出区间数', hint: 'n <= 300000' } })};</script>`),
      createProvider: () => ({
        enabled: true,
        chat: async (messages) => {
          providerChats.push(messages.map((m) => m.content).join('\n'));
          // ai-classify：把所有题归入「二分查找」（TAXONOMY 用的是 taxonomy 规范名）；ai-suggest：返回建议文本
          const prompt = messages[messages.length - 1]!.content as string;
          if (providerReply) return providerReply(prompt);
          if (prompt.includes('分类目录')) {
            const n = (prompt.match(/^\d+\. \[/gm) ?? []).length; // ai-classify 条目行形如 "0. [luogu/P1001]"
            return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, category: '二分查找' })));
          }
          // ai-suggest：建议正文 + 末尾顺序块（题目列表行号 1-based，倒序排列以便断言重排生效）
          const n = (prompt.match(/^\d+\. \[/gm) ?? []).length;
          return `建议优先做前两道题。\n\n\`\`\`json\n${JSON.stringify(Array.from({ length: n }, (_, i) => n - i))}\n\`\`\``;
        },
      }),
    }),
  );
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/lists`;
  try {
    await fn({ base, db, providerChats });
  } finally {
    srv.close();
    db.close();
  }
}

function seedProblems(db: Db): void {
  const sub = (platform: string, key: string, tags: string[], verdict: 'AC' | 'WA' = 'WA'): NormalizedSubmission => ({
    problem: { platform: platform as NormalizedSubmission['problem']['platform'], problemKey: key, title: `T${key}`, tags, url: `https://example.com/${key}` },
    verdict,
    submittedAt: '2026-08-01T00:00:00.000Z',
    externalId: `${key}-${verdict}`,
  });
  insertNormalized(db, DEFAULT_USER_ID, [
    sub('luogu', 'P1001', ['二分']), // 题库 tag → 规则分类「二分」
    sub('codeforces', '1234A', ['greedy']),
    sub('codeforces', '1234A', ['greedy'], 'AC'), // 已 AC
  ]);
}

test('lists: 洛谷 CF/AtCoder 镜像题回退到源平台题库取 tags 分类', async () => {
  await withServer(async ({ base, db }) => {
    // 题库中只有源平台的镜像题：codeforces/351E 与 atcoder/agc018_c
    // （洛谷库中不存在 CF351E / at_agc018_c —— 洛谷题单镜像题的典型形态）
    const sub = (platform: string, key: string, tags: string[]): NormalizedSubmission => ({
      problem: { platform: platform as NormalizedSubmission['problem']['platform'], problemKey: key, title: `T${key}`, tags, url: `https://example.com/${key}` },
      verdict: 'WA',
      submittedAt: '2026-08-01T00:00:00.000Z',
      externalId: `${key}-WA`,
    });
    insertNormalized(db, DEFAULT_USER_ID, [
      sub('codeforces', '351E', ['dp']),
      sub('atcoder', 'agc018_c', ['graphs']),
    ]);

    // 从洛谷题单页复制的文本：镜像题链接指向 luogu.com.cn
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '洛谷题单',
        raw: 'https://www.luogu.com.cn/problem/CF351E\nhttps://www.luogu.com.cn/problem/at_agc018_c',
      }),
    });
    assert.equal(res.status, 200);
    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;
    const detail = (await (await fetch(`${base}/${listId}`)).json()) as {
      items: Array<{ problem_key: string; category: string }>;
    };
    const byKey = new Map(detail.items.map((i) => [i.problem_key, i]));
    // 导入时即通过镜像回退命中源平台 tags：dp → 动态规划、graphs → 图论（综合）
    assert.equal(byKey.get('CF351E')!.category, '动态规划');
    assert.equal(byKey.get('at_agc018_c')!.category, '图论（综合）');

    // 再跑规则分类（幂等）：镜像题不回落到「其他」
    const cls = (await (await fetch(`${base}/${listId}/classify`, { method: 'POST' })).json()) as {
      updated: number;
    };
    assert.equal(cls.updated, 0, '分类已在导入时命中，重跑不应变更');
    const after = db
      .prepare('SELECT problem_key, category FROM problem_list_items')
      .all() as Array<{ problem_key: string; category: string }>;
    const catByKey = new Map(after.map((r) => [r.problem_key, r.category]));
    assert.equal(catByKey.get('CF351E'), '动态规划');
    assert.equal(catByKey.get('at_agc018_c'), '图论（综合）');
  });
});

test('lists: 规则分类不覆盖查不到 tags 的题的已有分类', async () => {
  await withServer(async ({ base, db }) => {
    // 题库只有 P1001（tags 二分）；P9999 不在题库
    const sub = (platform: string, key: string, tags: string[]): NormalizedSubmission => ({
      problem: { platform: platform as NormalizedSubmission['problem']['platform'], problemKey: key, title: `T${key}`, tags, url: `https://example.com/${key}` },
      verdict: 'WA',
      submittedAt: '2026-08-01T00:00:00.000Z',
      externalId: `${key}-WA`,
    });
    insertNormalized(db, DEFAULT_USER_ID, [sub('luogu', 'P1001', ['二分'])]);

    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '混合题单', raw: 'P1001\nP9999' }),
    });
    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;
    // 模拟用户先手动/AI 把 P9999 分到「数据结构」
    const p9999 = db.prepare("SELECT id FROM problem_list_items WHERE problem_key = 'P9999'").get() as { id: number };
    db.prepare('UPDATE problem_list_items SET category = ? WHERE id = ?').run('数据结构', p9999.id);

    // 重跑规则分类：P1001 命中 tags 不变；P9999 查不到 tags → 必须保留「数据结构」而非抹成「其他」
    const cls = (await (await fetch(`${base}/${listId}/classify`, { method: 'POST' })).json()) as {
      ok: boolean;
      updated: number;
      unmatched: number;
    };
    assert.equal(cls.ok, true);
    assert.equal(cls.unmatched, 1, 'P9999 查不到 tags 应计入 unmatched');
    const cats = db
      .prepare('SELECT problem_key, category FROM problem_list_items')
      .all() as Array<{ problem_key: string; category: string }>;
    const catByKey = new Map(cats.map((r) => [r.problem_key, r.category]));
    assert.equal(catByKey.get('P1001'), '二分查找'); // 写入即净化：题源「二分」→ 规范名「二分查找」
    assert.equal(catByKey.get('P9999'), '数据结构', '查不到 tags 的题不应被抹成其他');
  });
});

test('lists: import parses text, rule-classifies from bank tags, detail shows solved', async () => {
  await withServer(async ({ base, db }) => {
    seedProblems(db);
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '二分专题',
        raw: 'P1001 A+B\nCF1234A\nhttps://bs.daimayuan.top/p/7',
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { imported: number; unrecognized: number };
    assert.equal(body.imported, 3);
    assert.equal(body.unrecognized, 0);

    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;
    const detail = (await (await fetch(`${base}/${listId}`)).json()) as {
      items: Array<{ platform: string; problem_key: string; category: string; solved: boolean; url: string }>;
    };
    assert.equal(detail.items.length, 3);
    // P1001 命中题库「二分」tag → 规则分类（规范名「二分查找」）；CF greedy → canonical 贪心；代码源无题库 → 未分类
    const byKey = new Map(detail.items.map((i) => [i.problem_key, i]));
    assert.equal(byKey.get('P1001')!.category, '二分查找');
    assert.equal(byKey.get('1234A')!.category, '贪心');
    assert.equal(byKey.get('7')!.category, '未分类');
    assert.equal(byKey.get('1234A')!.solved, true); // 题库 AC 联查
    assert.equal(byKey.get('7')!.url, 'https://bs.daimayuan.top/p/7'); // 解析出的链接保留
  });
});

test('lists: reject import with no parseable lines; manual category change and delete', async () => {
  await withServer(async ({ base, db }) => {
    const bad = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', raw: '没有题目' }),
    });
    assert.equal(bad.status, 400);

    seedProblems(db);
    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', raw: 'P1001' }),
    });
    const itemId = (db.prepare('SELECT id FROM problem_list_items').get() as { id: number }).id;

    const patchRes = await fetch(`${base}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: '动态规划' }),
    });
    assert.equal(patchRes.status, 200);
    const cat = (db.prepare('SELECT category FROM problem_list_items').get() as { category: string }).category;
    assert.equal(cat, '动态规划');

    const delRes = await fetch(`${base}/items/${itemId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM problem_list_items').get() as { c: number }).c, 0);
  });
});

test('lists: ai-classify updates categories via mock provider; ai-suggest returns reply', async () => {
  await withServer(async ({ base, db, providerChats }) => {
    seedProblems(db);
    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '混合题单', raw: 'P1001\nCF1234A' }),
    });
    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;

    const cls = await (await fetch(`${base}/${listId}/ai-classify`, { method: 'POST' })).json();
    // P1001 导入时已按题库 tag 归入「二分查找」，只有 CF 一道需要 AI 改分类
    assert.equal((cls as { updated: number }).updated, 1);
    const cats = (db.prepare('SELECT DISTINCT category FROM problem_list_items').all() as Array<{ category: string }>)
      .map((c) => ({ category: c.category })); // node:sqlite 行为 null 原型，映射后比较
    assert.deepEqual(cats, [{ category: '二分查找' }]);
    assert.equal(providerChats.length, 1);
    assert.match(providerChats[0]!, /分类目录/);
    assert.match(providerChats[0]!, /题单专用正文/);

    const sug = await (await fetch(`${base}/${listId}/ai-suggest`, { method: 'POST' })).json();
    assert.match((sug as { reply: string }).reply, /优先做前两道题/);
    // 建议上下文应包含题单内容与用户数据
    assert.match(providerChats[1]!, /混合题单/);
    assert.match(providerChats[1]!, /练习数据汇总/);
    assert.match(providerChats[1]!, /n <= 300000/);
  });
});

test('lists: ai-suggest 附带练习顺序（json 块剥离、id 换算、缓存解析、reorder 落库）', async () => {
  await withServer(async ({ base, db }) => {
    seedProblems(db);
    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '排序题单', raw: 'P1001\nCF1234A' }),
    });
    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;
    const ids = (
      db.prepare('SELECT id FROM problem_list_items ORDER BY position').all() as Array<{ id: number }>
    ).map((r) => r.id);

    const sug = (await (await fetch(`${base}/${listId}/ai-suggest`, { method: 'POST' })).json()) as {
      reply: string;
      order: number[] | null;
      cached: boolean;
    };
    // 建议正文剥掉了顺序块（界面渲染不该看到裸 json）
    assert.match(sug.reply, /建议优先做前两道题/);
    assert.ok(!sug.reply.includes('```'), `正文不应残留代码围栏：${sug.reply}`);
    // mock 按倒序给全部题目 → order 应换算成条目 id 的倒序
    assert.deepEqual(sug.order, [...ids].reverse());

    // 前端「按建议重排」走既有 reorder 端点落库
    const ro = await fetch(`${base}/${listId}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds: sug.order }),
    });
    assert.equal(ro.status, 200);
    const keys = (
      db.prepare('SELECT problem_key FROM problem_list_items ORDER BY position').all() as Array<{ problem_key: string }>
    ).map((r) => r.problem_key);
    assert.deepEqual(keys, ['1234A', 'P1001'], '练习顺序应被整体反转（CF1234A 导入时已规范化为 1234A）');

    // 再次调用走缓存：order 从缓存列解析回来
    const sug2 = (await (await fetch(`${base}/${listId}/ai-suggest`, { method: 'POST' })).json()) as {
      reply: string;
      order: number[] | null;
      cached: boolean;
    };
    assert.equal(sug2.cached, true);
    assert.deepEqual(sug2.order, [...ids].reverse());

    // 详情接口带出 aiSuggestionOrder（界面据此后台恢复「按建议重排」按钮）
    const detail = (await (await fetch(`${base}/${listId}`)).json()) as { aiSuggestionOrder: number[] | null };
    assert.deepEqual(detail.aiSuggestionOrder, [...ids].reverse());
  });
});

test('lists: ai-suggest 顺序块的异常输入被安全处理（越界/重复/非数组/无块）', async () => {
  let call = 0;
  await withServer(
    async ({ base, db }) => {
      seedProblems(db);
      await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '异常顺序', raw: 'P1001\nCF1234A' }),
      });
      const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;
      const firstId = (
        db.prepare('SELECT id FROM problem_list_items ORDER BY position').get() as { id: number }
      ).id;

      // 越界(99)、非整数("x")、重复(1,1)：只保留合法的 1 → [firstId]；正文同样剥掉围栏
      const res1 = (await (
        await fetch(`${base}/${listId}/ai-suggest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
        })
      ).json()) as { reply: string; order: number[] | null };
      assert.deepEqual(res1.order, [firstId]);
      assert.ok(!res1.reply.includes('```'));

      // 无代码块：order 为 null，建议文字原样返回（老版本行为）
      const res2 = (await (
        await fetch(`${base}/${listId}/ai-suggest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
        })
      ).json()) as { reply: string; order: number[] | null };
      assert.match(res2.reply, /只给建议不给顺序/);
      assert.equal(res2.order, null);
    },
    () => {
      call += 1;
      return call === 1 ? '建议正文。\n\n```json\n[99, "x", 1, 1]\n```' : '只给建议不给顺序。';
    },
  );
});

test('lists: append items to existing list, dedupe by identity, 404/400 paths', async () => {
  await withServer(async ({ base, db }) => {
    seedProblems(db);
    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '追加题单', raw: 'P1001' }),
    });
    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;

    // 追加两道新题：CF1234A 命中题库 tags → 贪心；代码源 7 无题库 → 未分类
    const res = await fetch(`${base}/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: 'CF1234A\nhttps://bs.daimayuan.top/p/7' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; added: number; duplicates: number; unrecognized: number };
    assert.deepEqual(body, { ok: true, added: 2, duplicates: 0, unrecognized: 0 });
    const keys = db
      .prepare('SELECT platform, problem_key FROM problem_list_items ORDER BY position')
      .all()
      .map((r) => `${(r as { platform: string }).platform}:${(r as { problem_key: string }).problem_key}`);
    assert.deepEqual(keys, ['luogu:P1001', 'codeforces:1234A', 'daimayuan:7']);
    const cats = db
      .prepare('SELECT problem_key, category FROM problem_list_items ORDER BY position')
      .all() as Array<{ problem_key: string; category: string }>;
    assert.equal(cats[1]!.category, '贪心');
    assert.equal(cats[2]!.category, '未分类');

    // 再追加：已有题（P1001）跳过，新题（CF351E、P1002）入库
    insertNormalized(db, DEFAULT_USER_ID, [
      {
        problem: { platform: 'codeforces', problemKey: '351E', title: 'T351E', tags: ['dp'], url: 'https://example.com/351E' },
        verdict: 'WA',
        submittedAt: '2026-08-01T00:00:00.000Z',
        externalId: '351E-WA',
      } as unknown as NormalizedSubmission,
    ]);
    const res2 = await fetch(`${base}/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: 'P1001\nCF351E\nP1002' }),
    });
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as { added: number; duplicates: number };
    assert.equal(body2.added, 2);
    assert.equal(body2.duplicates, 1);

    // 洛谷镜像链接（CF351E ≙ 已在题单里的 codeforces/351E）按镜像身份去重，不再入库
    const res3 = await fetch(`${base}/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: 'https://www.luogu.com.cn/problem/CF351E' }),
    });
    assert.equal(res3.status, 200);
    const body3 = (await res3.json()) as { added: number; duplicates: number };
    assert.equal(body3.added, 0);
    assert.equal(body3.duplicates, 1);
    const keysAfter = db
      .prepare('SELECT platform, problem_key FROM problem_list_items ORDER BY position')
      .all()
      .map((r) => `${(r as { platform: string }).platform}:${(r as { problem_key: string }).problem_key}`);
    assert.equal(keysAfter.length, 5);
    assert.equal(keysAfter[3], 'codeforces:351E');
    assert.equal(keysAfter[4], 'luogu:P1002');

    // 失败路径：题单不存在 404；无可解析行 400
    const bad404 = await fetch(`${base}/999999/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: 'P1001' }),
    });
    assert.equal(bad404.status, 404);
    const bad400 = await fetch(`${base}/${listId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: '没有题目' }),
    });
    assert.equal(bad400.status, 400);
  });
});

test('lists: reorder persists dragged position order, detail reflects it', async () => {
  await withServer(async ({ base, db }) => {
    seedProblems(db);
    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '排序题单', raw: 'P1001\nCF1234A\nP9999' }),
    });
    const listId = (db.prepare('SELECT id FROM problem_lists').get() as { id: number }).id;
    const items = db
      .prepare('SELECT id, problem_key FROM problem_list_items ORDER BY position')
      .all() as Array<{ id: number; problem_key: string }>;
    assert.deepEqual(items.map((i) => i.problem_key), ['P1001', '1234A', 'P9999']);

    // 把第 1 题（P1001）拖到最后 → 新顺序 [1234A, P9999, P1001]
    const orderedIds = [items[1]!.id, items[2]!.id, items[0]!.id];
    const res = await fetch(`${base}/${listId}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    assert.equal(res.status, 200);
    const after = db
      .prepare('SELECT problem_key FROM problem_list_items ORDER BY position')
      .all() as Array<{ problem_key: string }>;
    assert.deepEqual(after.map((i) => i.problem_key), ['1234A', 'P9999', 'P1001']);
    // 详情接口按新 position 返回
    const detail = (await (await fetch(`${base}/${listId}`)).json()) as {
      items: Array<{ problem_key: string }>;
    };
    assert.deepEqual(detail.items.map((i) => i.problem_key), ['1234A', 'P9999', 'P1001']);

    // 校验失败路径：缺条目 / 多余 id / 题单不存在
    const bad1 = await fetch(`${base}/${listId}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds: [items[0]!.id] }),
    });
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(`${base}/${listId}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds: [...orderedIds, 99999] }),
    });
    assert.equal(bad2.status, 400);
    const bad3 = await fetch(`${base}/999999/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    assert.equal(bad3.status, 404);
  });
});

/** 列表卡片的「已解决 N/M」：N 按题计。同一题多次 AC（不同 external_id 可并存）
 *  若按提交行数计，会出现 solved_count 超过 item_count 的荒唐分子。 */
test('lists: 已解决数按题目去重统计，多次 AC 同一题只算一道', async () => {
  await withServer(async ({ base, db }) => {
    seedProblems(db);
    insertNormalized(db, DEFAULT_USER_ID, [
      {
        problem: { platform: 'codeforces', problemKey: '1234A', title: 'T1234A', tags: ['greedy'] },
        verdict: 'AC',
        submittedAt: '2026-08-02T00:00:00.000Z',
        externalId: '1234A-AC-2',
      },
    ]);
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '专题', raw: 'CF1234A\nP1001' }),
    });
    assert.equal(res.status, 200);
    const lists = (await (await fetch(`${base}/`)).json()) as Array<{
      id: number;
      item_count: number;
      solved_count: number;
    }>;
    assert.equal(lists.length, 1);
    assert.equal(lists[0]!.item_count, 2);
    assert.equal(lists[0]!.solved_count, 1, 'P1001 未 AC；1234A 两次 AC 也只算一道');
  });
});

// ---------- 题单排序（position）/ 改名 / 清空题目 ----------

/** 导入一个题单并返回它的 id（题单整理相关用例的公共前置） */
async function importList(base: string, title: string, raw: string): Promise<number> {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, raw }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { id: number }).id;
}

/** GET /api/lists → [{ id, title, position, item_count }] */
async function listCards(
  base: string,
): Promise<Array<{ id: number; title: string; position: number; item_count: number }>> {
  return (await (await fetch(`${base}/`)).json()) as Array<{
    id: number;
    title: string;
    position: number;
    item_count: number;
  }>;
}

test('lists: 列表按 position 排序，连续导入的两个题单中新的排在最前', async () => {
  await withServer(async ({ base }) => {
    const first = await importList(base, '第一个', 'P1001');
    const second = await importList(base, '第二个', 'P1002');
    const third = await importList(base, '第三个', 'P1003');

    const cards = await listCards(base);
    // 新导入的 position 取「当前最小值 - 1」→ 排在最前，与旧版「刚导入的在最上面」观感一致
    assert.deepEqual(
      cards.map((c) => c.title),
      ['第三个', '第二个', '第一个'],
    );
    assert.deepEqual(
      cards.map((c) => c.id),
      [third, second, first],
    );
    // position 单调递增（严格递增即可：绝对值不重要，只表示先后）
    assert.ok(cards[0]!.position < cards[1]!.position, `position 应递增：${JSON.stringify(cards)}`);
    assert.ok(cards[1]!.position < cards[2]!.position, `position 应递增：${JSON.stringify(cards)}`);
    // 每行都带出 position 字段（前端据此判断是否需要落库）
    assert.ok(cards.every((c) => typeof c.position === 'number'));
  });
});

test('lists: POST /reorder 落库生效，GET 反映新顺序；非法 orderedIds 一律 400', async () => {
  await withServer(async ({ base, db }) => {
    const a = await importList(base, 'A', 'P1001');
    const b = await importList(base, 'B', 'P1002');
    const c = await importList(base, 'C', 'P1003');
    assert.deepEqual((await listCards(base)).map((x) => x.title), ['C', 'B', 'A']);

    // 把顺序改成 A, C, B
    const res = await fetch(`${base}/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderedIds: [a, c, b] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual((await listCards(base)).map((x) => x.title), ['A', 'C', 'B']);
    // position 被重写为 0..n-1（不是简单的「交换」：顺序由绝对下标定义）
    const posById = new Map(
      (
        db.prepare('SELECT id, position FROM problem_lists').all() as Array<{
          id: number;
          position: number;
        }>
      ).map((r) => [r.id, r.position]),
    );
    assert.equal(posById.get(a), 0);
    assert.equal(posById.get(c), 1);
    assert.equal(posById.get(b), 2);

    const post = async (body: unknown): Promise<number> =>
      (
        await fetch(`${base}/reorder`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status;

    assert.equal(await post({ orderedIds: [a, c] }), 400, '缺一个题单 → 400');
    assert.equal(await post({ orderedIds: [a, c, b, 999999] }), 400, '多一个不存在的 id → 400');
    assert.equal(await post({ orderedIds: [a, c, c] }), 400, '重复 id（去重后不足全集）→ 400');
    assert.equal(await post({ orderedIds: [a, c, 1.5] }), 400, '非整数元素 → 400');
    assert.equal(await post({ orderedIds: [] }), 400, '空数组 → 400');
    assert.equal(await post({}), 400, '缺 orderedIds → 400');
    // 校验失败不得改动落库顺序
    assert.deepEqual((await listCards(base)).map((x) => x.title), ['A', 'C', 'B']);
  });
});

test('lists: PATCH /:id 改名（trim 落库、详情同步），空标题 400，不存在 404', async () => {
  await withServer(async ({ base, db }) => {
    const id = await importList(base, '原名', 'P1001');

    const res = await fetch(`${base}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  新名字  ' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id, title: '新名字' });
    // 列表与详情都读到新标题（详情页抽屉标题同步）
    assert.equal((await listCards(base))[0]!.title, '新名字');
    const detail = (await (await fetch(`${base}/${id}`)).json()) as { title: string };
    assert.equal(detail.title, '新名字');

    const patch = async (listId: number, body: unknown): Promise<number> =>
      (
        await fetch(`${base}/${listId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status;

    assert.equal(await patch(id, { title: '   ' }), 400, '纯空白 → 400');
    assert.equal(await patch(id, { title: '' }), 400, '空串 → 400');
    assert.equal(await patch(id, { title: 'x'.repeat(61) }), 400, '超过 60 字 → 400');
    assert.equal(await patch(id, {}), 400, '缺 title → 400');
    assert.equal(await patch(id, { title: 123 }), 400, 'title 非字符串 → 400');
    assert.equal(await patch(999999, { title: '新名字' }), 404, '题单不存在 → 404');
    // 失败路径不改标题
    assert.equal((db.prepare('SELECT title FROM problem_lists WHERE id = ?').get(id) as { title: string }).title, '新名字');
  });
});

test('lists: DELETE /:id/items 清空题目并作废 AI 建议缓存，题单本身保留', async () => {
  await withServer(async ({ base, db }) => {
    seedProblems(db);
    const id = await importList(base, '待清空', 'P1001\nCF1234A\nP9999');
    const itemCount = (
      db.prepare('SELECT COUNT(*) AS c FROM problem_list_items WHERE list_id = ?').get(id) as { c: number }
    ).c;
    assert.equal(itemCount, 3);

    // 先造一条 AI 建议缓存（正文 + 顺序 + 时间），验证清空时一并作废
    db.prepare(
      `UPDATE problem_lists
          SET ai_suggestion = '旧建议正文', ai_suggestion_at = datetime('now'), ai_suggestion_order = '[1,2,3]'
        WHERE id = ?`,
    ).run(id);

    const res = await fetch(`${base}/${id}/items`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, removed: 3 });
    // 题目归零
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM problem_list_items WHERE list_id = ?').get(id) as { c: number }).c,
      0,
    );
    // 题单本身仍在（卡片还在，可重新导入/添加）
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM problem_lists WHERE id = ?').get(id) as { c: number }).c,
      1,
    );
    // AI 建议缓存必须作废：它是对被清空的那批题目生成的，留着会展示旧建议、点重排还会带死 id
    const row = db
      .prepare('SELECT ai_suggestion, ai_suggestion_at, ai_suggestion_order FROM problem_lists WHERE id = ?')
      .get(id) as {
      ai_suggestion: string | null;
      ai_suggestion_at: string | null;
      ai_suggestion_order: string | null;
    };
    assert.equal(row.ai_suggestion, null);
    assert.equal(row.ai_suggestion_at, null);
    assert.equal(row.ai_suggestion_order, null);
    // 详情接口返回空 items，卡片题数刷新为 0
    const detail = (await (await fetch(`${base}/${id}`)).json()) as {
      items: unknown[];
      aiSuggestion: string | null;
      aiSuggestionOrder: number[] | null;
    };
    assert.deepEqual(detail.items, []);
    assert.equal(detail.aiSuggestion, null);
    assert.equal(detail.aiSuggestionOrder, null);
    assert.equal((await listCards(base))[0]!.item_count, 0);

    // 再清空一次：0 条（幂等），题单仍在
    const again = await fetch(`${base}/${id}/items`, { method: 'DELETE' });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, removed: 0 });

    // 题单不存在 → 404
    const missing = await fetch(`${base}/999999/items`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: '题单不存在' });
  });
});

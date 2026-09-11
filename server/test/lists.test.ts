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
  ].join('\n');
  const rows = parseProblemListText(raw);
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['luogu:P1001', 'codeforces:1234A', 'atcoder:abc300_a', 'daimayuan:7', 'nowcoder:51000'],
  );
});

test('parseProblemList: VJudge 转发链接映射回原始平台', () => {
  const raw = [
    'https://vjudge.net/problem/Gym-104821A',
    'https://vjudge.net/problem/CF-1234A',
    'https://vjudge.net/problem/洛谷-P1001',
    'https://vjudge.net/problem/AtCoder-abc300_a',
    'https://vjudge.net/problem/QOJ-9242', // 不支持的 OJ → 跳过
    'https://vjudge.net/problem/SPOJ-TEST', // 不支持的 OJ → 跳过
  ].join('\n');
  const rows = parseProblemListText(raw);
  assert.equal(rows.length, 4); // QOJ 和 SPOJ 被跳过
  assert.deepEqual(
    rows.map((r) => `${r.platform}:${r.problemKey}`),
    ['codeforces:104821A', 'codeforces:1234A', 'luogu:P1001', 'atcoder:abc300_a'],
  );
  // 验证 URL 被正确还原
  assert.match(rows[0]!.url ?? '', /vjudge\.net\/problem\/Gym-104821A/);
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

// ---------- 路由 ----------

interface TestServer {
  base: string
  db: Db
  providerChats: string[]
}

async function withServer(fn: (s: TestServer) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const providerChats: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/lists',
    listsRoutes(db, () => ({ enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' }), {
      createProvider: () => ({
        enabled: true,
        chat: async (messages) => {
          providerChats.push(messages.map((m) => m.content).join('\n'));
          // ai-classify：把所有题归入「二分」；ai-suggest：返回建议文本
          const prompt = messages[messages.length - 1]!.content as string;
          if (prompt.includes('分类目录')) {
            const n = (prompt.match(/^\d+\. \[/gm) ?? []).length; // ai-classify 条目行形如 "0. [luogu/P1001]"
            return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, category: '二分' })));
          }
          return '建议优先做前两道题。';
        },
      }),
    }),
  );
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
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
    // 导入时即通过镜像回退命中源平台 tags：dp → 动态规划、graphs → 图论
    assert.equal(byKey.get('CF351E')!.category, '动态规划');
    assert.equal(byKey.get('at_agc018_c')!.category, '图论');

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
    assert.equal(catByKey.get('at_agc018_c'), '图论');
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
    assert.equal(catByKey.get('P1001'), '二分');
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
    // P1001 命中题库「二分」tag → 规则分类；CF greedy → canonical 贪心；代码源无题库 → 未分类
    const byKey = new Map(detail.items.map((i) => [i.problem_key, i]));
    assert.equal(byKey.get('P1001')!.category, '二分');
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
    // P1001 导入时已按题库 tag 归入「二分」，只有 CF 一道需要 AI 改分类
    assert.equal((cls as { updated: number }).updated, 1);
    const cats = (db.prepare('SELECT DISTINCT category FROM problem_list_items').all() as Array<{ category: string }>)
      .map((c) => ({ category: c.category })); // node:sqlite 行为 null 原型，映射后比较
    assert.deepEqual(cats, [{ category: '二分' }]);
    assert.equal(providerChats.length, 1);
    assert.match(providerChats[0]!, /分类目录/);

    const sug = await (await fetch(`${base}/${listId}/ai-suggest`, { method: 'POST' })).json();
    assert.match((sug as { reply: string }).reply, /优先做前两道题/);
    // 建议上下文应包含题单内容与用户数据
    assert.match(providerChats[1]!, /混合题单/);
    assert.match(providerChats[1]!, /练习数据汇总/);
  });
});

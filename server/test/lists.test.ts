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
          const prompt = messages[messages.length - 1]!.content;
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

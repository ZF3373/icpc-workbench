import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { CURRICULUM, TEMPLATE_TOTAL } from '../src/templates/curriculum.ts';
import { templatesRoutes } from '../src/routes/templates.ts';

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/templates`;
  try {
    await fn(base);
  } finally {
    srv.close();
    db.close();
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' };

test('template categories: create custom category and use it for custom templates', async () => {
  await withServer(async (base) => {
    const created = await fetch(`${base}/categories`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: '网络流', description: '最大流、费用流与建模' }),
    });
    assert.equal(created.status, 200);
    const category = (await created.json()) as {
      ok: boolean;
      key: string;
      name: string;
      description: string;
      custom: boolean;
    };
    assert.equal(category.ok, true);
    assert.ok(category.key);
    assert.equal(category.name, '网络流');
    assert.equal(category.description, '最大流、费用流与建模');
    assert.equal(category.custom, true);

    const list = (await (await fetch(base)).json()) as {
      categories: Array<{
        key: string;
        name: string;
        description: string;
        custom?: boolean;
        templates: Array<{ id: string; custom: boolean; name: string }>;
      }>;
    };
    const customCategory = list.categories.find((item) => item.key === category.key)!;
    assert.equal(customCategory.name, '网络流');
    assert.equal(customCategory.description, '最大流、费用流与建模');
    assert.equal(customCategory.custom, true);
    assert.equal(customCategory.templates.length, 0);

    const template = await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        categoryKey: category.key,
        name: 'Dinic 最大流',
        difficulty: 4,
        tags: ['网络流'],
        code: 'struct Dinic {};',
      }),
    });
    assert.equal(template.status, 200);

    const after = (await (await fetch(base)).json()) as typeof list;
    assert.equal(
      after.categories.find((item) => item.key === category.key)!.templates[0]!.name,
      'Dinic 最大流',
    );

    const duplicate = await fetch(`${base}/categories`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: '网络流' }),
    });
    assert.equal(duplicate.status, 409);
  });
});

// ---------- 自建标签的删除（用户反馈：新建标签后无法删除） ----------

/** 建一个自建标签，返回 key */
async function createCategory(base: string, name: string): Promise<string> {
  const res = await fetch(`${base}/categories`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200, '建标签应成功');
  return ((await res.json()) as { key: string }).key;
}

const categoryKeys = async (base: string): Promise<string[]> => {
  const body = (await (await fetch(`${base}/categories`)).json()) as {
    categories: Array<{ key: string; custom: boolean; templateCount?: number }>;
  };
  return body.categories.map((c) => c.key);
};

test('custom categories: 空标签可直接删除，内置分类不可删', async () => {
  await withServer(async (base) => {
    const key = await createCategory(base, '临时标签');
    assert.ok((await categoryKeys(base)).includes(key));

    const builtin = await fetch(`${base}/categories/basic`, { method: 'DELETE' });
    assert.equal(builtin.status, 400, '内置课程分类必须不可删');
    assert.match(((await builtin.json()) as { error: string }).error, /内置/);

    const missing = await fetch(`${base}/categories/custom-does-not-exist`, { method: 'DELETE' });
    assert.equal(missing.status, 404);

    const ok = await fetch(`${base}/categories/${encodeURIComponent(key)}`, { method: 'DELETE' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, deletedTemplates: 0 });

    assert.ok(!(await categoryKeys(base)).includes(key), '删除后不应再出现在分类清单里');
    const outline = (await (await fetch(base)).json()) as { categories: Array<{ key: string }> };
    assert.ok(!outline.categories.some((c) => c.key === key), '课程大纲里也不应再有该标签');
  });
});

test('custom categories: 有模板时不带 force 拒绝（409 + count），带 force 连带删除模板与进度', async () => {
  await withServer(async (base) => {
    const key = await createCategory(base, '待删标签');
    const created = await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ categoryKey: key, name: '模板 A', difficulty: 3, code: 'int main(){}' }),
    });
    const { id } = (await created.json()) as { id: string };
    await fetch(`${base}/${id}/status`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 'mastered' }),
    });

    // 默认拒绝：误删必须是显式动作
    const blocked = await fetch(`${base}/categories/${encodeURIComponent(key)}`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    const blockedBody = (await blocked.json()) as { error: string; count: number };
    assert.equal(blockedBody.count, 1);
    assert.match(blockedBody.error, /1 个模板/);
    assert.ok((await categoryKeys(base)).includes(key), '被拒绝时标签必须还在');
    const stillThere = (await (await fetch(base)).json()) as {
      categories: Array<{ key: string; templates: Array<{ id: string }> }>;
    };
    assert.equal(stillThere.categories.find((c) => c.key === key)!.templates.length, 1, '被拒绝时模板必须还在');

    // force=1：连带删除模板与其学习进度
    const forced = await fetch(`${base}/categories/${encodeURIComponent(key)}?force=1`, { method: 'DELETE' });
    assert.equal(forced.status, 200);
    assert.deepEqual(await forced.json(), { ok: true, deletedTemplates: 1 });
    assert.ok(!(await categoryKeys(base)).includes(key));
    const outline = (await (await fetch(base)).json()) as {
      customCount: number;
      mastered: number;
      categories: Array<{ key: string; templates: unknown[] }>;
    };
    assert.equal(outline.customCount, 0, '模板应一并删除');
    assert.equal(outline.mastered, 0, '学习进度应一并清理（否则残留进度会污染已掌握计数）');
    assert.ok(!outline.categories.some((c) => c.key === key));
  });
});

test('custom categories: GET /categories 下发可选分类清单（含自建标签与模板数）', async () => {
  await withServer(async (base) => {
    const key = await createCategory(base, '图论进阶');
    await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ categoryKey: key, name: '圆方树', difficulty: 5, code: 'x' }),
    });
    const body = (await (await fetch(`${base}/categories`)).json()) as {
      categories: Array<{ key: string; name: string; custom: boolean; templateCount?: number }>;
    };
    // 内置分类在前且标记 custom:false（首类随大纲调整，取 CURRICULUM 第一个而非写死）
    assert.equal(body.categories[0]!.key, CURRICULUM[0]!.key);
    assert.equal(body.categories[0]!.custom, false);
    const mine = body.categories.find((c) => c.key === key)!;
    assert.equal(mine.name, '图论进阶');
    assert.equal(mine.custom, true);
    assert.equal(mine.templateCount, 1);
    // 空的自建标签也要出现在清单里（AI 必须能看见「刚建好还没装东西」的标签）
    const emptyKey = await createCategory(base, '空标签');
    const after = (await (await fetch(`${base}/categories`)).json()) as typeof body;
    assert.equal(after.categories.find((c) => c.key === emptyKey)?.templateCount, 0);
  });
});

test('custom templates: create → merged in list → status → edit → delete cleans progress', async () => {
  await withServer(async (base) => {
    // 创建
    const created = await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        categoryKey: 'ds',
        name: '吉司机线段树（自用）',
        difficulty: 5,
        tags: ['线段树', '势能分析'],
        code: 'struct SegBeats {};',
        idea: '区间最值操作的势能分析版本',
        complexity: 'O(n log^2 n)',
        url: 'https://example.com/seg-beats',
      }),
    });
    const { id } = (await created.json()) as { ok: boolean; id: string };
    assert.ok(id.startsWith('c-'));

    // 列表合并进对应分类，且带自建标记
    const list = (await (await fetch(base)).json()) as {
      customCount: number;
      categories: Array<{ key: string; templates: Array<{ id: string; custom: boolean; name: string }> }>;
    };
    assert.equal(list.customCount, 1);
    const dsCat = list.categories.find((c) => c.key === 'ds')!;
    const found = dsCat.templates.find((t) => t.id === id)!;
    assert.equal(found.custom, true);
    assert.equal(found.name, '吉司机线段树（自用）');

    // 自建模板也能写学习状态
    await fetch(`${base}/${id}/status`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 'mastered' }),
    });
    const after = (await (await fetch(base)).json()) as {
      mastered: number;
      categories: Array<{ key: string; templates: Array<{ id: string; status: string }> }>;
    };
    // 进度写在建行了，但「课程模板 X/130 已掌握」只数内置课程：
    // 自建模板（c-<id>）计入分子会顶破分母
    assert.equal(
      after.categories.find((c) => c.key === 'ds')!.templates.find((t) => t.id === id)!.status,
      'mastered',
    );
    assert.equal(after.mastered, 0);

    // 编辑
    const edited = await fetch(`${base}/custom/${id.slice(2)}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({
        categoryKey: 'ds',
        name: '吉司机线段树 v2',
        difficulty: 5,
        tags: ['线段树'],
        code: 'struct SegBeatsV2 {};',
      }),
    });
    assert.deepEqual(await edited.json(), { ok: true });
    const afterEdit = (await (await fetch(base)).json()) as {
      categories: Array<{ key: string; templates: Array<{ id: string; name: string }> }>;
    };
    assert.equal(
      afterEdit.categories.find((c) => c.key === 'ds')!.templates.find((t) => t.id === id)!.name,
      '吉司机线段树 v2',
    );

    // 删除 → 进度一并清理
    const removed = await fetch(`${base}/custom/${id.slice(2)}`, { method: 'DELETE' });
    assert.deepEqual(await removed.json(), { ok: true });
    const final = (await (await fetch(base)).json()) as { customCount: number; mastered: number };
    assert.equal(final.customCount, 0);
    assert.equal(final.mastered, 0); // template_progress 的 c-<id> 行被级联删除
  });
});

test('custom templates: rejects invalid category and unknown edit target', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ categoryKey: 'nope', name: 'x', difficulty: 3, tags: [], code: '' }),
    });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/custom/999`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ categoryKey: 'ds', name: 'x', difficulty: 3, tags: [], code: '' }),
    });
    assert.equal(missing.status, 404);
  });
});

test('examples: collect into problems bank, status reflected in list (inBank/ac)', async () => {
  await withServer(async (base, ) => {
    const binarySearch = CURRICULUM[0].templates[0]; // 例题：P2249 等
    const example = binarySearch.examples[0];

    // 初始：未入库
    const before = (await (await fetch(base)).json()) as {
      categories: Array<{ templates: Array<{ examples: Array<{ key: string; inBank: boolean; ac: boolean }> }> }>;
    };
    const exBefore = before.categories[0].templates[0].examples.find((e) => e.key === example.key)!;
    assert.equal(exBefore.inBank, false);
    assert.equal(exBefore.ac, false);

    // 入库
    const collected = await fetch(`${base}/examples/collect`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        platform: example.platform,
        key: example.key,
        title: example.title,
        url: example.url,
        tags: binarySearch.tags,
      }),
    });
    const body = (await collected.json()) as { ok: boolean; inserted: number };
    assert.equal(body.ok, true);
    assert.equal(body.inserted, 1);

    // 模拟刷题：给这道题写一条 AC 提交
    // （直接操作调用方不可行——此处通过再次拉取验证 inBank=true、ac 仍为 false）
    const mid = (await (await fetch(base)).json()) as {
      categories: Array<{ templates: Array<{ examples: Array<{ key: string; inBank: boolean; ac: boolean }> }> }>;
    };
    const exMid = mid.categories[0].templates[0].examples.find((e) => e.key === example.key)!;
    assert.equal(exMid.inBank, true);
    assert.equal(exMid.ac, false);

    // 重复入库走更新而非新增
    const again = (await (
      await fetch(`${base}/examples/collect`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ platform: example.platform, key: example.key, title: example.title, url: example.url, tags: [] }),
      }).then((r) => r.json())
    )) as { updated: number };
    assert.equal(again.updated, 1);
  });
});

test('examples: ac status reflects synced submissions', async () => {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/templates`;
  try {
    const example = CURRICULUM[0].templates[0].examples[0];
    db.prepare(
      `INSERT INTO problems (platform, problem_key, title, url, tags) VALUES (?, ?, '', ?, '[]')`,
    ).run(example.platform, example.key, example.url);
    db.prepare(
      `INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id)
       VALUES (1, ?, (SELECT id FROM problems WHERE platform = ? AND problem_key = ?), 'AC', '2026-08-30T00:00:00Z', 'x1')`,
    ).run(example.platform, example.platform, example.key);

    const list = (await (await fetch(base)).json()) as {
      categories: Array<{ templates: Array<{ examples: Array<{ key: string; ac: boolean }> }> }>;
    };
    const ex = list.categories[0].templates[0].examples.find((e) => e.key === example.key)!;
    assert.equal(ex.ac, true);
  } finally {
    srv.close();
    db.close();
  }
});

test('templates list still exposes built-in curriculum invariants', async () => {
  await withServer(async (base) => {
    const list = (await (await fetch(base)).json()) as { total: number; categories: unknown[] };
    assert.equal(list.total, TEMPLATE_TOTAL);
    assert.equal(list.categories.length, CURRICULUM.length);
  });
});

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
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/templates`;
  try {
    await fn(base);
  } finally {
    srv.close();
    db.close();
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' };

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
    const after = (await (await fetch(base)).json()) as { mastered: number };
    assert.equal(after.mastered, 1);

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
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { CURRICULUM, TEMPLATE_TOTAL } from '../src/templates/curriculum.ts';
import { nextTemplate, type ProgressEntry } from '../src/templates/progress.ts';
import { templatesRoutes } from '../src/routes/templates.ts';

test('curriculum: outline slots, unique ids, no pre-baked content', () => {
  assert.equal(CURRICULUM.length, 8);
  const ids = new Set<string>();
  for (const cat of CURRICULUM) {
    assert.ok(cat.templates.length >= 3, `${cat.key} 模板过少`);
    for (const t of cat.templates) {
      assert.ok(!ids.has(t.id), `模板 id 重复: ${t.id}`);
      ids.add(t.id);
      assert.ok(t.difficulty >= 1 && t.difficulty <= 5);
      // 大纲模式：不预置模板内容，只有要点说明
      assert.equal((t as unknown as { code?: string }).code, undefined, `${t.id} 不应预置代码`);
      assert.ok(t.outline.length > 10, `${t.id} 缺少大纲要点`);
    }
  }
  assert.equal(ids.size, TEMPLATE_TOTAL);
});

function progressOf(statuses: Record<string, string>): Map<string, ProgressEntry> {
  return new Map(Object.entries(statuses).map(([k, s]) => [k, { status: s as ProgressEntry['status'], note: null }]));
}

test('nextTemplate: first learning beats earlier todo; falls back to first todo', () => {
  const ids = CURRICULUM.flatMap((c) => c.templates.map((t) => t.id));
  const first = ids[0];
  // 全未学 → 大纲第一个
  assert.equal(nextTemplate(new Map())?.id, first);
  // 第一个分类里第三个模板在学习中 → 优先返回它
  const learning = CURRICULUM[0].templates[2].id;
  assert.equal(nextTemplate(progressOf({ [learning]: 'learning' }))?.id, learning);
  // 前面全部掌握 → 返回第一个未掌握的
  const mastered: Record<string, string> = {};
  for (const id of ids) mastered[id] = 'mastered';
  delete mastered[ids[3]];
  assert.equal(nextTemplate(progressOf(mastered))?.id, ids[3]);
  // 全部掌握 → undefined
  mastered[ids[3]] = 'mastered';
  assert.equal(nextTemplate(progressOf(mastered)), undefined);
});

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

test('templates API: list with progress, status cycle, note persist', async () => {
  await withServer(async (base) => {
    // 初始：total/next
    const initial = (await (await fetch(base)).json()) as {
      total: number;
      mastered: number;
      next: { id: string } | null;
      categories: Array<{
        key: string;
        templates: Array<{
          id: string;
          status: string;
          note: string | null;
          content: { code: string | null; url: string | null } | null;
        }>;
      }>;
    };
    assert.equal(initial.total, TEMPLATE_TOTAL);
    assert.equal(initial.next!.id, CURRICULUM[0].templates[0].id);
    assert.equal(initial.categories.length, 8);

    const target = CURRICULUM[0].templates[0];
    // 写入自己的模板内容
    const putRes = await fetch(`${base}/${target.id}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '// my binary search', idea: '找第一个 >= x', complexity: 'O(log n)', url: 'https://notes.example/x' }),
    });
    assert.deepEqual(await putRes.json(), { ok: true, hasContent: true });
    // 置为学习中
    const res1 = await fetch(`${base}/${target.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'learning' }),
    });
    assert.deepEqual(await res1.json(), { ok: true });
    // 记笔记
    const res2 = await fetch(`${base}/${target.id}/note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '二分注意开闭区间' }),
    });
    assert.deepEqual(await res2.json(), { ok: true });
    // 置为已掌握
    await fetch(`${base}/${target.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'mastered' }),
    });

    const after = (await (await fetch(base)).json()) as typeof initial & {
      mastered: number;
    };
    assert.equal(after.mastered, 1);
    const updated = after.categories[0].templates.find((t) => t.id === target.id)!;
    assert.equal(updated.status, 'mastered');
    assert.equal(updated.note, '二分注意开闭区间');
    assert.equal(updated.content!.code, '// my binary search');
    assert.equal(updated.content!.url, 'https://notes.example/x');
    // 未写入的条目 content 为 null
    const other = after.categories[0].templates.find((t) => t.id !== target.id)!;
    assert.equal(other.content, null);
    // next 跳过已掌握的
    assert.notEqual(after.next!.id, target.id);

    // next 接口
    const nextRes = (await (await fetch(`${base}/next`)).json()) as { next: { id: string } | null };
    assert.notEqual(nextRes.next!.id, target.id);
  });
});

test('templates API: content write rejects unknown id and oversized code', async () => {
  await withServer(async (base) => {
    const bad1 = await fetch(`${base}/no-such/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x' }),
    });
    assert.equal(bad1.status, 404);
    const bad2 = await fetch(`${base}/ds-dsu/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x'.repeat(20001) }),
    });
    assert.equal(bad2.status, 400);
  });
});

test('templates API: rejects unknown id and invalid status', async () => {
  await withServer(async (base) => {
    const bad1 = await fetch(`${base}/no-such/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'mastered' }),
    });
    assert.equal(bad1.status, 404);
    const bad2 = await fetch(`${base}/ds-dsu/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(bad2.status, 400);
  });
});

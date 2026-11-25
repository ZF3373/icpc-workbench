import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { notesRoutes } from '../src/routes/notes.ts';
import { problemNoteKey } from '../src/notes/store.ts';

/**
 * 题目 / 比赛独立笔记（issue #71）的接口口径：
 * - 按**题目身份**定位（洛谷 CF 镜像与 CF 原题是同一条笔记）；
 * - 没写过不是错误（200 + 空正文）；空正文写回 = 删除；
 * - 批量摘要只回有笔记的键。
 */

async function withServer<T>(db: Db, run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api/notes', notesRoutes(db));
  const srv = await listenForTest(app);
  try {
    return await run(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/notes`);
  } finally {
    srv.close();
  }
}

const getJson = async (url: string) => (await fetch(url)).json() as Promise<Record<string, unknown>>;

const putJson = async (url: string, body: unknown) =>
  (await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json() as Promise<Record<string, unknown>>;

test('题目笔记：没写过返回空正文而不是 404', async () => {
  const db = createDb(':memory:');
  await withServer(db, async (base) => {
    const r = await getJson(`${base}/problem/codeforces/1919C`);
    assert.equal(r.text, '');
    assert.equal(r.hasNote, false);
    assert.equal(r.identity, 'codeforces:1919c');
  });
});

test('题目笔记：写入后可按身份读回，且镜像题号命中同一条', async () => {
  const db = createDb(':memory:');
  await withServer(db, async (base) => {
    const saved = await putJson(`${base}/problem/codeforces/1919C`, { text: '# 关键性质\n\\n- 答案是 **1**' });
    assert.equal(saved.hasNote, true);
    assert.equal(saved.identity, 'codeforces:1919c');

    // 洛谷的 CF1000A 这种镜像题号归一到同一个身份（见 problems/identity.ts）
    const mirror = await getJson(`${base}/problem/luogu/CF1919C`);
    assert.equal(mirror.hasNote, true);
    assert.equal(mirror.identity, 'codeforces:1919c');
  });
});

test('题目笔记：空正文写回 = 删除，摘要里不再出现', async () => {
  const db = createDb(':memory:');
  await withServer(db, async (base) => {
    await putJson(`${base}/problem/codeforces/1A`, { text: '记一笔' });
    const cleared = await putJson(`${base}/problem/codeforces/1A`, { text: '   ' });
    assert.equal(cleared.hasNote, false);
    const summaries = (await (await fetch(`${base}/summaries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problems: [{ platform: 'codeforces', problemKey: '1A' }] }),
    })).json()) as { problems: Record<string, unknown> };
    assert.deepEqual(summaries.problems, {});
  });
});

test('批量摘要：只回有笔记的键，摘要剥掉 Markdown 装饰', async () => {
  const db = createDb(':memory:');
  await withServer(db, async (base) => {
    await putJson(`${base}/problem/codeforces/1919C`, { text: '## 赛时卡点\n\n想了 40 分钟' });
    const res = (await (await fetch(`${base}/summaries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        problems: [
          { platform: 'codeforces', problemKey: '1919C' },
          { platform: 'codeforces', problemKey: '1A' },
        ],
      }),
    })).json()) as { problems: Record<string, { summary: string }> };
    assert.equal(Object.keys(res.problems).length, 1);
    assert.equal(res.problems['codeforces:1919c']?.summary, '赛时卡点');
  });
});

test('比赛笔记：按 contestKey 读写；非法 key 400', async () => {
  const db = createDb(':memory:');
  await withServer(db, async (base) => {
    const saved = await putJson(`${base}/contest/codeforces:1877`, { text: 'B 换 C 换晚了' });
    assert.equal(saved.hasNote, true);
    const read = await getJson(`${base}/contest/codeforces:1877`);
    assert.equal(read.text, 'B 换 C 换晚了');

    const bad = await fetch(`${base}/contest/not-a-key`);
    assert.equal(bad.status, 400);
  });
});

test('身份归一：problemNoteKey 与 problems/identity.ts 同一口径', () => {
  assert.equal(problemNoteKey('luogu', 'CF1000A'), 'codeforces:1000a');
  assert.equal(problemNoteKey('atcoder', 'abc321_a'), 'atcoder:abc321a');
  assert.equal(problemNoteKey('luogu', 'P1001'), 'luogu:p1001');
});

test('笔记长度超限：400 而不是静默截断', async () => {
  const db = createDb(':memory:');
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/problem/codeforces/1919C`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(20_001) }),
    });
    assert.equal(res.status, 400);
  });
});

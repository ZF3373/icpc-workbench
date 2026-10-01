import { listenForTest } from './test-listen.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';

let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; });

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const d = createDb(':memory:');
  db = d;
  d.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  d.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (1,'codeforces','1A','T',1500,'[]')").run();
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(d));
  const srv = await listenForTest(app);
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/problems`);
  } finally {
    srv.close();
  }
}

test('POST intent: 记录用户声明的卡点（code 可空）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'wrong_approach', code: 'basic.greedy' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; id: number };
    assert.equal(body.ok, true);
    assert.ok(body.id > 0);

    // code 省略 = 非知识点摩擦（「我会做但实现崩了」），也应成功
    const res2 = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'implementation' }),
    });
    assert.equal(res2.status, 200);
  });
});

test('POST intent: 非法 outcome 或非法 code 返回 400 且不写库', async () => {
  await withServer(async (base) => {
    const bad1 = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: '不知道怎么选' }),
    });
    assert.equal(bad1.status, 400);

    const bad2 = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'cant_start', code: '不存在的code' }),
    });
    assert.equal(bad2.status, 400);

    const { c } = db!.prepare('SELECT COUNT(*) AS c FROM submission_intents').get() as { c: number };
    assert.equal(c, 0, '非法请求不应写库');
  });
});

test('GET intents: 返回该题的全部声明，按时间倒序', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'cant_start', code: 'basic.greedy' }),
    });
    await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'slight_bug' }),
    });
    const res = await fetch(`${base}/codeforces/1A/intents`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ code: string | null; outcome: string }> };
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].outcome, 'slight_bug', '最新的在前');
  });
});

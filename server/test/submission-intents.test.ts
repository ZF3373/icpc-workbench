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

test('POST intent: 赛后补题（upsolved）在白名单内，可正常写入', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'upsolved' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; id: number };
    assert.equal(body.ok, true);
    const row = db!.prepare('SELECT outcome FROM submission_intents WHERE id = ?').get(body.id) as {
      outcome: string;
    };
    assert.equal(row.outcome, 'upsolved');
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
    const body = (await res.json()) as { items: Array<{ id: number; code: string | null; outcome: string; createdAt: string }> };
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].outcome, 'slight_bug', '最新的在前');
    // id 是撤销（DELETE）的定位键；createdAt 归一成 ISO（SQLite datetime 空格格式会被前端按本地时区误读）
    for (const item of body.items) {
      assert.ok(Number.isInteger(item.id) && item.id > 0, '每条记录必须带正整数 id');
      assert.match(item.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'createdAt 必须是 ISO UTC');
    }
  });
});

test('DELETE intents/:id: 只删指定一条，重复删返回 404', async () => {
  await withServer(async (base) => {
    const post = (outcome: string) =>
      fetch(`${base}/codeforces/1A/intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      }).then((r) => r.json() as Promise<{ id: number }>);
    const first = await post('cant_start');
    const second = await post('slight_bug');

    const bad = await fetch(`${base}/codeforces/1A/intents/999999`, { method: 'DELETE' });
    assert.equal(bad.status, 404, '不存在的 id 返回 404');

    const del = await fetch(`${base}/codeforces/1A/intents/${first.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const body = (await del.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    const again = await fetch(`${base}/codeforces/1A/intents/${first.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404, '已删除的记录再删返回 404');

    const list = (await (await fetch(`${base}/codeforces/1A/intents`)).json()) as {
      items: Array<{ id: number }>;
    };
    assert.deepEqual(list.items.map((i) => i.id), [second.id], '只剩未删除的一条');
  });
});

test('DELETE intents/:id: 路径参数非法时返回 400', async () => {
  await withServer(async (base) => {
    const badPlatform = await fetch(`${base}/nojudge/1A/intents/1`, { method: 'DELETE' });
    assert.equal(badPlatform.status, 400);
    const badId = await fetch(`${base}/codeforces/1A/intents/abc`, { method: 'DELETE' });
    assert.equal(badId.status, 400);
    const missingProblem = await fetch(`${base}/codeforces/99X/intents/1`, { method: 'DELETE' });
    assert.equal(missingProblem.status, 404);
  });
});

test('列表接口带卡点聚合：intentCount 与 worstIntent 按 intentFactor 取最差', async () => {
  await withServer(async (base) => {
    db!.prepare(
      "INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (2,'codeforces','1B','T2',1800,'[]')",
    ).run();
    // 1A：记「差一点」+「完全不会」→ 最差是 cant_start（0.45 < 0.95），共 2 条
    for (const outcome of ['slight_bug', 'cant_start']) {
      await fetch(`${base}/codeforces/1A/intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
    }
    // 1B：不记（bank=1 才能看到没有提交记录的题——列表默认只显示做过的题）
    const rows = (await (await fetch(`${base}/?platform=codeforces&bank=1`)).json()) as Array<{
      problem_key: string;
      intentCount: number;
      worstIntent: string | null;
    }>;
    const a = rows.find((r) => r.problem_key === '1A');
    const b = rows.find((r) => r.problem_key === '1B');
    assert.equal(a?.intentCount, 2);
    assert.equal(a?.worstIntent, 'cant_start', '最差卡点按弱项权重（intentFactor 最小）选取');
    assert.equal(b?.intentCount, 0, '没记过的题计数为 0');
    assert.equal(b?.worstIntent, null);
  });
});

test('GET /?intent=1: 只返回记过卡点的题，不带参数时不过滤', async () => {
  await withServer(async (base) => {
    db!.prepare(
      "INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (2,'codeforces','1B','T2',1800,'[]')",
    ).run();
    // 只有 1A 记过卡点
    await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'upsolved' }),
    });
    const filtered = (await (await fetch(`${base}/?bank=1&intent=1`)).json()) as Array<{ problem_key: string }>;
    assert.deepEqual(filtered.map((r) => r.problem_key), ['1A'], 'intent=1 只保留记过卡点的题');

    const all = (await (await fetch(`${base}/?bank=1`)).json()) as Array<{ problem_key: string }>;
    assert.deepEqual(
      all.map((r) => r.problem_key).sort(),
      ['1A', '1B'],
      '不带 intent 参数时不过滤',
    );
  });
});

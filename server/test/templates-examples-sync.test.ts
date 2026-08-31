import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { register } from '../src/adapters/index.ts';
import { templatesRoutes } from '../src/routes/templates.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function withServer(fn: (base: string, db: Db) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/templates`;
  try {
    await fn(base, db);
  } finally {
    srv.close();
    db.close();
  }
}

function acCf(problemKey: string, externalId: string): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces',
      problemKey,
      title: `T ${problemKey}`,
      difficulty: 1500,
      url: 'https://codeforces.com/',
      tags: [],
    },
    verdict: 'AC',
    language: 'C++',
    submittedAt: '2026-08-30T10:00:00.000Z',
    externalId,
  };
}

function registerFakeCf(rows: NormalizedSubmission[]): void {
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions() {
      return rows;
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
}

test('examples/sync: 拉取已绑定平台最新提交并刷新例题 AC 状态', async () => {
  await withServer(async (base, db) => {
    // basic-binary-search 的例题：洛谷 P2249 + CF 279/B
    registerFakeCf([acCf('279/B', 'e1')]);
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, 'codeforces', 'tourist', NULL, 1)`,
    ).run(DEFAULT_USER_ID);

    const resp = await fetch(`${base}/examples/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ templateId: 'basic-binary-search' }),
    });
    assert.equal(resp.status, 200);
    const { results } = (await resp.json()) as {
      results: Array<{ platform: string; handle: string | null; imported: number; errors: string[] }>;
    };
    const cfResult = results.find((r) => r.platform === 'codeforces')!;
    assert.equal(cfResult.handle, 'tourist');
    assert.equal(cfResult.imported, 1);
    assert.deepEqual(cfResult.errors, []);
    // 未绑定洛谷：引导提示而非失败
    const lgResult = results.find((r) => r.platform === 'luogu')!;
    assert.equal(lgResult.imported, 0);
    assert.ok(lgResult.errors[0].includes('洛谷'));

    // 例题状态已刷新：279/B 自动入库且 AC；P2249 未入库未 AC
    const list = (await (await fetch(base)).json()) as {
      categories: Array<{
        templates: Array<{ id: string; examples: Array<{ key: string; inBank?: boolean; ac?: boolean }> }>;
      }>;
    };
    const examples = list.categories
      .flatMap((c) => c.templates)
      .find((t) => t.id === 'basic-binary-search')!.examples;
    const solved = examples.find((e) => e.key === '279/B')!;
    assert.equal(solved.inBank, true);
    assert.equal(solved.ac, true);
    const untouched = examples.find((e) => e.key === 'P2249')!;
    assert.equal(untouched.inBank, false);
    assert.equal(untouched.ac, false);
  });
});

test('examples/sync: 参数校验 + 未绑定全部平台时返回引导而非失败', async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/examples/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const unknown = await fetch(`${base}/examples/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ templateId: 'no-such-template' }),
    });
    assert.equal(unknown.status, 404);

    const unbound = await fetch(`${base}/examples/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ templateId: 'basic-binary-search' }),
    });
    assert.equal(unbound.status, 200);
    const { results } = (await unbound.json()) as {
      results: Array<{ platform: string; errors: string[] }>;
    };
    assert.equal(results.length, 2); // 涉及平台去重后逐一给出提示
    for (const r of results) assert.ok(r.errors.length > 0);
  });
});

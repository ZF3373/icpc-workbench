import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { exportRoutes } from '../src/routes/export.ts';

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/export', exportRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/export`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('GET /plan-package 校验 startDate，不再把非法日期拼进提示词（B13 回归）', async () => {
  /**
   * buildPlanPackage 会把 startDate **原样拼进提示词**（"计划从 <startDate> 开始，共 N 天"），
   * 非法值会被当成有效日期交给 AI 排期。此前只有 savePlan / /api/plans/import 校验，
   * 本端点漏了。口径统一为 isCalendarDate（真实存在的 YYYY-MM-DD）。
   */
  await withServer(async (_db, base) => {
    for (const bad of ['garbage', '2026-13-45', '2026-02-30', '2026/10/09']) {
      const res = await fetch(`${base}/plan-package?days=7&startDate=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `startDate=${bad} 应被拒绝`);
      const msg = ((await res.json()) as { error: string }).error;
      assert.match(msg, /startDate/);
    }

    // 省略 / 空串 → 默认今天，照常返回
    for (const q of ['', '&startDate=']) {
      const res = await fetch(`${base}/plan-package?days=7${q}`);
      assert.equal(res.status, 200, `startDate 省略/空串应走默认`);
    }
    // 合法日期照常工作，且日期确实出现在提示词里
    const ok = await fetch(`${base}/plan-package?days=7&startDate=2026-10-09`);
    assert.equal(ok.status, 200);
    const pkg = (await ok.json()) as { prompt: string };
    assert.ok(pkg.prompt.includes('2026-10-09'), '合法日期应出现在提示词中');

    // days 越界同样被夹紧（1-90），不因超界报错
    const clamp = await fetch(`${base}/plan-package?days=99999&startDate=2026-10-09`);
    assert.equal(clamp.status, 200);
  });
});

test('GET /plan-prompt.md 与 plan-package 同一套校验', async () => {
  await withServer(async (_db, base) => {
    const bad = await fetch(`${base}/plan-prompt.md?days=7&startDate=garbage`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/plan-prompt.md?days=7&startDate=2026-10-09`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /text\/markdown/);
  });
});

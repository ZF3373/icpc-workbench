import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVjudgeAdapter } from '../src/adapters/vjudge.ts';
import { SyncError } from '../src/adapters/types.ts';

const timestamp = 1788487236000;
const row = (over: Record<string, unknown> = {}) => ({
  runId: 1, time: timestamp, oj: '洛谷', probNum: 'P1001',
  status: 'Accepted', processing: false, userName: 'Fantasy____', ...over,
});

/** legacy http 路径在 agent 模式下绝不应被走到 */
const forbiddenFetch: typeof fetch = async () => {
  throw new Error('legacy http 路径不应被走到');
};

test('VJudge 适配器：agent 传输下解析记录 JSON 并映射回原 OJ', async () => {
  const seen: string[] = [];
  const adapter = createVjudgeAdapter(forbiddenFetch, {
    fetchPage: async (url) => {
      seen.push(url);
      return {
        status: 200,
        body: JSON.stringify({ data: [
          row(),
          row({ runId: 2, oj: 'CodeForces', probNum: '123A', status: 'Wrong answer on test 2' }),
        ] }),
        finalUrl: url,
      };
    },
  });
  const rows = await adapter.fetchUserSubmissions('Fantasy____', { pageDelayMs: 0 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.verdict), ['AC', 'WA']);
  assert.equal(rows[0].problem.platform, 'luogu');
  assert.equal(rows[0].problem.problemKey, 'P1001');
  assert.equal(rows[1].problem.platform, 'codeforces');
  assert.match(seen[0], /vjudge\.net\/status\/data/);
  assert.match(seen[0], /un=Fantasy____/);
});

test('VJudge 适配器：agent 传输下 Cloudflare 挑战页 → 引导刷新助手窗口', async () => {
  const adapter = createVjudgeAdapter(forbiddenFetch, {
    fetchPage: async () => ({
      status: 403,
      body: '<html><head><title>Just a moment...</title></head><body>challenge-platform</body></html>',
    }),
  });
  await assert.rejects(
    () => adapter.fetchUserSubmissions('Fantasy____', { pageDelayMs: 0 }),
    (e: Error) => {
      assert.ok(e instanceof SyncError);
      assert.equal(e.code, 'auth_expired');
      assert.match(e.message, /VJudge 助手窗口被 Cloudflare 拦截/);
      assert.match(e.message, /刷新 VJudge 助手窗口/);
      return true;
    },
  );
});

test('VJudge 适配器：agent 传输下非 200 → 带平台标注的 HTTP 错误', async () => {
  const adapter = createVjudgeAdapter(forbiddenFetch, {
    fetchPage: async () => ({ status: 503, body: '' }),
  });
  await assert.rejects(
    () => adapter.fetchUserSubmissions('Fantasy____', { pageDelayMs: 0 }),
    (e: Error) => {
      assert.ok(e instanceof SyncError);
      assert.equal(e.code, 'rate_limited');
      assert.match(e.message, /HTTP 503（经助手窗口）/);
      return true;
    },
  );
});

test('VJudge 适配器：agent 传输下非 JSON 响应 → schema_changed', async () => {
  const adapter = createVjudgeAdapter(forbiddenFetch, {
    fetchPage: async () => ({ status: 200, body: '<html>维护中</html>' }),
  });
  await assert.rejects(
    () => adapter.fetchUserSubmissions('Fantasy____', { pageDelayMs: 0 }),
    (e: Error) => {
      assert.ok(e instanceof SyncError);
      assert.equal(e.code, 'schema_changed');
      assert.match(e.message, /未返回 JSON/);
      return true;
    },
  );
});
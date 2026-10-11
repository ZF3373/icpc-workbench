import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  agentAlive,
  DEFAULT_AGENT_TIMEOUT_MS,
  fetchPageViaAgent,
  popJob,
  resetAgentForTests,
  resolveJob,
} from '../src/adapters/qojAgent.ts';
import { qojAgentRoutes } from '../src/routes/qojAgent.ts';
import { createQojAdapter } from '../src/adapters/qoj.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';

// ---------- 任务队列（qojAgent.ts） ----------

test('qojAgent：入队 → 领取 → 回传 的完整回路', async () => {
  resetAgentForTests();
  popJob(); // 点亮活跃
  const p = fetchPageViaAgent('https://qoj.ac/submissions?submitter=x&page=2');
  const job = popJob();
  assert.ok(job, '入队后应可领取');
  assert.match(job.url, /page=2/);
  assert.equal(resolveJob(job.id, 200, '<html>ok</html>', 'https://qoj.ac/submissions'), true);
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal(r.body, '<html>ok</html>');
  assert.equal(r.finalUrl, 'https://qoj.ac/submissions');
  // 未知 id 拒绝（防伪造注入）
  assert.equal(resolveJob(999999, 200, 'x'), false);
});

test('qojAgent：超时未回传 → 明确报助手窗口错误', async () => {
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  popJob(); // 置活跃（跳过等上线）
  await assert.rejects(
    () => fetchPageViaAgent('https://qoj.ac/x', 50),
    (e: Error) => /助手窗口/.test(e.message),
  );
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
});

test('qojAgent：守护脚本不在线 → 快速失败而非傻等超时', async () => {
  resetAgentForTests(); // agentSeenAt=0 → 不在线
  const started = Date.now();
  await assert.rejects(() => fetchPageViaAgent('https://qoj.ac/x', 30000), (e: Error) => /助手窗口/.test(e.message));
  assert.ok(Date.now() - started < DEFAULT_AGENT_TIMEOUT_MS, '应在等待上线预算内快速失败');
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
});

test('qojAgent：FIFO——两个任务按入队顺序领取', async () => {
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  const pa = fetchPageViaAgent('https://qoj.ac/a');
  const pb = fetchPageViaAgent('https://qoj.ac/b');
  const first = popJob();
  const second = popJob();
  assert.equal(first?.url, 'https://qoj.ac/a');
  assert.equal(second?.url, 'https://qoj.ac/b');
  // 兑现两个挂起任务，避免 reset 的拒绝落到测试外变成 unhandledRejection
  resolveJob(first!.id, 200, 'a');
  resolveJob(second!.id, 200, 'b');
  assert.equal((await pa).body, 'a');
  assert.equal((await pb).body, 'b');
  resetAgentForTests();
});

// ---------- 交换端点（routes/qojAgent.ts） ----------

async function startAgentEndpoint(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/qoj-agent', qojAgentRoutes());
  const srv: Server = await listenForTest(app);
  const { port } = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/qoj-agent`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('qoj-agent 端点：CORS 放行 qoj.ac + PNA 预检 + 任务回路', async () => {
  const b = await startAgentEndpoint();
  try {
    resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
    void fetchPageViaAgent('https://qoj.ac/submissions?submitter=hieZF123&page=1');

    // 预检：204 + CORS/PNA 头（https 页面 → 127.0.0.1 的私网访问要求）
    const pre = await fetch(`${b.url}/next`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://qoj.ac');
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');

    // 领任务
    const next = await (await fetch(`${b.url}/next`)).json() as { job: { id: number; url: string } | null };
    assert.ok(next.job);
    assert.match(next.job.url, /submitter=hieZF123/);

    // 回传 → 入队侧 Promise 兑现
    const posted = await (await fetch(`${b.url}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: next.job.id, status: 200, body: '<html>page</html>', finalUrl: 'https://qoj.ac/submissions' }) })).json() as { ok: boolean };
    assert.equal(posted.ok, true);
    resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  } finally {
    await b.close();
  }
});

test('qoj-agent 端点：/alive 反映守护脚本活跃度（壳刷新后提前收工的依据）', async () => {
  const b = await startAgentEndpoint();
  try {
    resetAgentForTests();
    const cold = await (await fetch(`${b.url}/alive`)).json() as { alive: boolean };
    assert.equal(cold.alive, false);
    popJob(); // 守护脚本开始轮询 → 活跃
    const warm = await (await fetch(`${b.url}/alive`)).json() as { alive: boolean };
    assert.equal(warm.alive, true);
    resetAgentForTests();
  } finally {
    await b.close();
  }
});

test('qoj-agent 端点：/result 校验字段；未知 id 返回 ok:false', async () => {
  const b = await startAgentEndpoint();
  try {
    resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
    const bad = await fetch(`${b.url}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x' }) });
    assert.equal(bad.status, 400);
    const unknown = await (await fetch(`${b.url}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 12345, status: 200, body: 'x' }) })).json() as { ok: boolean };
    assert.equal(unknown.ok, false);
    resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  } finally {
    await b.close();
  }
});

// ---------- 适配器接入（WebView 传输路径） ----------

/** 最小 QOJ 提交列表页（结构与 qoj.test.ts 夹具同款，仅保留解析所需骨架） */
function agentPage(submitter: string): string {
  const row = (id: number) => `<tr>
    <td><a href="/submission/${id}">#${id}</a></td>
    <td><a href="/problem/${1000 + id}">A. Problem ${id}</a></td>
    <td><a href="/user/profile/${submitter}">${submitter}</a></td>
    <td>AC ✓</td><td>12ms</td><td>256M</td><td>C++17</td><td>1024B</td>
    <td><small>2026-10-11 11:00:00</small></td></tr>`;
  return `<!DOCTYPE html><html><body><table class="table"><thead><tr>
    <th>#</th><th>Problem</th><th>Submitter</th><th>Result</th><th>Time</th><th>Memory</th><th>Language</th><th>Length</th><th>Submit Time</th>
    </tr></thead><tbody>${row(900)}${row(899)}</tbody></table>
    <p class="text-center text-muted">Server Time: 2026-10-11 19:00:00</p></body></html>`;
}

test('qoj 适配器：agent 传输下无需 Cookie 即可同步解析', async () => {
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  const seen: string[] = [];
  const adapter = createQojAdapter(
    async () => {
      throw new Error('legacy http 路径不应被走到');
    },
    {
      fetchPage: async (url) => {
        seen.push(url);
        return { status: 200, body: agentPage('hieZF123'), finalUrl: url };
      },
    },
  );
  // 不传 cookie —— WebView 代理模式登录态在壳内浏览器里
  const subs = await adapter.fetchUserSubmissions('hieZF123', { pageDelayMs: 0 });
  assert.equal(subs.length, 2);
  assert.equal(subs[0]!.externalId, '900');
  assert.equal(subs[0]!.verdict, 'AC');
  assert.match(seen[0]!, /submitter=hieZF123/);
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
});

test('qoj 适配器：agent 传输下登录页 → 引导重登（无需 Cookie 前置检查）', async () => {
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  const adapter = createQojAdapter(
    async () => {
      throw new Error('legacy http 路径不应被走到');
    },
    {
      fetchPage: async (url) => ({
        status: 200,
        body: '<html><body><form action="/login">请登录</form></body></html>',
        finalUrl: 'https://qoj.ac/login',
      }),
    },
  );
  await assert.rejects(
    () => adapter.fetchUserSubmissions('hieZF123', { pageDelayMs: 0 }),
    (e: Error) => {
      assert.ok(e instanceof ManualImportRequiredError);
      assert.match(e.message, /登录态已失效/);
      assert.match(e.message, /在应用内登录 QOJ/);
      return true;
    },
  );
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
});

test('qoj 适配器：agent 传输下 checkAuth 不再要求已存 Cookie', async () => {
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
  const adapter = createQojAdapter(
    async () => {
      throw new Error('legacy http 路径不应被走到');
    },
    {
      fetchPage: async (url) => ({ status: 200, body: agentPage('hieZF123'), finalUrl: url }),
    },
  );
  const r = await adapter.checkAuth!({ cookie: '', handle: 'hieZF123' });
  assert.equal(r.ok, true);
  assert.match(r.message, /凭据有效/);
  resetAgentForTests();
  popJob(); // 点亮活跃：fetchPageViaAgent 先等守护脚本上线
});

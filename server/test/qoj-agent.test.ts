import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  fetchPageViaAgent,
  popJob,
  resetAgentForTests,
  resolveJob,
  agentAlive,
} from '../src/adapters/qojAgent.ts';
import { AgentUnavailableError } from '../src/adapters/qojAgent.ts';
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

test('qojAgent：代理不在线时抛 AgentUnavailableError（供调用方回退）', async () => {
  resetAgentForTests(); // agentSeenAt=0 → 不在线
  await assert.rejects(
    () => fetchPageViaAgent('https://qoj.ac/x', 30000),
    (e: Error) =>
      e instanceof AgentUnavailableError && e.reason === 'not-ready' && /助手窗口/.test(e.message),
  );
  resetAgentForTests();
  popJob();
});

test('qojAgent：有 Cookie 时代理不可用 → 回退到直连路径（issue #63 的 docker 场景）', async () => {
  resetAgentForTests(); // 代理离线 = 没有桌面壳（docker / 网页版）
  let called = 0;
  let sentCookie = '';
  const fetchFn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    called += 1;
    sentCookie = init?.headers?.Cookie ?? '';
    return new Response(
      `<html><body><table>
        <tr><td><a href="/submission/1">#1</a></td>
        <td><a href="/problem/100">A. Test</a></td>
        <td><span class="uoj-username">alice</span></td>
        <td><a class="uoj-score">AC</a></td>
        <td>17ms</td><td>4000kb</td><td><a href="/submission/1">C++</a></td>
        <td>1234b</td><td>2026-01-02 03:04:05</td></tr>
      </table><div>Server Time: 2026-01-02 03:04:06</div></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  }) as unknown as typeof fetch;
  const adapter = createQojAdapter(fetchFn, {
    fetchPage: (url, timeoutMs) => fetchPageViaAgent(url, timeoutMs),
  });
  const rows = await adapter.fetchUserSubmissions('alice', {
    cookie: 'cf_clearance=abc; __Host-UOJSESSID=def',
    ua: 'UA/1.0',
    maxSubmissions: 10,
  });
  assert.equal(called > 0, true, '代理不可用时应回退到直连 fetch');
  assert.match(sentCookie, /cf_clearance=abc/, '回退路径必须带上用户填的 Cookie');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.verdict, 'AC');
  resetAgentForTests();
});

test('qojAgent：没填 Cookie 时代理不可用 → 保留助手窗口提示（不回退）', async () => {
  resetAgentForTests();
  const adapter = createQojAdapter(fetch, {
    fetchPage: (url, timeoutMs) => fetchPageViaAgent(url, timeoutMs),
  });
  await assert.rejects(
    () => adapter.fetchUserSubmissions('alice', { maxSubmissions: 10 }),
    (e: Error) => e instanceof AgentUnavailableError && /助手窗口/.test(e.message),
  );
  resetAgentForTests();
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
  return { url: `http://127.0.0.1:${port}/api/qoj-agent`, close: () => new Promise<void>((r) => {
    srv.closeAllConnections();
    srv.close(() => r());
  }) };
}

function postNext(url: string, platform: string, origin?: string): Promise<Response> {
  return fetch(`${url}/next?platform=${platform}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: '{}',
  });
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

    // 领取：POST + JSON，跨站简单 GET 不再能消费任务
    const next = await (await postNext(b.url, 'qoj', 'https://qoj.ac')).json() as { job: { id: number; url: string } | null };
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

test('qoj-agent 端点：GET 和错误 Origin 不能消费任务或伪造在线', async () => {
  const b = await startAgentEndpoint();
  try {
    resetAgentForTests();
    const legacy = await fetch(`${b.url}/next?platform=qoj`);
    assert.equal(legacy.status, 404);
    assert.equal((await (await fetch(`${b.url}/alive?platform=qoj`)).json() as { alive: boolean }).alive, false);

    const cross = await postNext(b.url, 'qoj', 'https://evil.example');
    assert.equal(cross.status, 403);
    assert.equal((await (await fetch(`${b.url}/alive?platform=qoj`)).json() as { alive: boolean }).alive, false);

    popJob('qoj');
    const pending = fetchPageViaAgent('https://qoj.ac/submissions?submitter=x', 5000);
    assert.equal((await postNext(b.url, 'qoj', 'https://evil.example')).status, 403);
    const next = await (await postNext(b.url, 'qoj')).json() as { job: { id: number; url: string } };
    assert.ok(next.job);
    resolveJob(next.job.id, 200, '<html>ok</html>');
    assert.equal((await pending).body, '<html>ok</html>');
  } finally {
    resetAgentForTests();
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
      fetchPage: async (_url) => ({
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

// ---------- 多平台隔离（VJudge 接入同源代理） ----------

test('qojAgent：平台队列互相隔离，守护脚本只领本平台任务', async () => {
  resetAgentForTests();
  popJob('qoj');
  popJob('vjudge');
  const pq = fetchPageViaAgent('https://qoj.ac/submissions?submitter=x', 5000, 'qoj');
  const pv = fetchPageViaAgent('https://vjudge.net/status/data?un=x', 5000, 'vjudge');
  // vjudge 守护脚本领不到 qoj 任务，只领自己的
  const vj = popJob('vjudge');
  assert.ok(vj);
  assert.match(vj.url, /vjudge\.net/);
  assert.equal(popJob('vjudge'), null);
  const qj = popJob('qoj');
  assert.ok(qj);
  assert.match(qj.url, /qoj\.ac/);
  resolveJob(vj.id, 200, '{"data":[]}');
  resolveJob(qj.id, 200, '<html></html>');
  assert.equal((await pv).body, '{"data":[]}');
  assert.equal((await pq).body, '<html></html>');
  resetAgentForTests();
});

test('qojAgent：活跃判定按平台独立', async () => {
  resetAgentForTests();
  popJob('vjudge');
  assert.equal(agentAlive('vjudge'), true);
  assert.equal(agentAlive('qoj'), false);
  resetAgentForTests();
});

test('qojAgent：VJudge 守护脚本不在线 → 引导文案指向 VJudge 助手', async () => {
  resetAgentForTests();
  popJob('qoj'); // 只点亮 qoj，vjudge 仍不在线
  await assert.rejects(
    () => fetchPageViaAgent('https://vjudge.net/status/data?un=x', 30000, 'vjudge'),
    (e: Error) => /VJudge 助手窗口/.test(e.message),
  );
  resetAgentForTests();
});

test('qoj-agent 端点：platform 路由 + CORS 反射 vjudge.net + 回传源校验', async () => {
  const b = await startAgentEndpoint();
  try {
    resetAgentForTests();
    popJob('vjudge'); // 点亮 vjudge 活跃
    const pending = fetchPageViaAgent('https://vjudge.net/status/data?un=hieZF123', 5000, 'vjudge');

    // 预检反射 vjudge.net 源
    const pre = await fetch(`${b.url}/next?platform=vjudge`, { method: 'OPTIONS', headers: { Origin: 'https://vjudge.net' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://vjudge.net');

    // qoj 守护脚本领不到 vjudge 任务
    const wrongPlatform = await (await postNext(b.url, 'qoj', 'https://qoj.ac')).json() as { job: unknown };
    assert.equal(wrongPlatform.job, null);

    // vjudge 守护脚本领到自己的任务
    const next = await (await postNext(b.url, 'vjudge', 'https://vjudge.net')).json() as { job: { id: number; url: string } | null };
    assert.ok(next.job);
    assert.match(next.job.url, /un=hieZF123/);

    // 跨源回传被拒（qoj.ac 页面注入不了 vjudge 任务的结果）
    const cross = await (await fetch(`${b.url}/result`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://qoj.ac' }, body: JSON.stringify({ id: next.job.id, status: 200, body: 'evil' }) })).json() as { ok: boolean };
    assert.equal(cross.ok, false);

    // 同源回传兑现
    const ok = await (await fetch(`${b.url}/result`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://vjudge.net' }, body: JSON.stringify({ id: next.job.id, status: 200, body: '{"data":[]}' }) })).json() as { ok: boolean };
    assert.equal(ok.ok, true);
    assert.equal((await pending).body, '{"data":[]}');

    // 非法 platform → 400
    const bad = await postNext(b.url, 'evil', 'https://qoj.ac');
    assert.equal(bad.status, 400);
    resetAgentForTests();
  } finally {
    await b.close();
  }
});

import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '../src/middleware.ts';
import { asyncHandler } from '../src/asyncHandler.ts';

/**
 * 全局错误处理中间件的回归测试（对应优化计划 #1/#2/#3）。
 *
 * 三条防线都是「出错时最容易静默退化」的地方：
 * - 500 文案：一旦有人把 err.message 拼回响应体，SQL / 文件路径 / 上游原文就泄露给前端；
 * - entity.parse.failed：body-parser 把 status 设成 400，不特判就会落进 500 分支；
 * - headersSent：响应已发出后必须 next(err) 交给 Express 收尾，否则连接挂到超时。
 */

async function withApp(
  build: (app: express.Express) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  build(app);
  app.use(errorHandler);
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

test('未知错误返回 500，且不回显 err.message（文件路径/SQL 原文只进日志）', async () => {
  const secret = '/home/user/secret-project/server/data/icpc.db: no such table: submissions';
  const orig = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await withApp(
      (app) => {
        app.get('/boom', () => {
          throw new Error(secret);
        });
      },
      async (base) => {
        const res = await fetch(`${base}/boom`);
        assert.equal(res.status, 500);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, '服务器内部错误，请稍后重试或查看服务端日志');
        assert.ok(!body.error.includes(secret), '内部错误原文不得出现在响应里');
        assert.ok(!body.error.includes('no such table'), 'SQL 细节不得出现在响应里');
      },
    );
    // err.message 仍必须进服务端日志，否则错误无从排查（Error 的 message 不可枚举，
    // 不能靠 JSON.stringify 断言，直接取 message）
    assert.ok(
      logged.some(
        (args) =>
          Array.isArray(args) && args.some((a) => a instanceof Error && a.message.includes('no such table')),
      ),
      '错误原文应写入 console.error',
    );
  } finally {
    console.error = orig;
  }
});

test('async 路由 rejection 同样走 500 模糊文案', async () => {
  await withApp(
    (app) => {
      app.get(
        '/boom-async',
        asyncHandler(async () => {
          throw new Error('upstream fetch failed: https://api.example/v1?key=sk-leak');
        }),
      );
    },
    async (base) => {
      const res = await fetch(`${base}/boom-async`);
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, '服务器内部错误，请稍后重试或查看服务端日志');
      assert.ok(!body.error.includes('sk-leak'));
    },
  );
});

test('非法 JSON 请求体返回 400（不是 500），且不回显解析器原文', async () => {
  await withApp(
    (app) => {
      app.use(express.json());
      app.post('/echo', (req, res) => {
        res.json({ ok: true, body: req.body });
      });
    },
    async (base) => {
      const res = await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"broken": ',
      });
      assert.equal(res.status, 400, 'body-parser 的 entity.parse.failed 必须映射为 400');
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, '请求体不是合法 JSON');
      // 解析器原文形如 "Unexpected end of JSON input"，不该下发给前端
      assert.ok(!/Unexpected|JSON at position|in JSON/i.test(body.error));
    },
  );
});

test('请求体超限返回 413 而非 500', async () => {
  await withApp(
    (app) => {
      app.use(express.json({ limit: '10b' }));
      app.post('/echo', (req, res) => {
        res.json({ ok: true, body: req.body });
      });
    },
    async (base) => {
      const res = await fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(100) }),
      });
      assert.equal(res.status, 413);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /请求体过大/);
    },
  );
});

test('响应头已发出后抛错：必须 next(err) 转交 Express 默认处理器', () => {
  // 直接单测中间件：响应已开始发送时既不能改状态码，也不能默默 return —— 修复前
  // `if (res.headersSent) return;` 既不 next(err) 也不结束响应，连接会挂到超时。
  const err = new Error('stream broke mid-flight');
  let nextArg: unknown;
  let jsonCalled = false;
  const res = {
    headersSent: true,
    status: () => {
      throw new Error('响应已发出后不得再改状态码');
    },
    json: () => {
      jsonCalled = true;
      return res;
    },
  };
  const orig = console.error;
  console.error = () => {};
  try {
    errorHandler(err, {} as never, res as never, ((e: unknown) => {
      nextArg = e;
    }) as never);
  } finally {
    console.error = orig;
  }
  assert.equal(nextArg, err, '应把错误转交 next，由 Express 默认处理器收尾');
  assert.equal(jsonCalled, false, '响应已发出，不得再写 JSON 响应体');
});

test('响应头已发出后抛错：请求能及时结束，不会挂到超时', async () => {
  await withApp(
    (app) => {
      app.get('/stream-then-fail', (_req, res) => {
        // 模拟 SSE/流式响应中途出错：头已写出，状态码无法再改
        res.status(200).setHeader('content-type', 'text/plain');
        res.write('partial');
        throw new Error('stream broke mid-flight');
      });
    },
    async (base) => {
      // Express 默认处理器在 headersSent 后会销毁 socket，fetch 可能收到已发出的部分内容
      // 后正常结束、也可能报 socket 被关；两种都可接受 —— 不可接受的是「一直不返回」。
      const settled = (async () => {
        try {
          const res = await fetch(`${base}/stream-then-fail`);
          assert.equal(res.status, 200);
          await res.text();
          return 'ended';
        } catch {
          return 'closed';
        }
      })();
      const outcome = await Promise.race([
        settled,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]);
      assert.notEqual(outcome, 'timeout', '连接不得挂起到超时');
    },
  );
});

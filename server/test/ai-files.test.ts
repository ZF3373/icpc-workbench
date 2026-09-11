import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import type { AiConfig } from '../src/config.ts';

const AI_DISABLED: AiConfig = { enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' };

// ---------- mock OpenAI 兼容上游（Files API） ----------

interface UpstreamReq {
  method?: string;
  path?: string;
  auth?: string;
  contentType?: string;
  body: Buffer;
}

/** mock Files API 上游：POST /v1/files 回显 filename；记录所有请求 */
async function startFilesUpstream(opts: { requireKey?: string } = {}): Promise<{
  base: string;
  requests: UpstreamReq[];
  close: () => Promise<void>;
}> {
  const requests: UpstreamReq[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        path: req.url ?? '',
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });
      if (opts.requireKey && req.headers.authorization !== `Bearer ${opts.requireKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/files') {
        const text = body.toString('utf8');
        // multipart 中必须带 purpose=user_data 字段
        if (!text.includes('name="purpose"') || !text.includes('user_data')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'missing purpose=user_data' } }));
          return;
        }
        const m = /filename="([^"]*)"/.exec(text);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'file-api-test1',
            object: 'file',
            bytes: body.length,
            created_at: 1700000000,
            filename: m?.[1] ?? 'unknown',
            purpose: 'user_data',
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  srv.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

async function withServer(
  upstream: { base: string; close: () => Promise<void> },
  fn: (db: Db, root: string) => Promise<void>,
  cfg: AiConfig = { enabled: true, baseURL: upstream.base, apiKey: 'secret', model: 'm' },
): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRoutes(db, () => cfg));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(db, root);
  } finally {
    srv.close();
    db.close();
    // upstream 一并关闭：测试中途断言失败时若泄漏监听中的服务器，node:test 进程将永不退出
    await upstream.close();
  }
}

// ---------- 上传 ----------

test('POST /api/ai/files forwards multipart with purpose/filename/expires and Bearer key', async () => {
  const upstream = await startFilesUpstream({ requireKey: 'secret' });
  await withServer(upstream, async (_db, root) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const res = await fetch(`${root}/api/ai/files`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-file-name': encodeURIComponent('截图 测试.png'),
        'x-expires-seconds': '7200',
      },
      body: new Uint8Array(png),
    });
    assert.equal(res.status, 200);
    const file = (await res.json()) as { id: string; filename: string; object: string; purpose: string };
    assert.equal(file.id, 'file-api-test1');
    assert.equal(file.object, 'file');
    assert.equal(file.filename, '截图 测试.png'); // decodeURIComponent 已还原
    assert.equal(file.purpose, 'user_data');

    const up = upstream.requests[0]!;
    assert.equal(up.method, 'POST');
    assert.equal(up.path, '/v1/files');
    assert.equal(up.auth, 'Bearer secret');
    assert.match(up.contentType ?? '', /^multipart\/form-data; boundary=/);
    const text = up.body.toString('utf8');
    assert.match(text, /name="purpose"\r\n\r\nuser_data/);
    assert.match(text, /name="expires_after\[anchor\]"\r\n\r\ncreated_at/);
    assert.match(text, /name="expires_after\[seconds\]"\r\n\r\n7200/);
    assert.match(text, /filename="截图 测试.png"/);
  });

});

test('POST /api/ai/files defaults filename and omits expires when headers absent', async () => {
  const upstream = await startFilesUpstream();
  await withServer(upstream, async (_db, root) => {
    const res = await fetch(`${root}/api/ai/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 200);
    const text = upstream.requests[0]!.body.toString('utf8');
    assert.match(text, /filename="file"/);
    assert.equal(text.includes('expires_after'), false);
  });

});

test('POST /api/ai/files rejects empty body and invalid expires seconds', async () => {
  const upstream = await startFilesUpstream();
  await withServer(upstream, async (_db, root) => {
    const empty = await fetch(`${root}/api/ai/files`, { method: 'POST', body: new Uint8Array(0) });
    assert.equal(empty.status, 400);

    const badExp = await fetch(`${root}/api/ai/files`, {
      method: 'POST',
      headers: { 'x-expires-seconds': '100' }, // 低于 3600 下限
      body: new Uint8Array([1]),
    });
    assert.equal(badExp.status, 400);
    assert.match(((await badExp.json()) as { error: string }).error, /3600-2592000/);
  });

});

test('AI 未配置时 files 路由返回 400 needConfig', async () => {
  const upstream = await startFilesUpstream();
  await withServer(
    upstream,
    async (_db, root) => {
      const res = await fetch(`${root}/api/ai/files`, { method: 'POST', body: new Uint8Array([1]) });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; needConfig: boolean };
      assert.equal(body.needConfig, true);
    },
    AI_DISABLED,
  );
});

// ---------- 对话附件 → file 内容块 ----------

interface CapturedMsg {
  role: string;
  content: unknown;
}

async function withChatCapture(
  fn: (root: string, captured: CapturedMsg[][]) => Promise<void>,
): Promise<void> {
  const db = createDb(':memory:');
  const captured: CapturedMsg[][] = [];
  const app = express();
  app.use(express.json());
  const cfg: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };
  app.use(
    '/api/ai',
    aiRoutes(db, () => cfg, {
      createProvider: () => ({
        enabled: true,
        chat: async () => '',
        async *chatStream(messages) {
          captured.push(messages.slice(1) as CapturedMsg[]);
          yield 'ok';
        },
      }),
    }),
  );
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(root, captured);
  } finally {
    srv.close();
    db.close();
  }
}

test('chat: user attachments converted to file content blocks before text', async () => {
  await withChatCapture(async (root, captured) => {
    const res = await fetch(`${root}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: '这是什么题？', attachments: [{ fileId: 'file-api-1', filename: '题面.png' }] },
          { role: 'assistant', content: '这是一道贪心题。' },
          { role: 'user', content: '', attachments: [{ fileId: 'file-api-2' }] },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(captured.length, 1);
    const msgs = captured[0]!;
    // 第 1 条：file 块在前、文本块在后
    assert.deepEqual(msgs[0]!.content, [
      { type: 'file', file_id: 'file-api-1', filename: '题面.png' },
      { type: 'text', text: '这是什么题？' },
    ]);
    // 第 2 条：assistant 保持纯文本
    assert.equal(msgs[1]!.content, '这是一道贪心题。');
    // 第 3 条：纯附件消息允许空文本，只有 file 块
    assert.deepEqual(msgs[2]!.content, [{ type: 'file', file_id: 'file-api-2' }]);
  });
});

test('chat: attachments validation errors', async () => {
  await withChatCapture(async (root, captured) => {
    const post = (body: unknown) =>
      fetch(`${root}/api/ai/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // assistant 消息不允许带附件
    const att1 = await post({
      messages: [{ role: 'assistant', content: 'x', attachments: [{ fileId: 'f' }] }],
    });
    assert.equal(att1.status, 400);
    assert.match(((await att1.json()) as { error: string }).error, /仅允许出现在 user/);

    // 超过 8 个附件
    const many = Array.from({ length: 9 }, (_, i) => ({ fileId: `f${i}` }));
    const att2 = await post({ messages: [{ role: 'user', content: 'x', attachments: many }] });
    assert.equal(att2.status, 400);

    // fileId 缺失
    const att3 = await post({ messages: [{ role: 'user', content: 'x', attachments: [{ filename: 'a.png' }] }] });
    assert.equal(att3.status, 400);

    // 无附件且空文本
    const att4 = await post({ messages: [{ role: 'user', content: '  ' }] });
    assert.equal(att4.status, 400);

    assert.equal(captured.length, 0);
  });
});

// ---------- 历史消息中的本地文本附件（textContent 已剥离） ----------

test('chat: 本地附件（doc-/text- 前缀 fileId）不转 file 内容块', async () => {
  await withChatCapture(async (root, captured) => {
    const res = await fetch(`${root}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: '翻译并讲解D题',
            // 客户端持久化的历史消息：textContent 被剥离，只剩本地生成的假 fileId
            attachments: [{ fileId: 'doc-1234567890-abc123', filename: 'contest-60875-en.pdf', bytes: 304742 }],
          },
          { role: 'assistant', content: '这是D题的讲解……' },
          { role: 'user', content: '那复杂度是多少？' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();

    assert.equal(captured.length, 1);
    const msgs = captured[0]!;
    // 历史附件消息必须仍是纯字符串（无 file 内容块）——
    // 若被转为 file 块，上游不支持 audio/file 能力的模型会 400，第二轮起每次调用都失败
    assert.equal(typeof msgs[0]!.content, 'string');
    assert.match(msgs[0]!.content as string, /contest-60875-en\.pdf/);
    assert.match(msgs[0]!.content as string, /附件内容未随本轮携带/);
  });
});

test('chat: 首轮本地附件带 textContent 时正常拼接文本', async () => {
  await withChatCapture(async (root, captured) => {
    const res = await fetch(`${root}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: '讲解这题',
            attachments: [
              { fileId: 'text-1-a', filename: 'a.cpp', bytes: 10, textContent: 'int main(){}' },
            ],
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const msgs = captured[0]!;
    // 文本附件内容以代码块拼接到消息文本，仍是纯字符串
    assert.equal(typeof msgs[0]!.content, 'string');
    assert.match(msgs[0]!.content as string, /```cpp\nint main\(\)\{\}\n```/);
  });
});

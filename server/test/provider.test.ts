import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiProvider, type ChatMessage, type ToolCall, type TokenUsage } from '../src/ai/provider.ts';
import type { AiConfig } from '../src/config.ts';

const CFG: AiConfig = {
  enabled: true,
  baseURL: 'http://localhost-test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 5000,
};

/** 构造 mock fetch：按返回的 Response 序列依次返回 */
function mockFetch(responses: Array<{ status?: number; body?: string; headers?: Record<string, string> }>): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  let idx = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const r = responses[idx] ?? { status: 200, body: '{}' };
    idx++;
    return new Response(r.body ?? '{}', {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...r.headers },
    });
  };
  return { fetchFn, calls };
}

// ---------- HTTP 重试 ----------

describe('AiProvider retry', () => {
  it('retries on 429 then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, body: '{"error":"rate limited"}', headers: { 'retry-after': '0' } },
      { status: 200, body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result, 'ok');
    assert.equal(calls.length, 2, '应重试一次后成功');
  });

  it('retries on 500 with exponential backoff', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 500, body: '{"error":"server error"}' },
      { status: 500, body: '{"error":"server error"}' },
      { status: 200, body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result, 'ok');
    assert.equal(calls.length, 3, '应重试两次后成功');
  });

  it('does not retry on 400 (non-retryable)', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 400, body: '{"error":"bad request"}' },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'hi' }]),
      /HTTP 400/,
    );
    assert.equal(calls.length, 1, '400 不应重试');
  });

  it('gives up after MAX_RETRIES (3 attempts)', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, body: '{"error":"rate"}', headers: { 'retry-after': '0' } },
      { status: 429, body: '{"error":"rate"}', headers: { 'retry-after': '0' } },
      { status: 429, body: '{"error":"rate"}', headers: { 'retry-after': '0' } },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'hi' }]),
      /HTTP 429/,
    );
    assert.equal(calls.length, 3, '最多重试 3 次');
  });

  it('respects Retry-After header', async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, body: '{"error":"rate"}', headers: { 'retry-after': '0' } },
      { status: 200, body: '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}' },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result, 'ok');
    assert.equal(calls.length, 2);
  });
});

// ---------- reasoning_content ----------

describe('AiProvider reasoning_content', () => {
  it('chat: captures reasoning_content via onReasoning callback', async () => {
    let reasoning = '';
    const { fetchFn } = mockFetch([
      {
        body: JSON.stringify({
          choices: [{
            message: { content: '答案是42', reasoning_content: '让我思考一下...' },
            finish_reason: 'stop',
          }],
        }),
      },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    const result = await provider.chat(
      [{ role: 'user', content: '问题' }],
      { onReasoning: (chunk) => { reasoning += chunk; } },
    );
    assert.equal(result, '答案是42');
    assert.equal(reasoning, '让我思考一下...');
  });

  it('chatStream: yields reasoning via onReasoning, content via delta', async () => {
    let reasoning = '';
    let content = '';
    // 构造 SSE 流：先 reasoning_content delta，再 content delta，再 [DONE]
    const sseBody = [
      'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"是42"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchFn = async (): Promise<Response> => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    const provider = new AiProvider(CFG, fetchFn);
    for await (const delta of provider.chatStream(
      [{ role: 'user', content: '问题' }],
      { onReasoning: (chunk) => { reasoning += chunk; } },
    )) {
      content += delta;
    }
    assert.equal(content, '答案是42');
    assert.equal(reasoning, '思考中');
  });
});

// ---------- usage ----------

describe('AiProvider usage', () => {
  it('chat: captures usage via onUsage callback', async () => {
    let usage: TokenUsage | undefined;
    const { fetchFn } = mockFetch([
      {
        body: JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      },
    ]);
    const provider = new AiProvider(CFG, fetchFn);
    await provider.chat(
      [{ role: 'user', content: 'hi' }],
      { onUsage: (u) => { usage = u; } },
    );
    assert.deepEqual(usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  });

  it('chatStream: captures usage from SSE usage frame', async () => {
    let usage: TokenUsage | undefined;
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":30,"total_tokens":230}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchFn = async (): Promise<Response> => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    const provider = new AiProvider(CFG, fetchFn);
    for await (const delta of provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      { onUsage: (u) => { usage = u; } },
    )) {
      void delta;
    }
    assert.deepEqual(usage, { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 });
  });
});

// ---------- signal (abort) ----------

describe('AiProvider signal', () => {
  it('chat: respects caller AbortSignal', async () => {
    const ac = new AbortController();
    const fetchFn: typeof fetch = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      // 模拟 fetch 因 signal 中断抛出 AbortError
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // 延迟响应，让调用方有机会 abort
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
    };
    const provider = new AiProvider(CFG, fetchFn);
    // 立即中断
    ac.abort();
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal }),
    );
  });
});

// ---------- 流式空闲看门狗（issue 36） ----------

describe('AiProvider chatStream 空闲看门狗', () => {
  /**
   * 构造「先发一段就永不再发」的响应体：模拟上游网关挂住（连接半开）。
   * 旧实现下 reader.read() 永远挂起 → 前端正文输出完却一直停在「停止生成」，且无任何报错。
   */
  function stallingFetch(): typeof fetch {
    return async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n'));
          signal?.addEventListener('abort', () => {
            controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
  }

  it('上游挂住不发数据时按空闲阈值掐断并抛出可读错误', async () => {
    const provider = new AiProvider(CFG, stallingFetch());
    const received: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }], { stallTimeoutMs: 80 })) {
          received.push(delta);
        }
      })(),
      /未收到任何数据/,
    );
    // 掐断前收到的内容仍要交付（不能吞字）
    assert.deepEqual(received, ['前半段']);
  });

  it('数据持续到达时看门狗不会误杀（间隔小于阈值）', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"c"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchFn: typeof fetch = async (): Promise<Response> =>
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const provider = new AiProvider(CFG, fetchFn);
    let content = '';
    for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }], { stallTimeoutMs: 80 })) {
      content += delta;
    }
    assert.equal(content, 'abc');
  });

  it('流结束（[DONE]）后不再残留看门狗定时器', async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'].join('');
    const fetchFn: typeof fetch = async (): Promise<Response> =>
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const provider = new AiProvider(CFG, fetchFn);
    let content = '';
    for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }], { stallTimeoutMs: 50 })) {
      content += delta;
    }
    assert.equal(content, 'ok');
    // 阈值 50ms 已过：若定时器残留会 abort 掉已结束的流（后续调用会莫名失败）
    await new Promise((resolve) => setTimeout(resolve, 120));
    let again = '';
    for await (const delta of provider.chatStream([{ role: 'user', content: 'hi' }], { stallTimeoutMs: 50 })) {
      again += delta;
    }
    assert.equal(again, 'ok');
  });
});

/**
 * chatWithAssistantStream 的 SSE 分帧回归测试。
 *
 * 背景：SSE 规范允许 `\r\n\r\n`、`\n\n`、甚至 `\r\r` 作为帧分隔符。客户端先把 CRLF 归一化为
 * LF，再按 `\n\n` 切帧。这里钉住三种真实到达形态，其中第三种是真实缺陷的回归用例：
 *
 * 若归一化只作用于「本次新到达的文本」（`buffer += decode(value).replace(/\r\n/g,'\n')`），
 * 当 `\r\n` 正好被切在两个 chunk 之间时，缓冲区里会留下一个**跨块的 CRLF**：
 * `indexOf('\n\n')` 找不到帧边界，相邻两帧被粘成一块，`JSON.parse` 必然 SyntaxError
 * 并被当作「半截 JSON」静默丢弃 —— 表现为流式回复整段少字（且无任何报错）。
 * 归一化必须作用在**拼接后的缓冲区**上，跨块的 CRLF 才归一得掉。
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chatWithAssistantStream } from '../src/api.ts'

const enc = new TextEncoder()

/** 把 SSE 响应体按给定的 chunk 边界喂给客户端（数组每个元素是一个 chunk） */
function stubStreamFetch(chunks: string[]): void {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  globalThis.fetch = (async () =>
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
}

async function collectDeltas(chunks: string[]): Promise<string[]> {
  stubStreamFetch(chunks)
  const deltas: string[] = []
  await chatWithAssistantStream({ messages: [] }, (d) => deltas.push(d))
  return deltas
}

describe('chatWithAssistantStream: SSE 分帧', () => {
  const origFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('LF 分帧（服务端默认写法）逐帧回调，不丢内容', async () => {
    const deltas = await collectDeltas([
      'data: {"delta":"a"}\n\n',
      'data: {"delta":"b"}\n\n',
      'data: [DONE]\n\n',
    ])
    assert.deepEqual(deltas, ['a', 'b'])
  })

  it('CRLF 分帧、且每个 chunk 恰好一帧：逐帧回调', async () => {
    const deltas = await collectDeltas([
      'data: {"delta":"a"}\r\n\r\n',
      'data: {"delta":"b"}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ])
    assert.deepEqual(deltas, ['a', 'b'])
  })

  it('CRLF 的 \\r 与 \\n 被切在两个 chunk 之间：不得把两帧粘成一块后整块丢弃', async () => {
    // chunk1 以帧尾的 \r 结束，chunk2 以该 \r 的 \n 开头 —— TCP/流式解码的真实切法
    const deltas = await collectDeltas([
      'data: {"delta":"a"}\r\n\r',
      '\ndata: {"delta":"b"}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ])
    assert.deepEqual(deltas, ['a', 'b'])
  })

  it('流结束但最后一帧没有空行收尾：残帧里的内容仍要回调', async () => {
    const deltas = await collectDeltas(['data: {"delta":"a"}\n\n', 'data: {"delta":"b"}'])
    assert.deepEqual(deltas, ['a', 'b'])
  })

  it('usage/truncated 等元信息在跨块 CRLF 下同样不丢', async () => {
    stubStreamFetch([
      'data: {"delta":"a"}\r\n\r',
      '\ndata: {"truncated":true,"contextTrimmed":7,"droppedCount":3}\r\n\r\n',
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ])
    const deltas: string[] = []
    const result = await chatWithAssistantStream({ messages: [] }, (d) => deltas.push(d))
    assert.deepEqual(deltas, ['a'])
    assert.equal(result.truncated, true)
    assert.equal(result.contextTrimmed, 7)
    assert.equal(result.droppedCount, 3)
    assert.deepEqual(result.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })
  })
})

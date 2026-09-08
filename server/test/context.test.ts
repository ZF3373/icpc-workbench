import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, trimContext, summarizeContext, SUMMARIZE_THRESHOLD } from '../src/ai/context.ts';
import type { ChatMessage } from '../src/ai/provider.ts';

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ role, content });

describe('estimateTokens', () => {
  it('estimates ~1 token per 2 chars, rounded up', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('a'), 1); // ceil(1/2)
    assert.equal(estimateTokens('ab'), 1); // ceil(2/2)
    assert.equal(estimateTokens('abc'), 2); // ceil(3/2)
    assert.equal(estimateTokens('你好世界'), 2); // ceil(4/2)
  });
});

describe('trimContext', () => {
  it('keeps all messages when within budget', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi there')];
    const result = trimContext(100, messages, 65536, 8000);
    assert.equal(result.trimmed, 0);
    assert.equal(result.messages.length, 2);
  });

  it('trims oldest messages when over budget', () => {
    // 每条消息 10 字符 → ~5 token；system 100 + maxTokens 8000 = 8100
    // budget = 10000 - 8100 = 1900 → 可容纳 1900/5 = 380 条
    // 但我们用更小的 contextWindow 来触发裁剪
    const messages = [
      msg('user', 'a'.repeat(100)),  // 50 tokens
      msg('assistant', 'b'.repeat(100)), // 50 tokens
      msg('user', 'c'.repeat(100)),  // 50 tokens
      msg('assistant', 'd'.repeat(100)), // 50 tokens
      msg('user', 'e'.repeat(100)),  // 50 tokens → 最新，必须保留
    ];
    // contextWindow=300, systemTokens=50, maxTokens=100 → budget=150 → 只能放 3 条(150 tokens)
    const result = trimContext(50, messages, 300, 100);
    assert.ok(result.trimmed >= 1, `应裁剪至少1条，实际裁剪 ${result.trimmed}`);
    assert.equal(result.messages.length, messages.length - result.trimmed);
    // 最新消息（第5条）必须保留
    assert.equal(result.messages[result.messages.length - 1].content, 'e'.repeat(100));
  });

  it('keeps only last message when budget is zero or negative', () => {
    const messages = [msg('user', 'old'), msg('user', 'mid'), msg('user', 'latest')];
    // system 5000 + maxTokens 8000 = 13000 > contextWindow 10000 → budget < 0
    const result = trimContext(5000, messages, 10000, 8000);
    assert.equal(result.trimmed, 2);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.content, 'latest');
  });

  it('does not trim when only one message exists even if budget is negative', () => {
    const messages = [msg('user', 'only one')];
    const result = trimContext(5000, messages, 10000, 8000);
    assert.equal(result.trimmed, 0);
    assert.equal(result.messages.length, 1);
  });

  it('avoids starting with an assistant message after trimming', () => {
    const messages = [
      msg('user', 'a'.repeat(100)),
      msg('assistant', 'b'.repeat(100)),
      msg('user', 'c'.repeat(100)),
      msg('assistant', 'd'.repeat(100)),
      msg('user', 'e'.repeat(100)),
    ];
    // budget 刚好裁到第 4 条（assistant），应额外丢弃它，从第 5 条（user）开始
    // system 50 + maxTokens 100 → budget = 200 - 50 - 100 = 50
    // 从末尾累计：第5条 50 token（刚好），第4条再 +50 = 100 > 50 → keepFrom=4
    const result = trimContext(50, messages, 200, 100);
    // 第4条是 assistant，应被额外裁掉
    assert.equal(result.messages[0]!.role, 'user', '裁剪后首条不应是 assistant');
  });

  it('returns empty trim for empty messages array', () => {
    const result = trimContext(100, [], 65536, 8000);
    assert.equal(result.trimmed, 0);
    assert.equal(result.messages.length, 0);
  });
});

describe('summarizeContext', () => {
  it('SUMMARIZE_THRESHOLD is 6', () => {
    assert.equal(SUMMARIZE_THRESHOLD, 6);
  });

  it('returns null for empty messages', async () => {
    const provider = { enabled: true, chat: async () => 'summary' };
    const result = await summarizeContext(provider, []);
    assert.equal(result, null);
  });

  it('returns null when provider is disabled', async () => {
    const provider = { enabled: false, chat: async () => 'summary' };
    const msgs = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = await summarizeContext(provider, msgs);
    assert.equal(result, null);
  });

  it('calls provider.chat and returns trimmed summary', async () => {
    const msgs = [
      msg('user', '我的弱项是图论'),
      msg('assistant', '建议多做最短路径练习'),
      msg('user', '目标 1800 分'),
    ];
    const provider = {
      enabled: true,
      chat: async (messages: ChatMessage[]) => {
        // 验证传入的消息结构
        assert.equal(messages[0]?.role, 'system');
        assert.equal(messages[1]?.role, 'user');
        return '  用户弱项图论，目标1800分。  ';
      },
    };
    const result = await summarizeContext(provider, msgs);
    assert.equal(result, '用户弱项图论，目标1800分。');
  });

  it('returns null when provider.chat throws (degrade gracefully)', async () => {
    const msgs = [msg('user', 'hello')];
    const provider = {
      enabled: true,
      chat: async () => { throw new Error('API error'); },
    };
    const result = await summarizeContext(provider, msgs);
    assert.equal(result, null);
  });

  it('returns null for empty summary string', async () => {
    const msgs = [msg('user', 'hello')];
    const provider = {
      enabled: true,
      chat: async () => '   ',
    };
    const result = await summarizeContext(provider, msgs);
    assert.equal(result, null);
  });
});

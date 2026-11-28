/**
 * 「本地 Codex」提供商适配层单测（issue 67）。
 *
 * 不依赖真实 codex CLI：deps.spawnFn 注入一个用 node -e 起的假 codex，
 * 按 FAKE_CODEX_MODE 输出不同形态的 JSONL 事件流（正常 / 未登录 / 挂死 / 无事件退出 /
 * 带 reasoning 等），覆盖 prompt 组装、事件解析、错误映射、Windows shell 回退与中断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AiProvider } from '../src/ai/provider.ts';
import {
  CODEX_INSTALL_HINT,
  codexChat,
  codexChatStream,
  codexProviderTest,
  type CodexDeps,
  type CodexSpawnFn,
} from '../src/ai/codexProvider.ts';
import type { AiConfig } from '../src/config.ts';

/** 假 codex 脚本：等 stdin 结束后按模式输出事件（模拟 codex exec --json 的 stdout JSONL） */
const FAKE_CODEX_SCRIPT = `
const mode = process.env.FAKE_CODEX_MODE;
// 子命令探测（--version / login status）：不等 stdin，立即按模式退出
if (mode === 'exit-immediately') process.exit(0);
if (mode === 'login-ok') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (mode === 'login-missing') { process.stdout.write('Not logged in\\n'); process.exit(1); }
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'exit-no-events') { process.stderr.write('boom happened\\n'); process.exit(3); }
  if (mode === 'fail') {
    emit({ type: 'turn.failed', error: { message: 'Not logged in: please run codex login' } });
    process.exit(1);
  }
  emit({ type: 'thread.started', thread_id: 't1' });
  if (mode === 'reasoning') emit({ type: 'item.completed', item: { id: 'r0', type: 'reasoning', text: 'thinking...' } });
  const text = mode === 'echo-prompt' ? 'PROMPT<' + stdin + '>' : 'pong';
  emit({ type: 'item.completed', item: { id: 'a0', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } });
  process.exit(0);
});
`;

/** 生成注入用 spawnFn：忽略命令名，用 node -e 起假 codex（mode 经环境变量传递） */
function fakeCodex(mode: string, mutateArgs?: (args: string[]) => void): CodexSpawnFn {
  return (cmd, args, opts) => {
    assert.equal(cmd, 'codex', '适配器必须以 codex 命令启动');
    mutateArgs?.([...(args ?? [])]);
    return realSpawn(process.execPath, ['-e', FAKE_CODEX_SCRIPT], {
      ...opts,
      env: { ...(opts?.env ?? process.env), FAKE_CODEX_MODE: mode },
    });
  };
}

/** 永远 ENOENT 的假子进程（模拟本机没有 codex 命令） */
function enoentChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  queueMicrotask(() => {
    child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  });
  return child;
}

const codexCfg = (model = ''): AiConfig => ({ enabled: true, baseURL: '', apiKey: '', model, protocol: 'codex' });

test('codexChat 返回正文并映射 usage 为 OpenAI 兼容口径', async () => {
  const usage: unknown[] = [];
  const text = await codexChat(codexCfg(), [
    { role: 'system', content: 's' },
    { role: 'user', content: 'ping' },
  ], { onUsage: (u) => usage.push(u) }, { spawnFn: fakeCodex('ok') });
  assert.equal(text, 'pong');
  assert.deepEqual(usage, [{
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 4 },
  }]);
});

test('prompt 组装：系统指令 / 对话历史 / 当前问题 三段式，经 stdin 传给 codex', async () => {
  const captured: string[][] = [];
  const text = await codexChat(codexCfg(), [
    { role: 'system', content: 'SYS-CONTENT' },
    { role: 'user', content: 'FIRST-QUESTION' },
    { role: 'assistant', content: 'ASSISTANT-REPLY' },
    { role: 'user', content: 'SECOND-QUESTION' },
  ], {}, { spawnFn: fakeCodex('echo-prompt', (args) => captured.push(args)) });
  assert.match(text, /===== 系统指令 =====/);
  assert.match(text, /SYS-CONTENT/);
  assert.match(text, /===== 对话历史 =====/);
  assert.match(text, /【用户】\nFIRST-QUESTION/);
  assert.match(text, /【助手】\nASSISTANT-REPLY/);
  assert.match(text, /===== 当前问题 =====\n【用户】\nSECOND-QUESTION/);
  // 当前问题不重复出现在历史里
  const history = text.slice(text.indexOf('===== 对话历史'), text.indexOf('===== 当前问题'));
  assert.doesNotMatch(history, /SECOND-QUESTION/);
  // prompt 走 stdin，不进命令行参数
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.every((a) => !a.includes('SECOND-QUESTION')), true);
});

test('模型名白名单：shell 回退场景下不允许带元字符的值进 -m', async () => {
  await assert.rejects(
    () => codexChat(codexCfg('gpt-x; rm -rf /'), [{ role: 'user', content: 'hi' }], {}, { spawnFn: fakeCodex('ok') }),
    /模型名不合法/,
  );
});

test('turn.failed（未登录）→ 错误携带 codex login 指引', async () => {
  await assert.rejects(
    () => codexChat(codexCfg(), [{ role: 'user', content: 'hi' }], {}, { spawnFn: fakeCodex('fail') }),
    (e: Error) => /codex login/.test(e.message) && /Not logged in/.test(e.message),
  );
});

test('无事件异常退出 → 错误含退出码与 stderr 摘要', async () => {
  await assert.rejects(
    () => codexChat(codexCfg(), [{ role: 'user', content: 'hi' }], {}, { spawnFn: fakeCodex('exit-no-events') }),
    (e: Error) => /Codex CLI 未能完成回复/.test(e.message) && /boom happened/.test(e.message),
  );
});

test('codex 命令不存在（spawn 两段都 ENOENT）→ 安装指引', async () => {
  const deps: CodexDeps = { spawnFn: () => enoentChild() };
  await assert.rejects(
    () => codexChat(codexCfg(), [{ role: 'user', content: 'hi' }], {}, deps),
    (e: Error) => e.message.includes(CODEX_INSTALL_HINT),
  );
});

test('流式：正文走 yield，reasoning 走 onReasoning 回调，不混入正文', async () => {
  const reasoning: string[] = [];
  const deltas: string[] = [];
  for await (const d of codexChatStream(codexCfg(), [{ role: 'user', content: 'hi' }], {
    onReasoning: (c) => reasoning.push(c),
  }, { spawnFn: fakeCodex('reasoning') })) {
    deltas.push(d);
  }
  assert.deepEqual(deltas, ['pong']);
  assert.deepEqual(reasoning, ['thinking...']);
});

test('调用方中断：abort 掐断子进程并抛 AbortError', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => codexChat(codexCfg(), [{ role: 'user', content: 'hi' }], { signal: controller.signal }, { spawnFn: fakeCodex('hang') }),
    (e: Error) => e.name === 'AbortError',
  );
});

// Windows 专属路径：npm 全局安装的 codex 是 codex.cmd shim，直接 spawn ENOENT，
// 必须回退 shell:true 包装（cmd.exe 按 PATHEXT 解析）。
(process.platform === 'win32' ? test : test.skip)('Windows npm-shim 回退：首次 ENOENT 后经 shell 重试成功', async () => {
  let calls = 0;
  const deps: CodexDeps = {
    spawnFn: (cmd, args, opts) => {
      calls += 1;
      if (calls === 1) return enoentChild();
      assert.equal((opts as SpawnOptions | undefined)?.shell, true, '回退 spawn 必须带 shell:true');
      assert.equal(cmd.includes('codex'), true);
      // 桩进程（node -e 多行脚本）必须脱离 shell 直跑：脚本里的换行经 cmd.exe 会被截断
      return realSpawn(process.execPath, ['-e', FAKE_CODEX_SCRIPT], {
        ...opts,
        shell: false,
        env: { ...(opts?.env ?? process.env), FAKE_CODEX_MODE: 'ok' },
      });
    },
  };
  const text = await codexChat(codexCfg(), [{ role: 'user', content: 'hi' }], {}, deps);
  assert.equal(text, 'pong');
  assert.equal(calls, 2);
});

// 回归（2026-11-28 实机故障）：prompt 先 end 进死掉的第一个子进程，回退子进程若拿不到
// 重写的 prompt，codex 读到空 stdin，「未登录」等真实错误全部退化成含糊的「进程提前退出」。
// 同时死子的 stdout end/close 会立即关闭流——事件屏蔽缺失时本用例直接超时/报错。
(process.platform === 'win32' ? test : test.skip)('Windows 回退：重写 prompt 到回退子进程并屏蔽死子进程事件', async () => {
  let calls = 0;
  const deps: CodexDeps = {
    spawnFn: (cmd, args, opts) => {
      calls += 1;
      if (calls === 1) return enoentChild();
      return realSpawn(process.execPath, ['-e', FAKE_CODEX_SCRIPT], {
        ...opts,
        shell: false,
        env: { ...(opts?.env ?? process.env), FAKE_CODEX_MODE: 'echo-prompt' },
      });
    },
  };
  const text = await codexChat(codexCfg(), [{ role: 'user', content: 'PROMPT-MARKER' }], {}, deps);
  // 回退子进程收到的 stdin 里带完整 prompt（echo-prompt 模式会把它嵌进回复）
  assert.match(text, /PROMPT-MARKER/);
  assert.equal(calls, 2);
});

test('AiProvider 按 protocol 分派：enabled 不再要求 apiKey，chat/chatStream 走 codex，uploadFile 明确拒绝', async () => {
  const provider = new AiProvider(codexCfg(), fetch, { spawnFn: fakeCodex('ok') });
  assert.equal(provider.enabled, true);
  assert.equal(await provider.chat([{ role: 'user', content: 'hi' }]), 'pong');
  const deltas: string[] = [];
  for await (const d of provider.chatStream([{ role: 'user', content: 'hi' }])) deltas.push(d);
  assert.deepEqual(deltas, ['pong']);
  await assert.rejects(
    () => provider.uploadFile({ filename: 'a.txt', data: new Uint8Array([1]) }),
    /不支持文件上传/,
  );
});

test('codexProviderTest：version → login status → 最小 exec 全链路', async () => {
  const deps: CodexDeps = {
    spawnFn: (cmd, args, opts) => {
      const a = args ?? [];
      const mode = a[0] === 'login' ? 'login-ok' : a[0] === '--version' ? 'exit-immediately' : 'ok';
      return realSpawn(process.execPath, ['-e', FAKE_CODEX_SCRIPT], {
        ...opts,
        env: { ...(opts?.env ?? process.env), FAKE_CODEX_MODE: mode },
      });
    },
  };
  const r = await codexProviderTest(deps);
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /连接成功/);
});

test('codexProviderTest：未登录时给出可操作指引', async () => {
  const deps: CodexDeps = {
    spawnFn: (cmd, args, opts) => {
      const a = args ?? [];
      const mode = a[0] === 'login' ? 'login-missing' : 'exit-immediately';
      return realSpawn(process.execPath, ['-e', FAKE_CODEX_SCRIPT], {
        ...opts,
        env: { ...(opts?.env ?? process.env), FAKE_CODEX_MODE: mode },
      });
    },
  };
  const r = await codexProviderTest(deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /codex login/);
});

test('codexProviderTest：未安装 codex → 安装指引（不尝试对话）', async () => {
  const r = await codexProviderTest({ spawnFn: () => enoentChild() });
  assert.equal(r.ok, false);
  assert.match(r.message, /未找到 codex CLI/);
});

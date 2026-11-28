/**
 * 「ChatGPT 登录」提供商适配层（issue 67 原始诉求：Sign in with ChatGPT）。
 *
 * 用 OAuth 拿到的 access_token（ChatgptCredential，见 chatgptAuth.ts）直连官方
 * Responses API（POST https://api.openai.com/v1/responses），推理计入用户的
 * ChatGPT 订阅额度。ChatMessage / ChatOptions 抽象与 chat/completions 完全一致，
 * AiProvider 按 protocol='chatgpt' 分派到本模块——路由与调用点零改动。
 *
 * ChatGPT plan 预览期硬约束（官方 preview-limitations + 开源实现交叉验证）：
 * - 必须 `store:false` + `stream:true` + `input` 数组（非流式 chat() 由本模块
 *   内部流式聚合并最终一次性返回，调用方无感知）；
 * - 禁止 temperature / top_p / max_output_tokens / metadata / previous_response_id /
 *   background / truncation 等字段——因此 ChatOptions 里的 temperature/maxTokens
 *   在本路径**静默不生效**（跟随模型默认），截断续写靠 prompt 收尾轮兜底；
 * - system 走顶层 `instructions`（对话中段的 system 角色映射为 `developer`）；
 * - 无 Files 上传/文件搜索/hosted MCP：file 内容块占位说明，图片以
 *   input_image（data URL / http URL）随 input 发送；
 * - 工具（function/custom）必须包进带描述的 `namespace` 工具；返回的
 *   function_call 输出项映射回 OpenAI tool_calls 语义（经 onFinish 回传），路由层
 *   的工具往返循环无需改动；tool 消息映射为 function_call_output 输入项；
 * - 订阅额度用尽是**流内失败**（response.failed，code
 *   subscription_sharing_usage_limit_exceeded），这里转成可读的中文提示。
 */

import type { AiConfig } from '../config.ts';
import { ensureFreshChatgptCredential } from './chatgptAuth.ts';
import { STREAM_STALL_TIMEOUT_MS, describeError } from './provider.ts';
import type { ChatMessage, ChatOptions, TokenUsage, ToolCall, ToolDefinition } from './provider.ts';

const CHATGPT_USAGE_URL = 'https://chatgpt.com/usage';
/** 工具命名空间名（Responses API 预览期要求 function/custom 工具收进带描述的 namespace） */
const TOOL_NAMESPACE_NAME = 'icpc-workbench';

export interface ChatgptDeps {
  fetchFn?: typeof fetch;
}

/** Responses API 事件的最小类型面（只声明适配器消费的字段） */
interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
  code?: string;
  message?: string;
}

/** baseURL → /responses 端点：容忍用户粘贴 chat/completions 等结尾地址（同 chatUrl 惯例） */
export function responsesUrl(base: string): string {
  let trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) trimmed = trimmed.slice(0, -'/chat/completions'.length);
  else if (trimmed.endsWith('/models')) trimmed = trimmed.slice(0, -'/models'.length);
  else if (trimmed.endsWith('/responses')) return trimmed;
  return `${trimmed}/responses`;
}

// ---------- 消息 → Responses API input ----------

type InputItem = Record<string, unknown>;

const FILE_PLACEHOLDER = (fileId: string): string =>
  `[附件 ${fileId} 未随本请求发送：ChatGPT 登录模式（预览期）不支持 Files API 上传的文件]`;

function contentPartsToInput(m: ChatMessage): { text: string; parts: Array<Record<string, unknown>> } {
  const parts: Array<Record<string, unknown>> = [];
  const textChunks: string[] = [];
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content } as const] : m.content;
  for (const b of blocks) {
    if (b.type === 'text') {
      textChunks.push(b.text);
      if (b.text.trim() !== '') parts.push({ type: 'input_text', text: b.text });
    } else if (b.type === 'image_url') {
      // Responses API 支持 data URL 与 http(s) URL
      parts.push({ type: 'input_image', image_url: b.image_url.url });
    } else {
      const note = FILE_PLACEHOLDER(b.file_id);
      textChunks.push(note);
      parts.push({ type: 'input_text', text: note });
    }
  }
  return { text: textChunks.join('\n').trim(), parts };
}

function buildResponsesInput(messages: ChatMessage[]): { input: InputItem[]; instructions: string } {
  const input: InputItem[] = [];
  const systemParts: string[] = [];
  let seenNonSystem = false;
  for (const m of messages) {
    if (m.role === 'system') {
      const text = (typeof m.content === 'string'
        ? m.content
        : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')).trim();
      if (!text) continue;
      // 顶层 instructions 收首条系统指令（工作台各入口都是 system 开头）；
      // 中段 system（罕见）映射为 developer 角色
      if (!seenNonSystem) {
        systemParts.push(text);
        continue;
      }
      input.push({ role: 'developer', content: [{ type: 'input_text', text }] });
      continue;
    }
    seenNonSystem = true;
    if (m.role === 'tool') {
      // 工具结果 → function_call_output（call_id 与 assistant 的 function_call 对齐）
      const output = typeof m.content === 'string'
        ? m.content
        : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: output || '（工具无输出）',
      });
      continue;
    }
    const { text, parts } = contentPartsToInput(m);
    if (m.role === 'assistant') {
      // 带工具调用的 assistant：文本成 output_text 项，tool_calls 成 function_call 项
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        });
      }
      continue;
    }
    // user：内容部件（文本/图片）；纯空内容时保底一条占位文本
    input.push({
      role: 'user',
      content: parts.length > 0 ? parts : [{ type: 'input_text', text: text || '（无内容）' }],
    });
  }
  return { input, instructions: systemParts.join('\n\n') };
}

/** chat/completions 工具定义 → Responses API namespace 工具（预览期强制收进 namespace） */
function buildResponsesTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  const namespaceTools = tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
  return [
    {
      type: 'namespace',
      name: TOOL_NAMESPACE_NAME,
      description: 'Tools for ICPC Workbench tasks.',
      tools: namespaceTools,
    },
  ];
}

/** usage → OpenAI 兼容 TokenUsage（前端状态栏同一口径） */
function mapResponsesUsage(u: NonNullable<ResponsesEvent['response']>['usage']): TokenUsage {
  const input = Number(u?.input_tokens ?? 0);
  const output = Number(u?.output_tokens ?? 0);
  const cached = Number(u?.input_tokens_details?.cached_tokens ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/** ChatGPT 侧错误 → 可读文案（订阅额度用尽给出用量页指引） */
function friendlyChatgptError(code: string, message: string): Error {
  if (code.includes('subscription_sharing_usage_limit_exceeded')) {
    return new Error(`ChatGPT 套餐额度已用尽（与其他应用共享订阅额度），用量明细见 ${CHATGPT_USAGE_URL}`);
  }
  if (code.includes('workplace_individual_usage_limit')) {
    return new Error(`ChatGPT 工作区个人额度已用尽（管理员设置了每用户上限），用量明细见 ${CHATGPT_USAGE_URL}`);
  }
  if (/not logged in|unauthorized|401/i.test(message) || code === 'invalid_token') {
    return new Error(`ChatGPT 登录已失效：${message}（请到设置 → AI 配置重新登录）`);
  }
  return new Error(`ChatGPT 返回错误：${message || code || '未知错误'}`);
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/** 组装请求体（store:false + stream:true + 无预览期禁用字段） */
function buildResponsesPayload(cfg: AiConfig, messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
  const { input, instructions } = buildResponsesInput(messages);
  const payload: Record<string, unknown> = {
    model: cfg.model,
    input,
    store: false,
    stream: true,
  };
  if (instructions) payload.instructions = instructions;
  if (opts.tools && opts.tools.length > 0) {
    payload.tools = buildResponsesTools(opts.tools);
  }
  return payload;
}

/**
 * 消费一次 Responses API 流式请求：SSE 事件 → content delta yield。
 * 正常结束 = response.completed；response.failed / error 事件 / 空闲看门狗 /
 * 调用方中断都会抛错（AbortError 原样抛出，与 HTTP 路径语义一致）。
 * 连接阶段超时只约束「发出请求 → 收到响应头」，正文流式读取不受 timeoutMs 约束
 * （仅受调用方中断与空闲看门狗控制）——与 HTTP chat/completions 路径同一设计，
 * 防止长生成被 AbortSignal.timeout 误杀。
 */
async function* chatgptContentStream(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
  deps: ChatgptDeps,
): AsyncGenerator<string, void, void> {
  if (!cfg.chatgpt?.accessToken) {
    throw new Error('ChatGPT 未登录：请到「设置 → AI 配置」完成 ChatGPT 登录');
  }
  if (!cfg.model.trim()) {
    throw new Error('未选择模型：请登录 ChatGPT 后在模型目录中选用套餐内模型');
  }
  // 临期刷新（轮换语义在 chatgptAuth 内串行化并落库）；失效（terminal）抛可读错误
  let cred = await ensureFreshChatgptCredential(cfg.chatgpt);
  const payload = buildResponsesPayload(cfg, messages, opts);

  // 连接超时 + 调用方中断：控制器只在「等响应头」阶段受 timeoutMs 约束，
  // 响应头到达后 clearTimeout，正文读取交给调用方 signal 与空闲看门狗
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutMs = cfg.timeoutMs ?? 120000;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  const armConnect = (): void => {
    if (connectTimer !== null) clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      controller.abort(new DOMException(`ChatGPT 连接超时（${Math.ceil(timeoutMs / 1000)}s 内未收到响应头）`, 'TimeoutError'));
    }, timeoutMs);
  };

  let res: Response | null = null;
  let retried401 = false;
  try {
    armConnect();
    for (;;) {
      try {
        res = await (deps.fetchFn ?? fetch)(responsesUrl(cfg.baseURL), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cred.accessToken}`,
            accept: 'text/event-stream',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (e) {
        if (opts.signal?.aborted) throw abortError();
        throw new Error(describeError(e));
      }
      if (res.ok) {
        // 响应头已到达：连接超时下钟，正文读取只受调用方中断与空闲看门狗控制
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        break;
      }
      await res.text().catch(() => '');
      // 401：access_token 在余量内被撤销等场景 —— 强制刷新一次后单次重试
      if (res.status === 401 && !retried401) {
        retried401 = true;
        cred = await ensureFreshChatgptCredential(cfg.chatgpt, { force: true });
        armConnect();
        continue;
      }
      if (opts.signal?.aborted) throw abortError();
      const text = await res.text().catch(() => '');
      throw new Error(`ChatGPT API HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    if (connectTimer !== null) clearTimeout(connectTimer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
  if (!res!.body) throw new Error('ChatGPT API 未返回流式响应体');

  const reader = res!.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;
  let completed = false;
  let stallMessage: string | null = null;
  const toolCallAccum: ToolCall[] = [];

  // 空闲看门狗：与 HTTP 流式路径同一阈值口径——「连上了却不再发数据」时掐断
  const stallMs = opts.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStall = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  const armStall = (): void => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallMessage = `ChatGPT 响应中断（${Math.ceil(stallMs / 1000)}s 内没有收到任何数据）`;
      reader.cancel(stallMessage).catch(() => {});
      clearStall();
    }, stallMs);
  };

  /** 解析单个 SSE 帧（data JSON 的 type 字段为准分派；event: 行冗余忽略） */
  function* handleFrame(frame: string): Generator<string, void, void> {
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
    for (const line of dataLines) {
      const payloadText = line.slice(5).trim();
      if (!payloadText || payloadText === '[DONE]') continue;
      let ev: ResponsesEvent;
      try {
        ev = JSON.parse(payloadText) as ResponsesEvent;
      } catch {
        continue; // 单帧解析失败跳过
      }
      switch (ev.type) {
        case 'response.output_text.delta': {
          if (ev.delta) yield ev.delta;
          return;
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (ev.delta) opts.onReasoning?.(ev.delta);
          return;
        }
        case 'response.output_item.done': {
          if (ev.item?.type === 'function_call') {
            toolCallAccum.push({
              id: ev.item.call_id ?? ev.item.id ?? '',
              type: 'function',
              function: { name: ev.item.name ?? '', arguments: ev.item.arguments ?? '{}' },
            });
          }
          return;
        }
        case 'response.completed': {
          if (ev.response?.usage) opts.onUsage?.(mapResponsesUsage(ev.response.usage));
          finishReason = toolCallAccum.length > 0 ? 'tool_calls' : 'stop';
          completed = true;
          return;
        }
        case 'response.incomplete': {
          const reason = ev.response?.incomplete_details?.reason ?? 'unknown';
          throw new Error(`ChatGPT 响应被截断（${reason}）：请缩短问题后重试`);
        }
        case 'response.failed': {
          const err = ev.response?.error ?? {};
          throw friendlyChatgptError(String(err.code ?? ''), String(err.message ?? ''));
        }
        case 'error': {
          throw friendlyChatgptError(String(ev.code ?? ''), String(ev.message ?? ''));
        }
        default:
          return; // response.created / output_item.added / content_part.* 等无需处理
      }
    }
  }

  try {
    armStall();
    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } finally {
        clearStall();
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        armStall();
        yield* handleFrame(frame);
        // completed 后必须落到函数末尾的 onFinish 回传（工具往返循环依赖它），
        // 因此用带标签 break 而不是 return——return 会连 finally 之后的收尾一起跳过
        if (completed) break readLoop;
      }
    }
  } catch (e) {
    try {
      reader.cancel((e as Error).message).catch(() => {});
    } catch {
      // 流已结束
    }
    throw e;
  } finally {
    clearStall();
    try {
      reader.releaseLock();
    } catch {
      // 流已结束
    }
    // 释放底层连接（正常路径流已读完；异常路径尽早断开）
    controller.abort();
  }

  if (opts.signal?.aborted) throw abortError();
  if (stallMessage) throw new Error(stallMessage);
  if (!completed) {
    throw new Error('ChatGPT 响应中断（未收到 response.completed）：请重试');
  }
  opts.onFinish?.(finishReason ?? 'stop', toolCallAccum.length > 0 ? toolCallAccum : undefined);
}

/**
 * 非流式对话（对齐 AiProvider.chat 语义）：预览期强制 stream:true，
 * 这里内部流式聚合并一次性返回；temperature/maxTokens 在本路径不生效（见头注）。
 * onFinish 由内容流在完成时回传（含工具调用），本函数不再补发，避免覆盖。
 */
export async function chatgptChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
  deps: ChatgptDeps = {},
): Promise<string> {
  let content = '';
  for await (const delta of chatgptContentStream(cfg, messages, opts, deps)) {
    content += delta;
  }
  if (content.trim() === '') throw new Error('ChatGPT 未返回任何内容');
  return content;
}

/**
 * 流式对话（对齐 AiProvider.chatStream 语义）：逐 delta yield 正文片段。
 * onFinish 由内容流在完成时回传（含工具调用），本函数不再补发，避免覆盖。
 */
export async function* chatgptChatStream(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
  deps: ChatgptDeps = {},
): AsyncGenerator<string, void, void> {
  for await (const delta of chatgptContentStream(cfg, messages, opts, deps)) {
    yield delta;
  }
}

/**
 * 「本地 Codex」提供商适配层（issue 67）。
 *
 * 选中该提供商后，AI 请求不再走 OpenAI 兼容 chat/completions HTTP，而是调用本机
 * 已安装并通过 `codex login` 登录 ChatGPT 的 Codex CLI（`codex exec --json` 子进程）。
 * 登录态、凭据刷新、模型路由完全由 Codex 自身管理——工作台不存任何凭据，也不解析
 * ChatGPT 的 token，只消费 codex 输出的 JSONL 事件流。
 *
 * 与 HTTP 路径的能力差异（有意为之，见 docs/updates/2026-11-28-issue67-codex.md）：
 * - temperature / max_tokens / tools 参数不透传（codex exec 没有对应的按次覆盖；
 *   温度跟随模型默认，工具由 codex 自带的沙箱与 MCP 配置决定）；
 * - Files API 附件（file 内容块）无法发送，图片（data URL）转临时文件随 -i 附上；
 * - 流式输出粒度受 codex 限制：agent_message 事件可能在整段生成完毕后才到达
 *   （本适配器同时兼容逐段 item.updated 的流式形态，有 delta 就实时转发）。
 *
 * 事件流口径（codex-cli 0.164 实测）：stdout 为 JSONL，顶层事件 type ∈
 * thread.started / turn.started / item.started / item.updated / item.completed /
 * turn.completed / turn.failed / error；item.type ∈ agent_message / reasoning /
 * command_execution / ... / error。致命失败 = turn.failed；顶层 error 是
 * 「Reconnecting...」之类的瞬态通知，不算失败（但最终失败时会拼进错误上下文，
 * 因为上游网关的 403/限流文案只出现在这里）。
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiConfig } from '../config.ts';
import { resolveProxyUrl } from './proxyFetch.ts';
import { STREAM_STALL_TIMEOUT_MS } from './provider.ts';
import type { ChatMessage, ChatOptions, TokenUsage } from './provider.ts';

/**
 * 测试可注入的 spawn。不用 `typeof spawn`（其重载族要求返回 WithoutNullStreams 等具体
 * 形态，测试桩的窄化实现会被判不可赋值）；这里只约定适配层实际用到的调用形态。
 */
export type CodexSpawnFn = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface CodexDeps {
  spawnFn?: CodexSpawnFn;
  /** OpenAI 系网络代理（显式值；缺省回退 HTTPS_PROXY 环境变量）——以 HTTPS_PROXY/HTTP_PROXY 注入 codex 子进程环境 */
  proxyUrl?: string;
}

// 测试注入点：settings 路由的「测试连接」探测用（进程内全局，与 setRequestIntervalScale 同款模式）
let codexTestDeps: CodexDeps = {};
/** 仅测试使用：注入假的 codex spawn 行为；传 null 恢复真实 codex CLI */
export function setCodexTestDeps(deps: CodexDeps | null): void {
  codexTestDeps = deps ?? {};
}

// ---------- 错误文案 ----------

export const CODEX_INSTALL_HINT =
  '未找到 codex CLI：请先安装 Codex CLI（npm install -g @openai/codex，或官方安装脚本），安装后重开终端确认 codex 命令可用';
export const CODEX_LOGIN_HINT = '请先在终端运行 codex login 完成 ChatGPT 登录，再在工作台使用本地 Codex';

/** codex 错误信息友好化：未登录/凭据失效给出可操作指引 */
function friendlyCodexError(raw: unknown): Error {
  const msg = String((raw as Error | undefined)?.message ?? raw ?? '').trim();
  if (/not logged in|需要登录|请先.*登录|unauthorized|invalid[ _-]?api[ _-]?key|401/i.test(msg)) {
    return new Error(`Codex CLI 未登录或凭据失效：${msg}（${CODEX_LOGIN_HINT}）`);
  }
  return new Error(`Codex CLI 返回错误：${msg || '未知错误'}`);
}

// ---------- codex exec 参数 ----------

/**
 * 模型名白名单校验：模型名只进 -m 参数，但 Windows 上 npm 安装的 codex 需要 cmd.exe
 * 包装启动（见 spawnCodexForTurn），shell 拼接下未净化的值就是命令注入面。codex 官方模型 ID
 * 全部落在字母/数字/点/横线/斜杠内，超出即拒绝。
 */
function sanitizeCodexModel(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120 || !/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    throw new Error(`模型名不合法：${trimmed.slice(0, 40)}（只允许字母、数字、点、横线、斜杠）`);
  }
  return trimmed;
}

/** 组装 codex exec 参数：flag 集合保持最小（--ephemeral 避免每次对话都写会话文件） */
function buildExecArgs(cfg: AiConfig, imagePaths: string[], workDir: string): string[] {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', workDir];
  const model = sanitizeCodexModel(cfg.model);
  if (model) args.push('-m', model);
  for (const img of imagePaths) args.push('-i', img);
  return args;
}

// ---------- 子进程启动（Windows npm-shim 回退） ----------

/**
 * codex 子进程的同步事件缓冲。
 *
 * 为什么不用「先确认启动、再挂监听」：子进程可能在确认窗口内就快速退出（未登录的
 * codex exec、测试桩），stdout 的 end/close 事件会先于监听挂载触发，之后主循环
 * 永远等不到通知。这里改为 spawn 返回后**同步**挂全部监听并把事件缓冲进本对象，
 * 消费方启动时从缓冲读取——不存在丢事件/竞态窗口。
 */
export interface CodexTurnSpawn {
  /** 当前生效的子进程（Windows shell 回退后会被替换成第二个） */
  child: ChildProcess;
  /** stdout 已按行切好的完整行（消费方 shift 取用） */
  lines: string[];
  /** 未凑满一行的尾部碎片 */
  partial: string;
  /** stderr 尾部（诊断用） */
  stderrTail: string;
  exitCode: number | null;
  exitSignal: string | null;
  /** 进程已真正退出（exit 事件；stdout end/close 可能先于它到达） */
  exited: boolean;
  /** 进程退出时 resolve（spawn 层致命错误则永远不 resolve，走 closeErr 路径） */
  exitDone: Promise<void>;
  /** stdout 已终止（end/close/exit/致命 spawn 错误） */
  closed: boolean;
  /** 终止原因（spawn 层错误）；null = 正常走完 stdout */
  closeErr: Error | null;
  /** 数据/终止到达时唤醒主循环的回调（由主循环注册） */
  notify: (() => void) | null;
  /** 流终止时 resolve（跨 shell 回退换子进程依然有效，供简单消费方 await） */
  done: Promise<void>;
  /** 终止流（幂等）：err 非空时记为 closeErr */
  markClosed(err: Error | null): void;
}

/**
 * 启动 codex 子进程并写入 instructions（prompt）。
 *
 * Windows 兼容：npm 全局安装的 codex 只有 codex.cmd shim（libuv 的 PATH 搜索只认
 * .exe），直接 spawn 报 ENOENT —— 首个 'error' 事件触发时回退 `shell: true` 包装
 * （cmd.exe 按 PATHEXT 能解析 codex.cmd）。回退有两个必须跟上的动作：
 * 1. prompt 已经 end 进死掉的第一个子进程 —— 必须给回退子进程**重写**一份；
 * 2. 第一个子进程的 stdout end/close 会立即把流标成「已终止」—— 所有事件回调都按
 *    `stream.child !== child` 屏蔽已废弃子进程，否则主循环会在回退子进程产出任何
 *    内容之前就以「进程提前退出」收场。
 */
/**
 * 代理 → codex 子进程环境：Codex CLI（reqwest 实现）读标准 HTTPS_PROXY/HTTP_PROXY。
 * 注入为「父环境 + 代理覆盖」而不是裸环境，避免把 PATH 等丢掉；无代理（含环境变量
 * 回退也没有）返回 undefined = 不覆盖 env，完全继承父进程（测试桩不受影响）。
 */
function codexProxyEnv(proxyUrl?: string): NodeJS.ProcessEnv | undefined {
  const resolved = resolveProxyUrl(proxyUrl);
  if (!resolved) return undefined;
  return {
    ...process.env,
    HTTPS_PROXY: resolved,
    https_proxy: resolved,
    HTTP_PROXY: resolved,
    http_proxy: resolved,
  };
}

async function spawnCodexForTurn(args: string[], prompt: string, deps: CodexDeps): Promise<CodexTurnSpawn> {
  const spawnFn = deps.spawnFn ?? spawn;
  const proxyEnv = codexProxyEnv(deps.proxyUrl);
  const baseOpts: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(proxyEnv ? { env: proxyEnv } : {}),
  };
  let doneResolve: (() => void) | null = null;
  let exitDoneResolve: (() => void) | null = null;
  const stream: CodexTurnSpawn = {
    child: null as unknown as ChildProcess, // 下方立即赋值
    lines: [],
    partial: '',
    stderrTail: '',
    exitCode: null,
    exitSignal: null,
    exited: false,
    exitDone: new Promise<void>((resolve) => {
      exitDoneResolve = resolve;
    }),
    closed: false,
    closeErr: null,
    notify: null,
    done: new Promise<void>((resolve) => {
      doneResolve = resolve;
    }),
    markClosed(err) {
      if (err && stream.closeErr === null) stream.closeErr = err;
      if (stream.closed) return;
      stream.closed = true;
      stream.notify?.();
      doneResolve?.();
    },
  };
  const writeStdin = (child: ChildProcess): void => {
    // codex 提前退出（未登录等）时 stdin 写入会 EPIPE，吞掉写错误由退出码路径统一报错
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  };
  let retried = false;
  const attach = (child: ChildProcess): void => {
    // 已被 shell 回退废弃的子进程：其事件一律忽略（死子的 stdout end/close 若不屏蔽，
    // 会在回退子进程产出任何内容之前就把整个流标成「已终止」）
    const superseded = (): boolean => stream.child !== child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (superseded()) return;
      stream.partial += chunk;
      let idx: number;
      while ((idx = stream.partial.indexOf('\n')) !== -1) {
        stream.lines.push(stream.partial.slice(0, idx));
        stream.partial = stream.partial.slice(idx + 1);
      }
      stream.notify?.();
    });
    child.stdout?.on('end', () => {
      if (!superseded()) stream.markClosed(null);
    });
    child.stdout?.on('close', () => {
      if (!superseded()) stream.markClosed(null);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (superseded()) return;
      stream.stderrTail = (stream.stderrTail + chunk).slice(-2000);
    });
    child.on('exit', (code, signal) => {
      if (superseded()) return;
      stream.exitCode = code;
      stream.exitSignal = signal;
      stream.exited = true;
      exitDoneResolve?.();
      stream.markClosed(null); // 进程退出 = stdout 不会再有数据（有的话已先 end）
    });
    // spawn 失败必须有人监听（无人监听的 'error' 事件会直接抛出打崩进程）
    child.on('error', (e) => {
      if (superseded()) return;
      handleFatal(e);
    });
  };
  const handleFatal = (e: Error): void => {
    const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT';
    if (!retried && enoent && process.platform === 'win32') {
      retried = true;
      // 参数全部受控（flag 常量 + 白名单模型 + 本应用生成的路径），prompt 走 stdin 不进
      // 命令行，这里逐段加引号仅防路径空格
      const cmdLine = ['codex', ...args.map((a) => `"${a.replace(/"/g, '')}"`)].join(' ');
      const second = spawnFn(cmdLine, [], { ...baseOpts, shell: true });
      stream.child = second;
      attach(second);
      writeStdin(second); // prompt 已随死掉的第一个子进程 end，必须重写
      return;
    }
    stream.markClosed(enoent ? new Error(CODEX_INSTALL_HINT) : e);
  };
  const child = spawnFn('codex', args, baseOpts);
  stream.child = child;
  attach(child);
  writeStdin(child);
  return stream;
}

/** 终止 codex 子进程（Windows 下连孙子进程一起砍——codex 可能派生 shell 命令） */
function killCodexTree(target: ChildProcess | null): void {
  if (!target) return;
  try {
    if (target.exitCode !== null || target.signalCode !== null) return; // 已退出
    if (process.platform === 'win32') {
      if (target.pid) {
        spawn('taskkill', ['/pid', String(target.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .on('error', () => target.kill());
        return;
      }
    }
    target.kill('SIGTERM');
    setTimeout(() => target.kill('SIGKILL'), 2_000).unref();
  } catch {
    // 退出竞态：进程刚好自己结束了，忽略
  }
}

// ---------- 提示词组装 ----------

/**
 * 工作台消息 → 单次 codex exec 的 instructions。
 * codex exec 是单轮非交互调用（无 chat/completions 的 messages 数组），多轮对话
 * 以「系统指令 / 对话历史 / 当前问题」三个分隔块拼成一段说明文本；最后一条 user
 * 消息即当前问题。图片内容块转临时文件随 -i 附上，Files API 文件块无法发送（占位说明）。
 */
export function buildCodexPrompt(
  messages: ChatMessage[],
  imageDir: string,
): { prompt: string; imagePaths: string[] } {
  const imagePaths: string[] = [];
  let imgSeq = 0;

  const renderImage = (url: string): string => {
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i.exec(url.trim());
    if (!m) return '[图片未能随本请求发送：本地 Codex 仅支持本地图片]';
    try {
      const ext = m[1]!.toLowerCase() === 'jpg' ? 'jpg' : m[1]!.toLowerCase();
      const file = path.join(imageDir, `img-${++imgSeq}.${ext}`);
      fs.writeFileSync(file, Buffer.from(m[2]!, 'base64'));
      imagePaths.push(file);
      return `[图片 ${path.basename(file)} 已随本请求附上]`;
    } catch {
      return '[图片未能随本请求发送：写入临时文件失败]';
    }
  };

  const renderContent = (m: ChatMessage): string => {
    if (typeof m.content === 'string') return m.content;
    return m.content
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'image_url') return renderImage(b.image_url.url);
        // Files API file_id 对 codex 无意义（无上传通道），明确占位避免模型编造内容
        return `[附件 ${b.file_id} 未随本请求发送：本地 Codex 不支持 Files API 上传的文件]`;
      })
      .filter((s) => s.trim() !== '')
      .join('\n');
  };

  const roleLabel = (role: ChatMessage['role']): string =>
    role === 'user' ? '用户' : role === 'assistant' ? '助手' : role === 'tool' ? '工具结果' : '系统';

  const preamble = [
    '你现在作为「ICPC 竞赛工作台」应用内置的 AI 助手回答用户。',
    '下面由分隔块给出应用的系统指令与对话历史，最后一节【当前问题】是需要回答的内容。',
    '请直接输出回答正文（遵守系统指令的格式与要求），不要复述本段说明、不要输出分隔块结构。',
    '回答基于消息内容用你自己的知识完成：除非回答确有必要，不要执行本地命令、不要读写文件。',
    '若无特殊说明，回答使用简体中文与 Markdown 格式。',
  ].join('\n');

  // 最后一条 user 消息 = 当前问题；其余 user/assistant/tool 按顺序进对话历史
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const systemParts: string[] = [];
  const historyParts: string[] = [];
  let current = '';
  messages.forEach((m, i) => {
    const text = renderContent(m).trim();
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      return;
    }
    if (i === lastUserIdx) {
      current = text;
      return;
    }
    if (text) historyParts.push(`【${roleLabel(m.role)}】\n${text}`);
  });
  if (lastUserIdx === -1 && historyParts.length > 0) {
    // 没有任何 user 消息的罕见形态：把最后一条历史搬出来当当前问题，避免空问题节
    current = historyParts.pop()!.replace(/^【[^】]*】\n/, '');
  }

  const sections = [preamble];
  if (systemParts.length > 0) {
    sections.push(`===== 系统指令 =====\n${systemParts.join('\n\n')}`);
  }
  if (historyParts.length > 0) {
    sections.push(`===== 对话历史 =====\n${historyParts.join('\n\n')}`);
  }
  sections.push(`===== 当前问题 =====\n【用户】\n${current || '（无文字内容，请按系统指令输出结果）'}`);
  return { prompt: sections.join('\n\n'), imagePaths };
}

// ---------- codex exec 事件流消费 ----------

/** codex JSONL 事件的最小类型面（只声明适配器消费的字段，其余忽略） */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    message?: string;
  };
  message?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** codex usage → OpenAI 兼容 TokenUsage（前端状态栏按同一口径展示） */
function mapUsage(u: NonNullable<CodexEvent['usage']>): TokenUsage {
  const input = Number(u.input_tokens ?? 0);
  const cached = Number(u.cached_input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

/**
 * 消费一次 codex exec：
 * 启动子进程 → stdin 写入 instructions → 解析 stdout JSONL 事件 → 以 content delta
 * 形式 yield 正文；思维链（reasoning）与 token 用量经 ChatOptions 回调转发。
 * 正常结束 = turn.completed；turn.failed / 进程异常退出 / 空闲看门狗触发 / 调用方中断
 * 都会抛错（AbortError 原样抛出，与 HTTP 路径的中断语义一致）。
 *
 * 流式粒度说明：agent_message 若以 item.updated 分段到达则实时 yield；只在
 * item.completed 一次性到达的版本则整段 yield 一次（调用方表现为等全文后一次显示）。
 */
async function* codexContentStream(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
  deps: CodexDeps,
): AsyncGenerator<string, void, void> {
  // 图片转 -i 临时文件 + codex 工作目录：用一次建、用完即删的独立 tmp 目录，
  // 避免在用户项目或工作台数据目录里留痕/被 codex 读到无关文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-codex-'));
  const procRef: { current: CodexTurnSpawn | null } = { current: null };
  const onCallerAbort = (): void => killCodexTree(procRef.current?.child ?? null);
  if (opts.signal) {
    if (opts.signal.aborted) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw abortError();
    }
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const { prompt, imagePaths } = buildCodexPrompt(messages, tmpDir);
    const args = buildExecArgs(cfg, imagePaths, tmpDir);
    // spawn 层的事件监听在其内部同步挂载（含 Windows shell 回退 + prompt 重写），这里
    // 拿到的是已在缓冲事件的流对象；spawn 不会 reject（失败经 proc.closeErr 上报）
    const proc = await spawnCodexForTurn(args, prompt, deps);
    procRef.current = proc;
    // 竞态守卫：spawn 期间调用方可能已经 abort——onCallerAbort 还杀不到尚未登记的
    // 子进程，就地补杀并按中断收尾
    if (opts.signal?.aborted) {
      killCodexTree(proc.child);
      throw abortError();
    }

    // 空闲看门狗：与 HTTP 流式路径同一阈值口径——codex「连上了却不再输出任何事件」
    // （模型挂住、进程僵死）时掐断，正常生成长思考也不会误杀。
    // 触发后必须主动唤醒等待中的主循环（stdout 可能没有 'close' 可依赖），否则 await 悬挂。
    const stallMs = opts.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (proc.closeErr === null) {
          proc.closeErr = new Error(`Codex CLI 无响应（${Math.ceil(stallMs / 1000)}s 内没有新事件），已终止`);
        }
        killCodexTree(procRef.current?.child ?? null);
        proc.markClosed(null);
      }, stallMs);
    };

    // 事件解析状态
    let done = false;
    let failed: Error | null = null;
    let lastNotice = ''; // 顶层 error 的瞬态通知（Reconnecting... 之类），仅用于失败时的上下文
    const emittedByItem = new Map<string, number>(); // item id → 已 yield 的字符数（兼容 updated 分段与 completed 整段两种形态）

    function* processLine(line: string): Generator<string, void, void> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: CodexEvent;
      try {
        ev = JSON.parse(trimmed) as CodexEvent;
      } catch {
        return; // 非事件行（版本差异下混入的提示文本）跳过
      }
      switch (ev.type) {
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = ev.item ?? {};
          if (item.type !== 'agent_message' && item.type !== 'reasoning') return;
          const text = item.text ?? '';
          const key = item.id ?? `${item.type}_${emittedByItem.size}`;
          const emitted = emittedByItem.get(key) ?? 0;
          if (text.length <= emitted) return;
          const delta = text.slice(emitted);
          emittedByItem.set(key, text.length);
          if (item.type === 'reasoning') {
            opts.onReasoning?.(delta);
            return;
          }
          yield delta;
          return;
        }
        case 'error': {
          // 瞬态通知（如重连中 1/5），不算失败；最终失败时拼进错误上下文
          lastNotice = (ev.message ?? '').trim();
          return;
        }
        case 'turn.completed': {
          if (ev.usage) opts.onUsage?.(mapUsage(ev.usage));
          done = true;
          return;
        }
        case 'turn.failed': {
          failed = friendlyCodexError(ev.error?.message ?? ev.message);
          return;
        }
        default:
          return; // thread.started / turn.started 等无需处理
      }
    }

    try {
      armStall();
      while (!done && !failed) {
        // 消费已就绪的行
        while (proc.lines.length > 0 && !done && !failed) {
          const line = proc.lines.shift()!;
          if (opts.signal?.aborted) break;
          yield* processLine(line);
        }
        if (done || failed || opts.signal?.aborted) break;
        if (proc.closed) {
          if (proc.partial.trim()) {
            // 进程退出时尾行可能不带换行符
            yield* processLine(proc.partial);
            proc.partial = '';
          }
          break;
        }
        // 等下一批数据；abort → kill → stdout close 会唤醒这里的等待
        await new Promise<void>((resolve) => {
          proc.notify = resolve;
        });
        proc.notify = null;
        armStall();
      }
    } finally {
      if (stallTimer !== null) clearTimeout(stallTimer);
      killCodexTree(procRef.current?.child ?? null);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }

    if (opts.signal?.aborted) throw abortError();
    if (failed) throw failed;
    if (done) return;
    if (proc.closeErr !== null) {
      throw proc.closeErr; // 空闲看门狗或 spawn 层错误（含安装指引）
    }
    // stdout 可能先于 exit 事件关闭（codex 把 JSONL 写完就关流）：给退出事件最多 2s
    // 宽限，否则退出码与 stderr 还在路上，错误会被拼成含糊的「进程提前退出」
    if (!proc.exited) {
      await new Promise<void>((resolve) => {
        const grace = setTimeout(resolve, 2_000);
        proc.exitDone.then(() => {
          clearTimeout(grace);
          resolve();
        });
      });
    }
    // 未收到 turn.completed 就结束：按退出码/错误来源拼可读错误
    const exitNote = proc.exitCode !== null
      ? `退出码 ${proc.exitCode}`
      : proc.exitSignal
        ? `被信号 ${proc.exitSignal} 终止`
        : '进程提前退出';
    const combined = `${proc.stderrTail.trim()}${lastNotice ? ` ${lastNotice}` : ''}`.trim();
    if (/not logged in|请先.*登录|unauthorized|401/i.test(combined)) {
      throw new Error(`Codex CLI ${exitNote}：未登录或凭据失效（${CODEX_LOGIN_HINT}）`);
    }
    throw new Error(
      `Codex CLI 未能完成回复（${exitNote}）${combined ? `：${combined.slice(0, 300)}` : ''}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 非流式对话（对齐 AiProvider.chat 的语义）：等待 codex 完成，返回整段正文。
 * tool_calls 恒为空（codex 的工具由它自身沙箱/MCP 决定，不经 OpenAI function calling），
 * onFinish 以 (null, undefined) 收尾让上层调用循环立即结束。
 */
export async function codexChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
  deps: CodexDeps = {},
): Promise<string> {
  let content = '';
  for await (const delta of codexContentStream(cfg, messages, opts, deps)) {
    content += delta;
  }
  opts.onFinish?.(null, undefined);
  if (content.trim() === '') {
    throw new Error('Codex CLI 未返回任何内容');
  }
  return content;
}

/**
 * 流式对话（对齐 AiProvider.chatStream 的语义）：逐 delta yield 正文片段。
 */
export async function* codexChatStream(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
  deps: CodexDeps = {},
): AsyncGenerator<string, void, void> {
  for await (const delta of codexContentStream(cfg, messages, opts, deps)) {
    yield delta;
  }
  opts.onFinish?.(null, undefined);
}

// ---------- 设置页「测试连接」用的探针 ----------

interface CodexCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 运行一条简单的 codex 子命令（--version / login status），超时/中断掐断，spawn 失败抛安装指引 */
async function runCodexCommand(
  args: string[],
  timeoutMs: number,
  deps: CodexDeps = {},
  signal?: AbortSignal,
): Promise<CodexCommandResult> {
  // 子命令不需要指令输入：prompt 传空串，stdin 立即关闭，避免 codex 等待输入
  const proc = await spawnCodexForTurn(args, '', deps);
  return new Promise<CodexCommandResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      killCodexTree(proc.child);
      finish(() => reject(new Error(`codex ${args[0]} 超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    const onAbort = (): void => {
      killCodexTree(proc.child);
      finish(() => reject(abortError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // 流终止统一经 markClosed → done（含致命 spawn 错误与 shell 回退换子进程后的失败）
    proc.done.then(() => {
      if (proc.closeErr !== null) {
        finish(() => reject(proc.closeErr));
        return;
      }
      if (!proc.exited) {
        // stdout 可能先于 exit 事件关闭：等真实退出码（上限 2s，超时按当前状态收尾）
        proc.exitDone.then(() => {
          if (!settled) settleResult();
        });
        return;
      }
      settleResult();
    });
    const settleResult = (): void => {
      // stdout 由 spawn 层同步缓冲重建：完整行 + 尾碎片，杜绝「close 先于监听」丢输出
      const stdout = [...proc.lines].join('\n') + proc.partial;
      finish(() => resolve({ code: proc.exitCode, stdout, stderr: proc.stderrTail }));
    };
  });
}

/**
 * 「本地 Codex」连通性自检（设置页「测试连接」）：
 * 1) codex --version —— CLI 已安装且在 PATH；
 * 2) codex login status —— 已登录（ChatGPT 或 API key 均可，凭据由 codex 管理）；
 * 3) codex exec 真实跑一次最小对话 —— 端到端验证（占用极少量额度）。
 */
export async function codexProviderTest(deps: CodexDeps = {}): Promise<{ ok: boolean; message: string }> {
  const effectiveDeps = Object.keys(deps).length > 0 ? deps : codexTestDeps;
  const started = Date.now();
  try {
    await runCodexCommand(['--version'], 10_000, effectiveDeps);
  } catch (e) {
    return { ok: false, message: `${CODEX_INSTALL_HINT}（${(e as Error).message}）` };
  }
  try {
    const login = await runCodexCommand(['login', 'status'], 10_000, effectiveDeps);
    if (login.code !== 0) {
      return {
        ok: false,
        message: `Codex CLI 已安装，但尚未登录：请在终端运行 codex login 完成 ChatGPT 登录（codex login status 输出：${(login.stdout || login.stderr).trim().slice(0, 120)}）`,
      };
    }
  } catch (e) {
    return { ok: false, message: `检查登录状态失败：${(e as Error).message}` };
  }
  try {
    await codexChat(
      { enabled: true, baseURL: '', apiKey: '', model: '' } satisfies AiConfig,
      [
        { role: 'system', content: '这是一次连通性测试。只输出两个字：正常' },
        { role: 'user', content: 'ping' },
      ],
      { signal: AbortSignal.timeout(60_000) },
      effectiveDeps,
    );
    return { ok: true, message: `连接成功（${Date.now() - started}ms，经 codex exec 实测对话）` };
  } catch (e) {
    return { ok: false, message: `连接失败：${friendlyCodexError(e).message}` };
  }
}

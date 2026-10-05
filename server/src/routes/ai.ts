import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { AiProvider, describeError, type ChatContentBlock, type ChatMessage, type ToolCall, type TokenUsage } from '../ai/provider.ts';
import { estimateTokens, trimContext, summarizeContext, SUMMARIZE_THRESHOLD } from '../ai/context.ts';
// 导入 search.ts 触发 web_search 工具注册（副作用导入，不需要直接使用导出）
import '../ai/search.ts';
// 导入 fetch-url.ts 触发 fetch_url 工具注册（副作用导入）
import '../ai/fetch-url.ts';
// 导入 fetch-editorial.ts 触发 fetch_editorial 工具注册（副作用导入）
import '../ai/fetch-editorial.ts';
import { extractPdfText, truncatePdfText, isPdfContentType, isPdfFilename } from '../ai/pdf.ts';
import { convertDocument, isDocumentFile } from '../ai/docConverter.ts';
import { getToolDefinitions, executeToolCall, type ToolResult, type ToolContext, type PlatformCookies } from '../ai/tools/registry.ts';
import { buildTemplateLibrarySummary } from '../ai/templateContext.ts';
import { listTemplateCategoryOptions } from '../templates/categories.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { buildPracticeSummary, renderSummaryForPrompt } from '../analysis/summary.ts';
import { effectiveAbility, renderAbilityEvidence, setAbilityOverride } from '../today/ability.ts';
import { renderPlanContext, renderTemplate, today } from '../plans/planService.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import { fetchAllContests, selectContests } from '../contests/index.ts';
import { calendarCache } from '../contests/calendarCache.ts';
import { renderContestContext, resolveContestGroup } from '../contests/participated.ts';
import { prefetchProblemStatementsBackground } from '../contests/problemStatements.ts';
import {
  kickBackgroundRefresh,
  loadParticipationSources,
  readParticipationSnapshot,
  fetchContestProblemSet,
  problemsAreRich,
  type ParticipationSources,
  type ProblemSetResult,
} from '../contests/participationSources.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { ContestInfo } from '../../../shared/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** /chat 请求中前端发来的消息轮次（校验前的宽松形态） */
interface IncomingTurn {
  role?: unknown;
  content?: unknown;
  /** Files API 上传后的文件引用（仅 user 消息允许） */
  attachments?: unknown;
}

interface IncomingAttachment {
  fileId?: unknown;
  filename?: unknown;
  /** 文本类附件的文件内容（服务端以代码块拼接到消息文本） */
  textContent?: unknown;
}

/** 通过校验后的轮次（role/content 类型已在上方循环里确认；供后续 map/filter 使用） */
type ValidTurn = IncomingTurn & { role: 'user' | 'assistant'; content: string };

/**
 * 单次对话允许携带的轮次上限。
 * 超出部分**从最早开始丢弃**（与 trimContext 的 token 裁剪同向，并复用同一条
 * 「已自动裁剪最早的 N 条消息」提示），而不是整单拒绝 —— 长会话不该发不出消息。
 */
const MAX_TURNS = 60;

/** 硬上限：只用于挡住异常/恶意超大请求体，正常会话不该碰到 */
const HARD_MAX_TURNS = 1000;

/**
 * 工具调用往返循环的轮次上限（防止无限循环烧配额）。
 * 最后一轮是「强制收尾轮」：不再允许 AI 发起新的工具调用，注入提示要求它
 * 直接给出最终回答。不能省掉这一轮 —— 上限耗尽后直接收尾的话，AI 的最终
 * 回答永远不会生成，前端表现为「联网搜索后回复自动停止」（无错误、无截断
 * 提示的静默截断；DeepSeek 在 tool 结果回来后经常继续以 DSML 泄漏发起下一
 * 次搜索，5 轮上限并不遥远）。
 */
const MAX_TOOL_ROUNDS = 5;

/** 强制收尾轮注入给 AI 的提示（作为 user 消息追加在 tool 结果之后） */
const TOOL_ROUND_LIMIT_NOTICE =
  '（系统提示：工具调用轮次已达上限，无法继续执行工具。请直接基于以上工具结果与你已有的知识给出最终回答，不要再尝试调用工具。）';

/** 助手提示词模板：懒加载（SEA bundle 注入值优先，同 planService 惯例） */
let promptOverride: string | null = null;
let promptFromDisk: string | null = null;

export function setAssistantPromptTemplate(tpl: string): void {
  promptOverride = tpl;
}

export function ASSISTANT_PROMPT_TEMPLATE(): string {
  if (promptOverride !== null) return promptOverride;
  if (promptFromDisk === null) {
    promptFromDisk = fs.readFileSync(path.join(__dirname, '..', 'ai', 'assistant-prompt.md'), 'utf8');
  }
  return promptFromDisk;
}

/** 标题生成提示词：懒加载（同 ASSISTANT_PROMPT_TEMPLATE 惯例） */
let titlePromptFromDisk: string | null = null;

export function TITLE_PROMPT_TEMPLATE(): string {
  if (titlePromptFromDisk === null) {
    titlePromptFromDisk = fs.readFileSync(path.join(__dirname, '..', 'ai', 'title-prompt.md'), 'utf8');
  }
  return titlePromptFromDisk;
}

/** 用于测试注入标题提示词 */
export function setTitlePromptTemplate(tpl: string): void {
  titlePromptFromDisk = tpl;
}

export function aiRoutes(
  db: Db,
  getAiConfig: () => AiConfig,
  opts: {
    createProvider?: () => Pick<AiProvider, 'chat' | 'chatStream' | 'enabled'>;
    /**
     * 赛事日历数据源（可选注入）。
     *
     * 为什么可注入：`/chat` 每次请求都会取「近 14 天赛事」拼进 system prompt，
     * 默认实现会**实时访问 5 个外部站点**（CF/AtCoder/洛谷/牛客/计蒜客）。单测里这层
     * 外部依赖既慢（单个用例 2s+）又不确定（离线/受限网络下必抖），所以允许注入桩，
     * 让测试不再依赖外网；生产不传，行为不变。
     */
    fetchContests?: typeof fetchAllContests;
    /**
     * 平台参赛记录源（可选注入，赛后复盘用）。默认实现会按绑定账号实时访问
     * CF/AtCoder/洛谷/牛客（60min 进程内缓存），单测注入桩避免外网依赖。
     */
    fetchParticipationSources?: (
      db: Db,
      calendar: ContestInfo[] | undefined,
    ) => Promise<ParticipationSources>;
  } = {},
): Router {
  const r = Router();

  // GET /api/ai/ability → 当前能力值（计算值 / AI 调整 / 生效值）
  r.get('/ability', (_req, res) => {
    res.json(effectiveAbility(db, DEFAULT_USER_ID));
  });

  // POST /api/ai/ability  body: { level, reason?, basis? } 或 { reset: true }
  // 应用 AI 助手的能力值调整（前端识别 ability-update 块后由用户确认调用）
  r.post('/ability', (req, res) => {
    const b = req.body ?? {};
    if (b.reset === true) {
      setAbilityOverride(db, null);
      return res.json(effectiveAbility(db, DEFAULT_USER_ID));
    }
    const level = Number(b.level);
    if (!Number.isInteger(level) || level < 800 || level > 3500 || level % 100 !== 0) {
      return res.status(400).json({ error: 'level 需为 800-3500 的 100 整数倍' });
    }
    setAbilityOverride(db, {
      level,
      ...(typeof b.reason === 'string' && b.reason.trim() ? { reason: b.reason.trim() } : {}),
      updatedAt: new Date().toISOString(),
      ...(typeof b.basis === 'string' && b.basis.trim() ? { basis: b.basis.trim() } : {}),
    });
    res.json(effectiveAbility(db, DEFAULT_USER_ID));
  });

  // POST /api/ai/title  body: { messages: [{role, content}] }
  // 根据对话前 1-2 轮生成 6-12 字中文标题（轻量非流式调用，低 maxTokens）。
  // 生成失败时返回 502 + 空标题，前端回退到首条消息截断。
  r.post('/title', asyncHandler(async (req, res) => {
    const { messages } = req.body ?? {};
    const turns = Array.isArray(messages) ? messages : [];
    if (turns.length === 0 || turns.length > 4) {
      return res.status(400).json({ error: 'messages 必填：1-4 条 {role, content} 轮次' });
    }
    for (const m of turns) {
      if (typeof m !== 'object' || m === null || (m.role !== 'user' && m.role !== 'assistant')) {
        return res.status(400).json({ error: 'messages[] 需为 {role: user|assistant, content: string}' });
      }
      if (typeof m.content !== 'string' || m.content.trim() === '') {
        return res.status(400).json({ error: 'messages[].content 必须为非空字符串' });
      }
    }
    const provider = opts.createProvider?.() ?? new AiProvider(getAiConfig());
    if (!provider.enabled) {
      return res.status(400).json({ error: 'AI 未配置', needConfig: true });
    }
    try {
      const titlePrompt = TITLE_PROMPT_TEMPLATE();
      const chatMsgs: ChatMessage[] = [
        { role: 'system', content: titlePrompt },
        ...turns.map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      ];
      const title = await provider.chat(chatMsgs, {
        temperature: 0.3,
        maxTokens: 64,
        signal: AbortSignal.timeout(15_000),
      });
      // 清理：去除引号、标点、首尾空白
      const cleanTitle = title.trim().replace(/["""''《》「」【】。，！？]/g, '').trim();
      res.json({ title: cleanTitle.slice(0, 20) || '新会话' });
    } catch (e) {
      res.status(502).json({ error: `标题生成失败：${(e as Error).message}`, title: '' });
    }
  }));

  // ---------- Files API（OpenAI 兼容 /files，DeepSeek 文档：上传/列出/查询/删除文件） ----------
  // 客户端以原始字节流直传（避免引入 multer），服务端再组装 multipart 转发上游。
  // purpose 固定 user_data（DeepSeek 当前唯一取值），file_id 可在对话中以 file 内容块引用。
  const MAX_FILE_BYTES = 64 * 1024 * 1024; // DeepSeek 单文件上限 64 MiB
  const newFilesProvider = () => new AiProvider(getAiConfig());

  r.post(
    '/files',
    // 先按 content-length 快速拒绝超限请求（express.raw 的 413 会被全局 errorHandler 变成 500）
    (req, res, next) => {
      const clen = Number(req.headers['content-length'] ?? 0);
      if (clen > MAX_FILE_BYTES) {
        return res.status(413).json({ error: '文件超过 64 MiB 上限（DeepSeek Files API 限制）' });
      }
      next();
    },
    raw({ type: () => true, limit: MAX_FILE_BYTES }),
    asyncHandler(async (req, res) => {
      const provider = newFilesProvider();
      if (!provider.enabled) {
        return res
          .status(400)
          .json({ error: 'AI 未配置：请到「设置 → AI 配置」填写 OpenAI 兼容接口后使用', needConfig: true });
      }
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: '请求体需为原始文件字节流（不可为空）' });
      }
      const header1 = (h: string | string[] | undefined): string | undefined =>
        Array.isArray(h) ? h[0] : h;
      const nameRaw = header1(req.headers['x-file-name']);
      let filename = 'file';
      if (nameRaw && nameRaw.trim()) {
        try {
          filename = decodeURIComponent(nameRaw);
        } catch {
          filename = nameRaw;
        }
      }
      const expRaw = header1(req.headers['x-expires-seconds']);
      let expiresAfterSeconds: number | undefined;
      if (expRaw !== undefined && expRaw.trim() !== '') {
        const n = Number(expRaw);
        if (!Number.isInteger(n) || n < 3600 || n > 2592000) {
          return res.status(400).json({ error: 'x-expires-seconds 需为 3600-2592000 的整数秒' });
        }
        expiresAfterSeconds = n;
      }
      try {
        const file = await provider.uploadFile({
          filename,
          contentType: header1(req.headers['content-type']),
          data: new Uint8Array(buf),
          expiresAfterSeconds,
        });
        res.json(file);
      } catch (e) {
        res.status(502).json({ error: `文件上传失败：${(e as Error).message}` });
      }
    }),
  );

  // ---------- 文档文本提取（本地，不依赖 AI 配置） ----------
  // 客户端上传文档时先调此端点提取文本，再以 textContent 注入对话。
  // 接收原始字节流 + content-type/x-file-name 头；PDF 用 unpdf，其余文档格式
  //（Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）用 docConverter 转 Markdown。
  const MAX_DOC_BYTES = 20 * 1024 * 1024; // 文档上限 20 MiB（xlsx/pptx 可能较大）
  const MAX_PDF_BYTES = 10 * 1024 * 1024; // PDF 上限 10 MiB
  r.post(
    '/extract-text',
    (req, res, next) => {
      const clen = Number(req.headers['content-length'] ?? 0);
      if (clen > MAX_DOC_BYTES) {
        return res.status(413).json({ error: '文件超过 20 MiB 上限' });
      }
      next();
    },
    raw({ type: () => true, limit: MAX_DOC_BYTES }),
    asyncHandler(async (req, res) => {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: '请求体需为原始文件字节流（不可为空）' });
      }
      const header1 = (h: string | string[] | undefined): string | undefined =>
        Array.isArray(h) ? h[0] : h;
      const contentType = header1(req.headers['content-type']) ?? '';
      const nameRaw = header1(req.headers['x-file-name']);
      let filename = 'file';
      if (nameRaw && nameRaw.trim()) {
        try {
          filename = decodeURIComponent(nameRaw);
        } catch {
          filename = nameRaw;
        }
      }
      // PDF 走现有 unpdf 路径（含独立 10 MiB 上限校验）
      if (isPdfContentType(contentType) || isPdfFilename(filename)) {
        if (buf.length > MAX_PDF_BYTES) {
          return res.status(413).json({ error: 'PDF 文件超过 10 MiB 上限' });
        }
        try {
          const { text, pages } = await extractPdfText(new Uint8Array(buf));
          if (!text.trim()) {
            return res.json({
              text: '',
              pages,
              warning: 'PDF 未提取到文本（可能是扫描型 PDF，仅含图片无文字层）',
            });
          }
          res.json({ text: truncatePdfText(text), pages });
        } catch (e) {
          res.status(502).json({ error: `PDF 文本提取失败：${(e as Error).message}` });
        }
        return;
      }
      // 其余文档格式走 docConverter
      if (!isDocumentFile(filename, contentType)) {
        return res.status(400).json({
          error: '不支持的文件类型（支持 PDF/Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）',
        });
      }
      try {
        const result = await convertDocument(new Uint8Array(buf), filename, contentType);
        if (!result.text.trim()) {
          res.json({ text: '', warning: result.warning ?? '文档未提取到文本内容' });
        } else {
          res.json({ text: result.text, ...(result.warning ? { warning: result.warning } : {}) });
        }
      } catch (e) {
        res.status(502).json({ error: `文档转换失败：${(e as Error).message}` });
      }
    }),
  );

  // POST /api/ai/chat  body: { messages, planId?, listId?, contestKey? }
  // 通用 AI 助手：注入练习数据汇总（含问题分布统计）+ 弱项画像 + 能力值；
  // planId 给定时附带计划上下文（支持 plan-modify 修改计划）；
  // listId 给定时附带题单上下文（AI 可基于题单内容分析、建议练习）；
  // contestKey 给定时附带该场比赛链接与全部提交记录（赛后复盘，key 来自
  // GET /api/contests/participated 的 ParticipatedContest.key）。
  // user 消息可携带 attachments（Files API 上传后的 file_id 列表），服务端转换为
  // OpenAI 多模态内容块（file 引用 + 文本）后调用上游。
  r.post('/chat', asyncHandler(async (req, res) => {
    const { messages, planId, listId, contestKey } = req.body ?? {};
    const rawTurns = Array.isArray(messages) ? (messages as IncomingTurn[]) : [];
    // 轮次数量本身不再是「多则拒绝」：超过 MAX_TURNS 的部分在下方按最早优先裁剪并告知前端，
    // 只有 0 条 / 超过硬上限才报错（文案要能区分这两种情况，否则用户看到「1-60」会误判）
    const BAD_MSGS = `messages 必填：至少 1 条 {role: user|assistant, content} 轮次（最多 ${HARD_MAX_TURNS} 条）`;
    if (rawTurns.length === 0) {
      return res.status(400).json({ error: BAD_MSGS });
    }
    if (rawTurns.length > HARD_MAX_TURNS) {
      return res.status(400).json({
        error: `messages 轮次过多：最多 ${HARD_MAX_TURNS} 条（当前 ${rawTurns.length} 条）`,
      });
    }
    for (const m of rawTurns) {
      if (typeof m !== 'object' || m === null || (m.role !== 'user' && m.role !== 'assistant')) {
        return res.status(400).json({ error: BAD_MSGS });
      }
      if (typeof m.content !== 'string') {
        return res.status(400).json({ error: 'messages[].content 必须为字符串' });
      }
      if (m.attachments !== undefined) {
        if (m.role !== 'user') {
          return res.status(400).json({ error: 'attachments 仅允许出现在 user 消息上' });
        }
        if (!Array.isArray(m.attachments) || m.attachments.length === 0 || m.attachments.length > 8) {
          return res.status(400).json({ error: 'attachments 需为 1-8 个 { fileId, filename? } 的数组' });
        }
        for (const a of m.attachments as IncomingAttachment[]) {
          if (
            typeof a !== 'object' ||
            a === null ||
            typeof a.fileId !== 'string' ||
            a.fileId.trim() === '' ||
            a.fileId.length > 256 ||
            (a.filename !== undefined && (typeof a.filename !== 'string' || a.filename.length > 256))
          ) {
            return res
              .status(400)
              .json({ error: 'attachments[] 需为 { fileId: string, filename?: string }（fileId 必填，均 ≤256 字符）' });
          }
          // textContent 为可选字符串（文本类附件），上限 1 MiB 防止超大请求
          if (a.textContent !== undefined && (typeof a.textContent !== 'string' || a.textContent.length > 1048576)) {
            return res
              .status(400)
              .json({ error: 'attachments[].textContent 需为字符串且不超过 1 MiB' });
          }
        }
      }
    }
    /**
     * 空内容轮次直接丢弃，不整单拒绝。
     *
     * 现场（issue 36）：模型偶发返回空回复时，前端会留下一条 content='' 的 assistant 轮次；
     * 历史里一旦有它，之后**每一轮**都会撞上「messages 必填」而被整体拒绝 —— 报错文案指向
     * 轮次数量，真正的原因却是一条空轮次，用户无从自救（只能删掉整个会话）。
     * 空轮次不携带任何信息（上游 API 也普遍拒绝空 content），丢掉即可。
     * user 纯附件提问（content 为空但有 attachments）仍保留。
     */
    const turns = (rawTurns as ValidTurn[]).filter(
      (m) => m.content.trim() !== '' || (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length > 0),
    );
    if (turns.length === 0) {
      return res.status(400).json({ error: 'messages 无有效内容：所有轮次的 content 均为空' });
    }
    // user 消息带附件时：图片附件转为 file 内容块，文本附件拼接到消息文本
    // 注意：本地提取文本的附件（PDF/文档/文本文件）fileId 形如 doc-…/text-…，
    // 不是 Files API 的 file-api-… 引用。首次发送时 textContent 存在，走文本拼接；
    // 但历史消息的 textContent 已被客户端剥离（避免 localStorage 爆满），只剩假 fileId
    // ——这些附件绝不能转成 file 内容块（上游会报 MODEL_CAPABILITY_NOT_SUPPORTED 400，
    // 导致同一会话第二轮起每次调用都失败）。此时只保留文件名占位文本。
    const isFilesApiId = (fileId: string): boolean => fileId.startsWith('file-');
    const normalized: ChatMessage[] = turns.map((m) => {
      if (m.role !== 'user') return { role: 'assistant', content: m.content as string };
      const atts = (Array.isArray(m.attachments) ? m.attachments : []) as IncomingAttachment[];
      if (atts.length === 0) return { role: 'user', content: m.content as string };

      // 分离图片附件（file_id 引用）和文本附件（内容拼接到文本）
      const fileBlocks: ChatContentBlock[] = [];
      const textParts: string[] = [];
      const userText = (m.content as string).trim();

      for (const a of atts) {
        const fileId = (a.fileId as string).trim();
        const filename = typeof a.filename === 'string' && a.filename.trim() ? a.filename.trim() : undefined;
        // 文本附件：textContent 存在时拼接到消息文本
        if (typeof a.textContent === 'string' && a.textContent.length > 0) {
          if (filename && isPdfFilename(filename)) {
            // PDF 内容多为题面/文档正文，以普通段落注入而非代码块
            textParts.push(`\n\n**${filename}**\n${a.textContent}`);
          } else {
            const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
            textParts.push(`\n\n**${filename ?? fileId}**\n\`\`\`${ext}\n${a.textContent}\n\`\`\``);
          }
        } else if (isFilesApiId(fileId)) {
          // 图片附件：file 内容块引用（仅 Files API 上传的真实 file-api-… id）
          fileBlocks.push({
            type: 'file',
            file_id: fileId,
            ...(filename ? { filename } : {}),
          });
        } else {
          // 本地文本附件的历史消息（textContent 已剥离）：无法重建内容，
          // 注入文件名占位符保持轮次结构，让 AI 知道用户当时附过什么文件
          textParts.push(`\n\n**${filename ?? '附件'}**（此前的附件内容未随本轮携带，如需引用请让用户重新上传）`);
        }
      }

      // 组装最终内容块：图片 file 块在前，文本（用户输入 + 文本附件代码块）在后
      const fullText = userText + textParts.join('');
      if (fileBlocks.length === 0) {
        // 仅文本附件：直接返回字符串内容
        return { role: 'user', content: fullText };
      }
      const blocks: ChatContentBlock[] = [...fileBlocks];
      if (fullText) blocks.push({ type: 'text', text: fullText });
      return { role: 'user', content: blocks };
    });
    const provider = opts.createProvider?.() ?? new AiProvider(getAiConfig());
    if (!provider.enabled) {
      return res.status(400).json({ error: 'AI 未配置：请到「设置 → AI 配置」填写 OpenAI 兼容接口后使用', needConfig: true });
    }
    // contestKey 可选：`{platform}:{contestId}` 复合键，取值来自
    // GET /api/contests/participated（ParticipatedContest.key），非法格式直接 400
    const CONTEST_KEY_RE = /^([a-z]+):[\w.-]{1,120}$/;
    if (contestKey !== undefined && (typeof contestKey !== 'string' || !CONTEST_KEY_RE.test(contestKey))) {
      return res.status(400).json({ error: 'contestKey 需为 `{platform}:{contestId}` 形式的字符串（来自 /api/contests/participated）' });
    }

    const summary = buildPracticeSummary(db, DEFAULT_USER_ID);
    const summaryPrompt = renderSummaryForPrompt(summary);
    const weakness = computeWeakness(db, DEFAULT_USER_ID, { minAttempts: 5, topN: 8 });
    const ability = effectiveAbility(db, DEFAULT_USER_ID);
    const overrideNote = ability.override
      ? `（当前已应用 AI 调整 ${ability.override.level}，理由：${ability.override.reason ?? '未记录'}；再次评估请以此为基线，证据无实质变化则维持）`
      : '（无 AI 调整记录，生效值即计算值）';

    let planSection = '（未关联训练计划：plan-modify 能力不可用；用户提到改计划时请引导其先在本页右上角下拉关联训练计划）';
    if (Number.isInteger(planId)) {
      try {
        planSection = `## 关联的训练计划\n${renderPlanContext(db, Number(planId), DEFAULT_USER_ID)}`;
      } catch {
        planSection = '（关联的训练计划不存在）';
      }
    }

    let listSection = '（未关联题单：用户提到题单整理时请引导其先在本页右上角下拉关联题单）';
    if (Number.isInteger(listId)) {
      try {
        listSection = `## 关联的题单\n${renderListContext(db, Number(listId), DEFAULT_USER_ID)}`;
      } catch {
        listSection = '（关联的题单不存在）';
      }
    }

    // 近 14 天赛事日历（赛事源各自有 30/60 分钟缓存，失败降级为空，不阻断对话）；
    // 日历同时作为赛后复盘的赛名/时间窗来源（contestSection），一次拉取两处复用。
    // 默认走持久化缓存（SWR）：重启后首次对话不再等 5 个平台源的网络拉取；
    // 测试注入 fetchContests 时维持原样直连（不经缓存，避免跨用例串数据）
    let calendar: ContestInfo[] | undefined;
    let upcomingContests = '（赛事数据暂不可用）';
    try {
      const all = opts.fetchContests
        ? (await opts.fetchContests()).contests
        : await calendarCache.load(db);
      if (!all) throw new Error('赛事日历不可用');
      calendar = all;
      const upcoming = selectContests(all, { type: 'upcoming', limit: 10 })
        .filter((c) => {
          if (!c.startTimeIso) return false;
          return new Date(c.startTimeIso).getTime() <= Date.now() + 14 * 86_400_000;
        })
        .map((c) => ({
          platform: c.platform,
          name: c.name,
          start: c.startTimeIso,
          durationMin: c.durationMinutes,
          url: c.url,
        }));
      upcomingContests = upcoming.length > 0
        ? JSON.stringify(upcoming, null, 2)
        : '（近 14 天暂无已排期赛事）';
    } catch {
      // 赛事拉取失败不阻断 AI 对话
    }

    // 赛后复盘：contestKey 给定时渲染该场比赛链接 + 全部逐题提交记录。
    // 解析时合并平台侧参赛记录（user.rating / joinedContests 等，60min 缓存）——
    // 推导不到（数据清理/换账号）降级为提示文案，不阻断对话
    let contestSection = '（未关联比赛：赛后复盘能力不可用；用户想复盘某场比赛时请引导其先在本页左栏「赛后复盘」下拉选择参加过的比赛）';
    if (typeof contestKey === 'string' && contestKey.trim() !== '') {
      // chat 路径复用读库快照（与 GET /participated 同口径），不再每条消息同步打外网。
      // 参赛记录陈旧 ≤30 分钟完全可接受（复盘归因的是历史比赛），且与列表的新鲜度一致。
      // 测试注入 fetchParticipationSources 时维持原样直连（不经快照，避免跨用例串数据）。
      let sourcesByPlatform: ParticipationSources['byPlatform'];
      if (opts.fetchParticipationSources) {
        const loaded = await opts.fetchParticipationSources(db, calendar);
        sourcesByPlatform = loaded.byPlatform;
      } else {
        const snapshot = readParticipationSnapshot(db);
        if (snapshot.stalePlatforms.length > 0) {
          // after=settled()：与 GET /participated 同款错峰，别和日历重拉挤兑洛谷队列
          kickBackgroundRefresh(db, calendar, undefined, calendarCache.settled());
        }
        sourcesByPlatform = snapshot.byPlatform;
      }
      const resolveOpts = { calendar, sources: sourcesByPlatform };
      let review = resolveContestGroup(db, contestKey.trim(), resolveOpts);
      // 题目集缺失（或只有旧格式的纯 id 集）时按需补拉（CF: contest.standings；
      // 牛客: problem-list，均公开接口）——否则「赛时未提交的题」没有题号/题名，
      // 复盘点评缺一角。拉到即持久缓存到 participated_contests（含三态 state），
      // 之后复盘零请求；失败静默退避 5 分钟，不阻断对话。
      // 三态：ok/empty 不重拉（empty = 确认无题已缓存），只有 unknown 才触发补拉。
      if (
        review &&
        (!review.problemSetKnown ||
          (review.unsubmittedProblems.length > 0 && !problemsAreRich(review.unsubmittedProblems)))
      ) {
        const result: ProblemSetResult = await fetchContestProblemSet(
          db, review.contest.platform, review.contest.contestId,
        );
        if (result.status === 'ok') {
          const refs = result.refs;
          const submitted = new Set(review.submissions.map((s) => s.problemKey));
          review = {
            ...review,
            problemSetKnown: true,
            unsubmittedProblems: refs.filter((p) => !submitted.has(p.id)),
          };
        } else if (result.status === 'empty') {
          // 确认无题：problemSetKnown 设为 true，unsubmittedProblems 为空（已持久化 state）
          review = { ...review, problemSetKnown: true, unsubmittedProblems: [] };
        }
        // 'unavailable' = 退避期内或拉取失败，保持原样（下次复盘再试）
        // AtCoder 的题目集来自官方 tasks 页，抓取时已顺手修正库内被社区数据串号的标题
        // （实测 abc454_b 库内为「C. Mapping」、官方为「B. Mapping」）。重解析一次，
        // 让本轮的「逐题明细」与题面标签立刻用上正确题名（一次索引查询，代价可忽略）。
        if (
          review.contest.platform === 'atcoder' &&
          (result.status === 'ok' || result.status === 'empty')
        ) {
          const refreshed = resolveContestGroup(db, contestKey.trim(), resolveOpts);
          if (refreshed) {
            review = { ...refreshed, problemSetKnown: true, unsubmittedProblems: review.unsubmittedProblems };
          }
        }
      }
      if (review) {
        // 后台预取题面（非阻塞）：覆盖该场所有能拿到 URL 的题（未通过 → 未提交 → **已 AC**），
        // 落库后下次复盘即有题面注入。曾只抓「未通过+未提交」，导致 AI 对已 AC 的题编造题意。
        // 不在 chat 同步路径里阻塞——注入是纯读库（renderContestContext 读 problem_statements）。
        // 首次打开时题面可能尚未落库：上下文会显式列出「未取到题面」的题号，提示词禁止对其推断题意。
        // 题面预取要用的平台 Cookie：全部平台通用（blocked/gated 平台只有带 Cookie 才尝试，
        // 例如 CF 的 cf_clearance、牛客登录态）。洛谷也要（C3VK 之外仍可用登录态）。
        const reviewCookies: Record<string, { cookie?: string }> = {};
        for (const row of db
          .prepare("SELECT key, value FROM settings WHERE key LIKE 'cookie.%'")
          .all() as Array<{ key: string; value: string }>) {
          const platform = row.key.slice('cookie.'.length);
          if (row.value?.trim()) reviewCookies[platform] = { cookie: row.value };
        }
        prefetchProblemStatementsBackground(db, review, undefined, reviewCookies);
      }
      contestSection = review
        ? `## 关联的比赛（赛后复盘）\n${renderContestContext(review, { db })}`
        : '（关联的比赛不存在或暂无提交记录，可能数据已被清理或账号已换绑）';
    }

    const system = renderTemplate(ASSISTANT_PROMPT_TEMPLATE(), {
      summary: summaryPrompt,
      currentDate: today(),
      weakness: JSON.stringify(weakness.items),
      computedLevel: String(ability.computed),
      effectiveLevel: String(ability.effective),
      abilityOverrideNote: overrideNote,
      abilityEvidence: renderAbilityEvidence(db, DEFAULT_USER_ID, summary),
      planSection,
      listSection,
      contestSection,
      upcomingContests,
      // 模板库写入（template-add 块）可选的分类清单：内置课程大纲 + 用户自建标签。
      // 自建标签必须一并给出（并标注「自建」），否则用户「记到 XX 标签下」的要求 AI 无从满足。
      templateCategories: listTemplateCategoryOptions(db)
        .map((c) => `${c.key}（${c.name}${c.custom ? '·自建' : ''}）`)
        .join('、'),
      // 模板库现有内容摘要：让 AI 知道用户已有哪些模板，避免建议重复、可针对性建议补充
      templateLibrary: buildTemplateLibrarySummary(db),
    });
    // SSE 流式响应：逐 delta 写给前端，AI 正在生成时用户即可看到内容
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 防止 Nginx 等代理缓冲 SSE
    res.flushHeaders();

    // 按模型上下文窗口裁剪对话历史：budget = contextWindow - maxTokens - systemTokens
    // 超出时从最早消息开始丢弃，避免 API 因上下文超限报错
    const aiCfg = getAiConfig();
    const maxTokens = aiCfg.maxTokens ?? 393216;
    const contextWindow = aiCfg.contextWindow ?? 1024000;
    // 长会话带动轮次上限：超过 MAX_TURNS 的旧轮次先丢（与 token 裁剪同向：都从最早开始丢），
    // 再按 token 预算裁剪。两次裁剪都是「丢前缀」，故 trimmedCount 可以直接相加，
    // 摘要用的 normalized.slice(0, trimmedCount) 恰好覆盖被丢掉的整段（旧实现：>60 条直接 400）。
    const turnTrimmed = Math.max(0, normalized.length - MAX_TURNS);
    const cappedMsgs = turnTrimmed > 0 ? normalized.slice(turnTrimmed) : normalized;
    const { messages: trimmedMsgs, trimmed: tokenTrimmed } = trimContext(
      estimateTokens(system),
      cappedMsgs,
      contextWindow,
      maxTokens,
    );
    const trimmedCount = turnTrimmed + tokenTrimmed;

    // 客户端中断传播：前端 AbortController.abort() → 取消上游 AI 请求与后续工具轮次，
    // 避免用户点「停止」后仍继续烧配额（参考 opencode 的 Cancel + ctx.Done()）。
    // 实测（Node 24 + node:http，POST 体已被 express.json 读完）：
    // - req 'aborted' 不再触发（该事件在 body 读完后就没了），只挂它等于没挂；
    // - req 'close' 在 body 读完的瞬间就触发，拿它当中断会误伤正常的多轮流式；
    // - res 'close' 恰好在客户端断开的那一刻触发，正常 res.end() 之后也会触发，
    //   故用 writableEnded 区分「我们把话说完了」与「对面走了」。
    const abortController = new AbortController();
    const onClientGone = () => {
      if (!res.writableEnded) abortController.abort();
    };
    req.on('aborted', onClientGone);
    res.on('close', onClientGone);

    try {
      // 上下文摘要：被裁消息较多时生成摘要注入对话，保留关键信息（能力/弱项/目标/结论）
      // 少量裁剪（< SUMMARIZE_THRESHOLD）直接丢弃 + contextTrimmed 通知，不值得摘要开销
      let systemPrefix = '';
      if (trimmedCount >= SUMMARIZE_THRESHOLD) {
        const dropped = normalized.slice(0, trimmedCount);
        const summary = await summarizeContext(provider, dropped);
        if (summary) {
          systemPrefix = `[之前的对话摘要]\n${summary}\n\n`;
          res.write(`data: ${JSON.stringify({ summarized: true, droppedCount: trimmedCount })}\n\n`);
        } else {
          // 摘要失败：降级为 contextTrimmed 通知
          res.write(`data: ${JSON.stringify({ contextTrimmed: trimmedCount })}\n\n`);
        }
      } else if (trimmedCount > 0) {
        res.write(`data: ${JSON.stringify({ contextTrimmed: trimmedCount })}\n\n`);
      }

      // 联网搜索：通过工具注册表获取可用工具定义（配置了 searchApiKey 时 web_search 自动注册）
      const tools = getToolDefinitions(aiCfg);

      // 读取已保存的平台 Cookie，供 fetch_url 认证抓取需登录的页面（如洛谷题单）
      const toolCookies: PlatformCookies = {};
      for (const p of PLATFORMS) {
        const c = db.prepare('SELECT value FROM settings WHERE key = ?').get(`cookie.${p.id}`) as { value: string } | undefined;
        const csrf = db.prepare('SELECT value FROM settings WHERE key = ?').get(`csrf.${p.id}`) as { value: string } | undefined;
        if (c || csrf) {
          toolCookies[p.id] = {
            ...(c ? { cookie: c.value } : {}),
            ...(csrf ? { csrf: csrf.value } : {}),
          };
        }
      }
      const toolCtx: ToolContext = { cfg: aiCfg, cookies: toolCookies };

      const fullMsgs: ChatMessage[] = [
        { role: 'system', content: systemPrefix + system },
        ...trimmedMsgs,
      ];

      let finishReason: string | null = null;
      let pendingToolCalls: ToolCall[] | undefined;
      let usage: TokenUsage | undefined;

      // 第一轮流式（可能含 tool_calls / reasoning_content / usage）
      const stream = provider.chatStream(fullMsgs, {
        maxTokens,
        tools: tools.length > 0 ? tools : undefined,
        signal: abortController.signal,
        onFinish: (r, tc) => { finishReason = r; pendingToolCalls = tc; },
        onReasoning: (chunk) => {
          res.write(`data: ${JSON.stringify({ reasoning: chunk })}\n\n`);
        },
        onUsage: (u) => { usage = u; },
      });
      for await (const delta of stream) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }

      // 检测 tool_calls：通过工具注册表统一执行（不再硬编码 web_search 分支）
      console.error('[AI chat] 第一轮结束, finishReason=', finishReason, 'toolCalls=', pendingToolCalls?.length ?? 0);
      if (finishReason === 'tool_calls' && pendingToolCalls && pendingToolCalls.length > 0) {
        // 工具调用往返循环：AI 可能连续多次请求工具（第一轮搜了不够，想再搜一次）
        // 最多循环 MAX_TOOL_ROUNDS 轮防止无限循环；最后一轮强制收尾（见 MAX_TOOL_ROUNDS 注释）
        let roundMsgs: ChatMessage[] = [
          ...fullMsgs,
          { role: 'assistant', content: '', tool_calls: pendingToolCalls },
        ];
        let currentToolCalls: ToolCall[] | undefined = pendingToolCalls;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          // 用户已点「停止」：立即退出往返循环——不再执行队列里的工具、不再发起新一轮生成。
          // （此前循环内既不传 signal 也不检查 aborted，「停止」只对第一轮生效，
          // 之后每轮生成与工具调用照常跑完，白白烧配额。）
          if (abortController.signal.aborted) break;
          for (const tc of currentToolCalls!) {
            // 点停止后不再执行剩下的工具（web_search / fetch_url 单个就可能耗十几秒）
            if (abortController.signal.aborted) break;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch { /* 参数解析失败，传空对象 */ }

            // 通知前端正在执行工具。issue 36 现场：正文已经输出完、工具还在跑（检索/抓网页
            // 可能十几秒），前端只有「停止生成」一个状态，用户以为卡死就去点停止。
            // 因此这里把工具名与关键参数也发出去，前端据此显示「正在检索…」这类进度。
            const query = typeof args.query === 'string' ? args.query : '';
            const detail =
              typeof args.url === 'string' ? args.url : typeof args.problem === 'string' ? args.problem : '';
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ tool: { name: tc.function.name, detail } })}\n\n`);
              // 兼容既有前端事件（web_search 的检索词）
              if (query) {
                res.write(`data: ${JSON.stringify({ searching: true, query })}\n\n`);
              }
            }

            // 通过注册表执行工具。工具的业务失败走 result.content 的 error 文案；但
            // 网络层异常（undici「fetch failed」等）仍可能从工具内部抛出 —— 这里必须兜住：
            // 否则异常一路炸到外层 catch，整轮对话以「AI 调用失败：fetch failed」告终，
            // 而大模型本身毫无问题（2026-09-30 洛谷 C3VK 重定向循环实测）。转成 tool
            // 结果让 AI 据此降级（标注推断 / 换路径重试），对话继续。
            let result: ToolResult;
            try {
              result = await executeToolCall(tc.function.name, args, toolCtx);
            } catch (eTool) {
              console.error('[AI chat] 工具执行异常:', tc.function.name, describeError(eTool));
              result = {
                content:
                  `工具 ${tc.function.name} 执行失败：${describeError(eTool)}。` +
                  '没有工具结果佐证时，不要给出看似确定的结论，明确标注哪些是推断，或换一条路径重试。',
              };
            }

            // 工具元数据（如搜索来源）发给前端展示
            if (result.metadata && Array.isArray(result.metadata)) {
              res.write(`data: ${JSON.stringify({ sources: result.metadata })}\n\n`);
            }

            roundMsgs.push({ role: 'tool', content: result.content, tool_call_id: tc.id });
          }

          // 工具执行期间用户点了「停止」：立即收尾，绝不再发起新一轮生成。
          // 轮次顶部的检查只在每轮开始时生效、工具前检查只覆盖「下一个工具」，若停止恰好落在
          // **最后一个工具执行中**（web_search / fetch_url 单个就可能耗十几秒，正是用户最可能
          // 点停止的时刻），内层退出后控制流会带着**已 aborted** 的 signal 走到下面的 chatStream：
          // provider 只在 signal 上挂监听、不检查注册时是否已 abort，已 aborted 信号的监听器
          // 永不触发 → 照常发出完整一轮上游生成（白白烧配额）。抛 AbortError 交给外层
          // catch 的 aborted 分支收尾（res.end + return，不写错误事件）。
          if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          // 后续流式轮次：解析 DSML（AI 可能再次发起工具调用）
          finishReason = null;
          let nextToolCalls: ToolCall[] | undefined;
          // 最后一轮：注入「直接回答」提示并关闭 DSML 解析 —— 即使模型仍尝试发起
          // 工具调用也只当作噪音过滤（文本部分照常输出），保证一定有一条最终回答流
          const forcedFinal = round === MAX_TOOL_ROUNDS - 1;
          console.error('[AI chat] 轮次', round + 2, '开始, 消息数=', roundMsgs.length);
          try {
            const streamN = provider.chatStream(
              forcedFinal ? [...roundMsgs, { role: 'user', content: TOOL_ROUND_LIMIT_NOTICE }] : roundMsgs,
              {
                maxTokens,
                // 与第一轮同源的中断信号：点「停止」时在途的上游请求立即取消
                signal: abortController.signal,
                // 前 4 轮不传 tools：让 AI 基于搜索结果给出最终答案（DSML 泄漏仍可再发起工具）
                // 最后一轮连 DSML 解析也关闭，杜绝误触发，强制产出最终回答
                parseDsmlTools: !forcedFinal,
                onFinish: (r, tc) => { finishReason = r; nextToolCalls = tc; },
                onReasoning: (chunk) => {
                  if (!res.writableEnded) res.write(`data: ${JSON.stringify({ reasoning: chunk })}\n\n`);
                },
                onUsage: (u) => { usage = u; },
              },
            );
            for await (const delta of streamN) {
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch (eN) {
            // 用户点「停止」触发的中断：交给外层 catch 的 aborted 分支收尾（res.end + return），
            // 不能当「AI 调用失败」写错误事件
            if (abortController.signal.aborted) throw eN;
            const msg = describeError(eN);
            console.error('[AI chat] 轮次', round + 2, '失败:', msg);
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: `AI 调用失败：${msg}` })}\n\n`);
            }
            break;
          }

          console.error('[AI chat] 轮次', round + 2, '结束, finishReason=', finishReason, 'toolCalls=', nextToolCalls?.length ?? 0);

          // 强制收尾轮必然结束（DSML 解析已关，不会再有 tool_calls）
          if (forcedFinal) break;

          // 如果 AI 又发起了工具调用，继续往返；否则结束循环
          if (finishReason !== 'tool_calls' || !nextToolCalls || nextToolCalls.length === 0) {
            break;
          }

          // AI 再次发起工具调用：追加 assistant tool_calls 消息，继续循环
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: '', tool_calls: nextToolCalls },
          ];
          currentToolCalls = nextToolCalls;
        }
      }

      // finish_reason === 'length' 表示因 max_tokens 上限被截断，通知前端给出可操作提示
      if (finishReason === 'length') {
        res.write(`data: ${JSON.stringify({ truncated: true })}\n\n`);
      }
      // token 用量统计（在 [DONE] 前发送，前端展示消耗）
      if (usage) {
        res.write(`data: ${JSON.stringify({ usage })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      // 客户端中断：正常结束（前端已自行处理中断显示），不写错误事件
      if (abortController.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      // 流开始后出错：写一个错误事件让前端感知（headers 已发，不能再 JSON 502）
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: `AI 调用失败：${describeError(e)}` })}\n\n`);
        res.end();
      }
    }
  }));

  return r;
}

/** 题单上下文渲染：题单元信息 + 按分类分组的题目清单（供 AI 基于题单内容分析与建议） */
function renderListContext(db: Db, listId: number, userId: number): string {
  const list = db
    .prepare('SELECT id, title, source_url FROM problem_lists WHERE id = ? AND user_id = ?')
    .get(listId, userId) as { id: number; title: string; source_url: string | null } | undefined;
  if (!list) throw new Error('题单不存在');
  const items = db
    .prepare(
      `SELECT platform, problem_key, title, url, category
         FROM problem_list_items
        WHERE list_id = ?
        ORDER BY category, position, id`,
    )
    .all(listId) as Array<{
    platform: string;
    problem_key: string;
    title: string | null;
    url: string | null;
    category: string;
  }>;
  const byCategory = new Map<string, number>();
  for (const it of items) byCategory.set(it.category, (byCategory.get(it.category) ?? 0) + 1);
  const categoryLine = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}×${n}`)
    .join('、');
  return [
    `- 标题：${list.title}`,
    `- 来源：${list.source_url ?? '（手动整理）'}`,
    `- 共 ${items.length} 题${categoryLine ? `，分类：${categoryLine}` : ''}`,
    '',
    '| 平台 | 题号 | 标题 | 分类 | 链接 |',
    '| --- | --- | --- | --- | --- |',
    ...items.map(
      (it) =>
        `| ${it.platform} | ${it.problem_key} | ${it.title ?? ''} | ${it.category} | ${it.url ?? ''} |`,
    ),
  ].join('\n');
}

import { Router, raw } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { AiProvider, type ChatContentBlock, type ChatMessage, type ToolCall, type TokenUsage } from '../ai/provider.ts';
import { estimateTokens, trimContext, summarizeContext, SUMMARIZE_THRESHOLD } from '../ai/context.ts';
// 导入 search.ts 触发 web_search 工具注册（副作用导入，不需要直接使用导出）
import '../ai/search.ts';
// 导入 fetch-url.ts 触发 fetch_url 工具注册（副作用导入）
import '../ai/fetch-url.ts';
import { extractPdfText, truncatePdfText, isPdfContentType, isPdfFilename } from '../ai/pdf.ts';
import { convertDocument, isDocumentFile } from '../ai/docConverter.ts';
import { getToolDefinitions, executeToolCall, type ToolContext, type PlatformCookies } from '../ai/tools/registry.ts';
import { buildTemplateLibrarySummary } from '../ai/templateContext.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { buildPracticeSummary, renderSummaryForPrompt } from '../analysis/summary.ts';
import { effectiveAbility, renderAbilityEvidence, setAbilityOverride } from '../today/ability.ts';
import { renderPlanContext, renderTemplate, today } from '../plans/planService.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import { fetchAllContests, selectContests } from '../contests/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';

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
  opts: { createProvider?: () => Pick<AiProvider, 'chat' | 'chatStream' | 'enabled'> } = {},
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

  // POST /api/ai/chat  body: { messages, planId? }
  // 通用 AI 助手：注入练习数据汇总（含问题分布统计）+ 弱项画像 + 能力值；
  // planId 给定时附带计划上下文（支持 plan-modify 修改计划）。
  // user 消息可携带 attachments（Files API 上传后的 file_id 列表），服务端转换为
  // OpenAI 多模态内容块（file 引用 + 文本）后调用上游。
  r.post('/chat', asyncHandler(async (req, res) => {
    const { messages, planId } = req.body ?? {};
    const turns = Array.isArray(messages) ? (messages as IncomingTurn[]) : [];
    const BAD_MSGS = 'messages 必填：1-60 条 {role: user|assistant, content} 轮次';
    if (turns.length === 0 || turns.length > 60) {
      return res.status(400).json({ error: BAD_MSGS });
    }
    for (const m of turns) {
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
      // 文本不能为空；user 消息带附件时允许空文本（纯图片提问）
      if (m.content.trim() === '' && !(m.role === 'user' && Array.isArray(m.attachments))) {
        return res.status(400).json({ error: BAD_MSGS });
      }
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

    // 近 14 天赛事日历（赛事源各自有 30 分钟缓存，失败降级为空，不阻断对话）
    let upcomingContests = '（赛事数据暂不可用）';
    try {
      const { contests: all } = await fetchAllContests();
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

    const system = renderTemplate(ASSISTANT_PROMPT_TEMPLATE(), {
      summary: summaryPrompt,
      currentDate: today(),
      weakness: JSON.stringify(weakness.items),
      computedLevel: String(ability.computed),
      effectiveLevel: String(ability.effective),
      abilityOverrideNote: overrideNote,
      abilityEvidence: renderAbilityEvidence(db, DEFAULT_USER_ID, summary),
      planSection,
      upcomingContests,
      // 模板库写入（template-add 块）可选的课程分类清单，跟内置课程大纲保持同步
      templateCategories: CURRICULUM.map((c) => `${c.key}（${c.name}）`).join('、'),
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
    const { messages: trimmedMsgs, trimmed: trimmedCount } = trimContext(
      estimateTokens(system),
      normalized,
      contextWindow,
      maxTokens,
    );

    // 客户端中断传播：前端 AbortController.abort() → req aborted → 取消上游 AI 请求
    // 参考 opencode 的 Cancel + ctx.Done() 机制，避免用户停止后仍浪费 API 配额
    // 使用 req.on('aborted') 而非 res.on('close') / req.on('close')：
    // - req.on('aborted') 仅在客户端主动断开连接时触发（正常完成不会触发）
    // - res.on('close') / req.on('close') 在连接关闭的任何情况下都会触发，
    //   包括工具执行期间的网络波动，可能在两轮流式之间误触发导致第二轮被中断
    const abortController = new AbortController();
    req.on('aborted', () => {
      if (!res.writableEnded) abortController.abort();
    });

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
        // 最多循环 5 轮防止无限循环
        let roundMsgs: ChatMessage[] = [
          ...fullMsgs,
          { role: 'assistant', content: '', tool_calls: pendingToolCalls },
        ];
        let currentToolCalls: ToolCall[] | undefined = pendingToolCalls;

        for (let round = 0; round < 5; round++) {
          for (const tc of currentToolCalls!) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch { /* 参数解析失败，传空对象 */ }

            // 通知前端正在执行工具
            const query = typeof args.query === 'string' ? args.query : '';
            if (query) {
              res.write(`data: ${JSON.stringify({ searching: true, query })}\n\n`);
            }

            // 通过注册表执行工具
            const result = await executeToolCall(tc.function.name, args, toolCtx);

            // 工具元数据（如搜索来源）发给前端展示
            if (result.metadata && Array.isArray(result.metadata)) {
              res.write(`data: ${JSON.stringify({ sources: result.metadata })}\n\n`);
            }

            roundMsgs.push({ role: 'tool', content: result.content, tool_call_id: tc.id });
          }

          // 后续流式轮次：解析 DSML（AI 可能再次发起工具调用）
          finishReason = null;
          let nextToolCalls: ToolCall[] | undefined;
          console.error('[AI chat] 轮次', round + 2, '开始, 消息数=', roundMsgs.length);
          try {
            const streamN = provider.chatStream(roundMsgs, {
              maxTokens,
              // 不传 tools：让 AI 基于搜索结果给出最终答案
              // 仍然解析 DSML：AI 可能通过 DSML 再次发起工具调用，需要检测并继续往返
              parseDsmlTools: true,
              onFinish: (r, tc) => { finishReason = r; nextToolCalls = tc; },
              onReasoning: (chunk) => {
                if (!res.writableEnded) res.write(`data: ${JSON.stringify({ reasoning: chunk })}\n\n`);
              },
              onUsage: (u) => { usage = u; },
            });
            for await (const delta of streamN) {
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch (eN) {
            const msg = (eN as Error).message || String(eN);
            console.error('[AI chat] 轮次', round + 2, '失败:', msg);
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: `AI 调用失败：${msg}` })}\n\n`);
            }
            break;
          }

          console.error('[AI chat] 轮次', round + 2, '结束, finishReason=', finishReason, 'toolCalls=', nextToolCalls?.length ?? 0);

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
        res.write(`data: ${JSON.stringify({ error: `AI 调用失败：${(e as Error).message}` })}\n\n`);
        res.end();
      }
    }
  }));

  return r;
}

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { AiProvider, type ChatMessage, type ToolCall } from '../ai/provider.ts';
import { estimateTokens, trimContext } from '../ai/context.ts';
import { WEB_SEARCH_TOOL, executeWebSearch, formatSearchResults } from '../ai/search.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { buildPracticeSummary, renderSummaryForPrompt } from '../analysis/summary.ts';
import { effectiveAbility, renderAbilityEvidence, setAbilityOverride } from '../today/ability.ts';
import { renderPlanContext, renderTemplate } from '../plans/planService.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import { fetchAllContests, selectContests } from '../contests/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // POST /api/ai/chat  body: { messages, planId? }
  // 通用 AI 助手：注入练习数据汇总（含问题分布统计）+ 弱项画像 + 能力值；
  // planId 给定时附带计划上下文（支持 plan-modify 修改计划）。
  r.post('/chat', asyncHandler(async (req, res) => {
    const { messages, planId } = req.body ?? {};
    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > 60 ||
      !messages.every(
        (m: unknown) =>
          typeof m === 'object' &&
          m !== null &&
          ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim() !== '',
      )
    ) {
      return res.status(400).json({ error: 'messages 必填：1-60 条 {role: user|assistant, content} 轮次' });
    }
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
      weakness: JSON.stringify(weakness.items),
      computedLevel: String(ability.computed),
      effectiveLevel: String(ability.effective),
      abilityOverrideNote: overrideNote,
      abilityEvidence: renderAbilityEvidence(db, DEFAULT_USER_ID, summary),
      planSection,
      upcomingContests,
      // 模板库写入（template-add 块）可选的课程分类清单，跟内置课程大纲保持同步
      templateCategories: CURRICULUM.map((c) => `${c.key}（${c.name}）`).join('、'),
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
    const maxTokens = aiCfg.maxTokens ?? 8192;
    const contextWindow = aiCfg.contextWindow ?? 131072;
    const { messages: trimmedMsgs, trimmed: trimmedCount } = trimContext(
      estimateTokens(system),
      messages as ChatMessage[],
      contextWindow,
      maxTokens,
    );

    try {
      // 裁剪发生时先发一个提示事件（在 delta 之前，前端可即时感知）
      if (trimmedCount > 0) {
        res.write(`data: ${JSON.stringify({ contextTrimmed: trimmedCount })}\n\n`);
      }

      // 联网搜索：配置了 searchApiKey 时向 AI 暴露 web_search 工具
      const searchEnabled = !!(aiCfg.searchApiKey?.trim());
      const tools = searchEnabled ? [WEB_SEARCH_TOOL] : undefined;
      const fullMsgs: ChatMessage[] = [{ role: 'system', content: system }, ...trimmedMsgs];

      let finishReason: string | null = null;
      let pendingToolCalls: ToolCall[] | undefined;

      // 第一轮流式（可能含 tool_calls）
      const stream = provider.chatStream(fullMsgs, {
        maxTokens,
        tools,
        onFinish: (r, tc) => { finishReason = r; pendingToolCalls = tc; },
      });
      for await (const delta of stream) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }

      // 检测 tool_calls：AI 请求搜索 → 执行搜索 → 二次请求带结果继续流式输出
      if (finishReason === 'tool_calls' && pendingToolCalls && pendingToolCalls.length > 0) {
        // 追加 assistant 的 tool_calls 消息 + 各工具的结果消息
        const secondRoundMsgs: ChatMessage[] = [
          ...fullMsgs,
          { role: 'assistant', content: '', tool_calls: pendingToolCalls },
        ];

        for (const tc of pendingToolCalls) {
          if (tc.function.name === 'web_search') {
            let query = '';
            try {
              query = (JSON.parse(tc.function.arguments) as { query?: string }).query ?? '';
            } catch { /* 参数解析失败 */ }

            // 通知前端正在搜索
            res.write(`data: ${JSON.stringify({ searching: true, query })}\n\n`);

            const results = await executeWebSearch(query, aiCfg);
            const formatted = formatSearchResults(query, results);

            // 通知前端搜索来源（前端可展示引用链接）
            if (results.length > 0) {
              res.write(`data: ${JSON.stringify({ sources: results.map((r) => ({ title: r.title, url: r.url })) })}\n\n`);
            }

            secondRoundMsgs.push({ role: 'tool', content: formatted, tool_call_id: tc.id });
          } else {
            // 未知工具：返回错误提示让 AI 自行处理
            secondRoundMsgs.push({
              role: 'tool',
              content: `工具 ${tc.function.name} 不可用`,
              tool_call_id: tc.id,
            });
          }
        }

        // 二轮流式：带工具结果，不再传 tools（AI 直接给出最终答案）
        finishReason = null;
        const stream2 = provider.chatStream(secondRoundMsgs, {
          maxTokens,
          onFinish: (r) => { finishReason = r; },
        });
        for await (const delta of stream2) {
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      }

      // finish_reason === 'length' 表示因 max_tokens 上限被截断，通知前端给出可操作提示
      if (finishReason === 'length') {
        res.write(`data: ${JSON.stringify({ truncated: true })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      // 流开始后出错：写一个错误事件让前端感知（headers 已发，不能再 JSON 502）
      res.write(`data: ${JSON.stringify({ error: `AI 调用失败：${(e as Error).message}` })}\n\n`);
      res.end();
    }
  }));

  return r;
}

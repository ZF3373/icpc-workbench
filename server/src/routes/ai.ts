import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { AiProvider, type ChatMessage } from '../ai/provider.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { buildPracticeSummary, renderSummaryForPrompt } from '../analysis/summary.ts';
import { effectiveAbility, renderAbilityEvidence, setAbilityOverride } from '../today/ability.ts';
import { renderPlanContext, renderTemplate } from '../plans/planService.ts';

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
  opts: { createProvider?: () => Pick<AiProvider, 'chat' | 'enabled'> } = {},
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
      ? `（AI 曾调整为 ${ability.override.level}，理由：${ability.override.reason ?? '未记录'}）`
      : '（无 AI 调整记录）';

    let planSection = '（未关联训练计划：plan-modify 能力不可用；用户提到改计划时请引导其先在本页右上角下拉关联训练计划）';
    if (Number.isInteger(planId)) {
      try {
        planSection = `## 关联的训练计划\n${renderPlanContext(db, Number(planId), DEFAULT_USER_ID)}`;
      } catch {
        planSection = '（关联的训练计划不存在）';
      }
    }

    const system = renderTemplate(ASSISTANT_PROMPT_TEMPLATE(), {
      summary: summaryPrompt,
      weakness: JSON.stringify(weakness.items),
      computedLevel: String(ability.computed),
      effectiveLevel: String(ability.effective),
      abilityOverrideNote: overrideNote,
      abilityEvidence: renderAbilityEvidence(db, DEFAULT_USER_ID, summary),
      planSection,
    });
    try {
      const reply = await provider.chat([{ role: 'system', content: system }, ...messages], { maxTokens: 8000 });
      res.json({ reply });
    } catch (e) {
      res.status(502).json({ error: `AI 调用失败：${(e as Error).message}` });
    }
  }));

  return r;
}

import { Router } from 'express';
import { DEFAULT_USER_ID } from '../constants.ts';
import type { Db } from '../db/index.ts';
import {
  isValidContestKey,
  NOTE_MAX_LENGTH,
  problemNoteKey,
  problemNoteSummaries,
  readContestNote,
  readProblemNote,
  writeContestNote,
  writeProblemNote,
} from '../notes/store.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';

/**
 * 题目 / 比赛 的独立笔记（issue #71）。
 *
 * 接口形状刻意做成「按需读写一条」：
 * - GET/PUT /api/notes/problem/:platform/:problemKey
 * - GET/PUT /api/notes/contest/:contestKey
 * - POST  /api/notes/summaries  （批量取摘要，题目列表行角标用）
 *
 * 定位一律走「题目身份」而不是题目行 id：同一道题在库里可能有多行（洛谷 CF 镜像、
 * VJudge 转发），按行 id 记会记到一半的入口上，用户换个入口就找不到笔记了。
 */

const NOTE_TEXT_TYPE = 'text';

function parseText(body: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: '请求体需为对象' };
  const text = (body as Record<string, unknown>)[NOTE_TEXT_TYPE];
  if (typeof text !== 'string') return { ok: false, error: 'text 需为字符串' };
  if (Array.from(text).length > NOTE_MAX_LENGTH) {
    return { ok: false, error: `笔记长度上限 ${NOTE_MAX_LENGTH} 字符` };
  }
  return { ok: true, text };
}

function toResponse(identity: string, rec: { text: string; updatedAt: string; createdAt: string }) {
  return {
    identity,
    text: rec.text,
    /** 空正文 = 没有笔记（前端据此决定是否渲染入口/角标） */
    hasNote: rec.text.trim().length > 0,
    createdAt: rec.createdAt || null,
    updatedAt: rec.updatedAt || null,
  };
}

export function notesRoutes(db: Db): Router {
  const r = Router();

  /**
   * GET /api/notes/problem/:platform/:problemKey
   * 没写过也返回 200 + 空正文：「没写过」是常态，用 404 会让每个入口都要处理一次错误。
   */
  r.get('/problem/:platform/:problemKey', (req, res) => {
    const { platform, problemKey } = req.params;
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    if (!problemKey || problemKey.length > 200) {
      return res.status(400).json({ error: 'problemKey 非法' });
    }
    const identity = problemNoteKey(platform, problemKey);
    res.json(toResponse(identity, readProblemNote(db, DEFAULT_USER_ID, identity)));
  });

  /**
   * PUT /api/notes/problem/:platform/:problemKey  body: { text }
   * text 空白 = 删除这条笔记（不留空行占位，避免「有笔记」角标误报）。
   */
  r.put('/problem/:platform/:problemKey', (req, res) => {
    const { platform, problemKey } = req.params;
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    if (!problemKey || problemKey.length > 200) {
      return res.status(400).json({ error: 'problemKey 非法' });
    }
    const parsed = parseText(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const identity = problemNoteKey(platform, problemKey);
    res.json(toResponse(identity, writeProblemNote(db, DEFAULT_USER_ID, identity, parsed.text)));
  });

  /** GET /api/notes/contest/:contestKey（contestKey 形如 codeforces:1877） */
  r.get('/contest/:contestKey', (req, res) => {
    const key = req.params.contestKey;
    if (!isValidContestKey(key)) return res.status(400).json({ error: 'contestKey 非法（应形如 codeforces:1877）' });
    res.json(toResponse(key, readContestNote(db, DEFAULT_USER_ID, key)));
  });

  /** PUT /api/notes/contest/:contestKey  body: { text } */
  r.put('/contest/:contestKey', (req, res) => {
    const key = req.params.contestKey;
    if (!isValidContestKey(key)) return res.status(400).json({ error: 'contestKey 非法（应形如 codeforces:1877）' });
    const parsed = parseText(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    res.json(toResponse(key, writeContestNote(db, DEFAULT_USER_ID, key, parsed.text)));
  });

  /**
   * POST /api/notes/summaries  body: { problems?: [{platform, problemKey}], contests?: [contestKey] }
   * 批量取摘要：题目列表 / 写题历史 / 赛事中心的行角标用。只回「有笔记」的那些键，
   * 前端拿到的是 Record<key, {summary, updatedAt}>，缺键即无笔记（不占带宽）。
   */
  r.post('/summaries', (req, res) => {
    const body = (req.body ?? {}) as { problems?: unknown; contests?: unknown };
    const problems = Array.isArray(body.problems) ? body.problems : [];
    const contests = Array.isArray(body.contests) ? body.contests : [];

    const identities: string[] = [];
    for (const item of problems) {
      if (!item || typeof item !== 'object') continue;
      const { platform, problemKey } = item as Record<string, unknown>;
      if (typeof platform !== 'string' || typeof problemKey !== 'string') continue;
      if (!PLATFORMS.some((p) => p.id === platform) || !problemKey || problemKey.length > 200) continue;
      identities.push(problemNoteKey(platform, problemKey));
    }
    if (identities.length > 1000) return res.status(400).json({ error: 'problems 一次最多 1000 条' });

    const summaries = problemNoteSummaries(db, DEFAULT_USER_ID, identities);
    const out: Record<string, { summary: string; updatedAt: string }> = {};
    for (const [key, value] of summaries) out[key] = { summary: value.summary, updatedAt: value.updatedAt };

    const contestOut: Record<string, { summary: string; updatedAt: string }> = {};
    for (const key of contests.slice(0, 200)) {
      if (!isValidContestKey(key)) continue;
      const rec = readContestNote(db, DEFAULT_USER_ID, key);
      if (rec.text.trim() === '') continue;
      contestOut[key] = {
        summary: rec.text.trim().split(/\r?\n/).find((line) => line.trim() !== '')?.slice(0, 80) ?? '',
        updatedAt: rec.updatedAt,
      };
    }
    res.json({ problems: out, contests: contestOut });
  });

  return r;
}

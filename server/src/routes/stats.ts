import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { computeOverall } from '../analysis/stats.ts';
import { computeTrend } from '../analysis/trend.ts';
import { computeHeatmap } from '../analysis/heatmap.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { computeMastery } from '../analysis/mastery.ts';
import { buildPracticeSummary } from '../analysis/summary.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

/** 账号/平台作用域（多账号统计隔离）：省略 = 全部账号，与单账号用户行为一致 */
interface Scope {
  platform?: PlatformId;
  account?: string;
}

export function statsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/stats?from=&to=&platform=&account=
  r.get('/', (req, res) => {
    const scope = parseScope(req.query, res);
    if (!scope) return;
    const { from, to } = req.query;
    res.json(computeOverall(db, DEFAULT_USER_ID, { from: str(from), to: str(to), ...scope }));
  });

  // GET /api/stats/weakness?minAttempts=&topN=&platform=&account=
  r.get('/weakness', (req, res) => {
    const scope = parseScope(req.query, res);
    if (!scope) return;
    const minAttempts = num(req.query.minAttempts, 5, 1, 1000);
    const topN = num(req.query.topN, 10, 1, 100);
    res.json(computeWeakness(db, DEFAULT_USER_ID, { minAttempts, topN, ...scope }));
  });

  // GET /api/stats/trend?weeks=&platform=&account=
  r.get('/trend', (req, res) => {
    const scope = parseScope(req.query, res);
    if (!scope) return;
    const weeks = num(req.query.weeks, 12, 1, 52);
    res.json(computeTrend(db, DEFAULT_USER_ID, weeks, new Date(), scope));
  });

  // GET /api/stats/heatmap?days=&platform=&account=  → 近 N 天逐日刷题热力（格子 = AC 去重题数）
  r.get('/heatmap', (req, res) => {
    const scope = parseScope(req.query, res);
    if (!scope) return;
    const days = num(req.query.days, 365, 1, 3650);
    res.json(computeHeatmap(db, DEFAULT_USER_ID, { days, ...scope }));
  });

  // GET /api/stats/mastery?minSolved=&platform=&account=  → 知识点掌握度地图（刷题数据 × 模板课程联动）
  r.get('/mastery', (req, res) => {
    const scope = parseScope(req.query, res);
    if (!scope) return;
    const minSolved = num(req.query.minSolved, 0, 0, 1000);
    res.json(computeMastery(db, DEFAULT_USER_ID, { minSolved, ...scope }));
  });

  // GET /api/stats/summary → 完整个人练习数据汇总（JSON：总量/平台/难度/标签/弱项/掌握度/趋势/近期 AC/卡壳题/复习库/课程进度/打卡）
  r.get('/summary', (_req, res) => {
    res.json(buildPracticeSummary(db, DEFAULT_USER_ID));
  });

  // GET /api/stats/accounts → 库内有提交记录的账号（供前端账号切换器；不含无归属账号的手动导入行）
  r.get('/accounts', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT s.platform AS platform, s.account AS account,
                COUNT(*) AS attempts,
                SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END) AS ac,
                COUNT(DISTINCT CASE WHEN s.verdict = 'AC' THEN p.problem_key END) AS solved,
                MAX(s.submitted_at) AS lastSubmittedAt
           FROM submissions s JOIN problems p ON p.id = s.problem_id
          WHERE s.user_id = ? AND s.account <> ''
          GROUP BY s.platform, s.account
          ORDER BY s.platform, lastSubmittedAt DESC`,
      )
      .all(DEFAULT_USER_ID) as unknown as Array<{
      platform: PlatformId;
      account: string;
      attempts: number;
      ac: number;
      solved: number;
      lastSubmittedAt: string;
    }>;
    res.json(rows);
  });

  return r;
}

/**
 * 解析 platform/account 作用域入参；非法时已经写了 400 响应，返回 undefined 让调用方直接 return。
 * account 只在平台内唯一（platform_accounts 的键是 user_id+platform+handle），
 * 只带 account 不带 platform 会把洛谷/牛客撞车的数字 uid 静默合并，所以明确拒绝。
 */
function parseScope(query: Record<string, unknown>, res: import('express').Response): Scope | undefined {
  const platform = str(query.platform);
  const account = str(query.account);
  if (platform && !PLATFORMS.some((p) => p.id === platform)) {
    res.status(400).json({ error: `platform 非法: ${platform}` });
    return undefined;
  }
  if (account && !platform) {
    res.status(400).json({ error: 'account 过滤必须同时指定 platform（handle 只在平台内唯一）' });
    return undefined;
  }
  const scope: Scope = {};
  if (platform) scope.platform = platform as PlatformId;
  if (account) scope.account = account;
  return scope;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

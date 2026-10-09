import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { buildPlanPackage, isCalendarDate, today } from '../plans/planService.ts';
import { buildPracticeSummary, renderSummaryMarkdown } from '../analysis/summary.ts';

export function exportRoutes(db: Db): Router {
  const r = Router();

  // 每天任务数（1-6）；缺省 = 提示词默认 1-3
  const dailyTasksParam = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 6 ? n : undefined;
  };

  /**
   * startDate 必须校验：buildPlanPackage 会把它**原样拼进提示词**
   * （"计划从 <startDate> 开始，共 N 天"），非法值会被当成有效日期交给 AI 排期。
   * 校验口径与 savePlan / /api/plans/import 一致（真实存在的 YYYY-MM-DD）。
   */
  const startDateParam = (v: unknown): string | { error: string } => {
    if (v === undefined || v === '') return today();
    if (typeof v !== 'string' || !isCalendarDate(v)) {
      return { error: 'startDate 日期非法（需为真实存在的 YYYY-MM-DD）' };
    }
    return v;
  };

  // GET /api/export/plan-package?days=&startDate=&dailyTasks= → 数据包（profile/trend/problems/prompt）
  r.get('/plan-package', (req, res) => {
    const days = num(req.query.days, 14, 1, 90);
    const sd = startDateParam(req.query.startDate);
    if (typeof sd !== 'string') return res.status(400).json(sd);
    res.json(buildPlanPackage(db, DEFAULT_USER_ID, { days, startDate: sd, dailyTasks: dailyTasksParam(req.query.dailyTasks) }));
  });

  // GET /api/export/plan-prompt.md?days=&startDate=&dailyTasks= → 渲染好的提示词（可下载喂给任意 AI）
  r.get('/plan-prompt.md', (req, res) => {
    const days = num(req.query.days, 14, 1, 90);
    const sd = startDateParam(req.query.startDate);
    if (typeof sd !== 'string') return res.status(400).json(sd);
    const pkg = buildPlanPackage(db, DEFAULT_USER_ID, { days, startDate: sd, dailyTasks: dailyTasksParam(req.query.dailyTasks) });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="plan-prompt.md"');
    res.send(pkg.prompt);
  });

  // GET /api/export/summary.md → 完整个人练习数据汇总（独立下载，可喂给任意 AI 或存档复盘）
  r.get('/summary.md', (_req, res) => {
    const md = renderSummaryMarkdown(buildPracticeSummary(db, DEFAULT_USER_ID));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="practice-summary.md"');
    res.send(md);
  });

  return r;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

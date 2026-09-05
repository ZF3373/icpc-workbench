import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { buildPlanPackage, today } from '../plans/planService.ts';
import { buildPracticeSummary, renderSummaryMarkdown } from '../analysis/summary.ts';

export function exportRoutes(db: Db): Router {
  const r = Router();

  // GET /api/export/plan-package?days=&startDate= → 数据包（profile/trend/problems/prompt）
  r.get('/plan-package', (req, res) => {
    const days = num(req.query.days, 14, 1, 90);
    const startDate = str(req.query.startDate) ?? today();
    res.json(buildPlanPackage(db, DEFAULT_USER_ID, { days, startDate }));
  });

  // GET /api/export/plan-prompt.md?days=&startDate= → 渲染好的提示词（可下载喂给任意 AI）
  r.get('/plan-prompt.md', (req, res) => {
    const days = num(req.query.days, 14, 1, 90);
    const startDate = str(req.query.startDate) ?? today();
    const pkg = buildPlanPackage(db, DEFAULT_USER_ID, { days, startDate });
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

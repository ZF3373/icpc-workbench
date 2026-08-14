import { Router } from 'express';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { generatePlan } from '../plans/planService.ts';

export function plansRoutes(db: Db, getAiConfig: () => AiConfig): Router {
  const r = Router();

  // POST /api/plans/generate  body: { days?, startDate? }
  r.post('/generate', async (req, res) => {
    const { days, startDate } = req.body ?? {};
    try {
      const result = await generatePlan(db, getAiConfig(), {
        days: Number(days) || 14,
        startDate: typeof startDate === 'string' && startDate ? startDate : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // GET /api/plans → 计划列表（含任务数/打卡数）
  r.get('/', (_req, res) => {
    const plans = db
      .prepare(
        `SELECT p.id, p.title, p.goal, p.start_date, p.end_date, p.source, p.created_at,
                (SELECT COUNT(*) FROM plan_tasks t WHERE t.plan_id = p.id) AS task_count,
                (SELECT COUNT(*) FROM checkins c
                   JOIN plan_tasks t ON c.task_id = t.id
                  WHERE t.plan_id = p.id) AS checked_count
           FROM plans p
          WHERE p.user_id = ?
          ORDER BY p.created_at DESC`,
      )
      .all(DEFAULT_USER_ID);
    res.json(plans);
  });

  // GET /api/plans/:id → 计划详情（任务 + 打卡状态 + 题目链接）
  r.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const plan = db
      .prepare('SELECT * FROM plans WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as Record<string, unknown> | undefined;
    if (!plan) return res.status(404).json({ error: '计划不存在' });
    const tasks = db
      .prepare(
        `SELECT t.id, t.task_date, t.title, t.kind, t.url, t.note,
                p.platform, p.problem_key, p.title AS problem_title, p.url AS problem_url,
                (SELECT 1 FROM checkins c WHERE c.task_id = t.id) AS checked
           FROM plan_tasks t
           LEFT JOIN problems p ON t.problem_id = p.id
          WHERE t.plan_id = ?
          ORDER BY t.task_date, t.id`,
      )
      .all(id);
    res.json({ ...plan, tasks });
  });

  // DELETE /api/plans/:id → 删除计划（plan_tasks 与 checkins 由外键级联删除）
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'id 非法' });
    }
    const result = db
      .prepare('DELETE FROM plans WHERE id = ? AND user_id = ?')
      .run(id, DEFAULT_USER_ID);
    if (result.changes === 0) {
      return res.status(404).json({ error: '计划不存在' });
    }
    res.json({ ok: true });
  });

  return r;
}

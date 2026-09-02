import { Router } from 'express';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { generatePlan, parsePlanJson, savePlan, TASK_KINDS, today } from '../plans/planService.ts';

export function plansRoutes(db: Db, getAiConfig: () => AiConfig): Router {
  const r = Router();

  // POST /api/plans/generate  body: { days?, startDate? }
  r.post('/generate', asyncHandler(async (req, res) => {
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
  }));

  // POST /api/plans/import  body: { raw, startDate?, days? }
  // 「导出提示词 → 手动喂给任意 AI」通道的导入入口：raw 为 AI 返回的完整文本
  // （容忍围栏/前后解释文字），解析入库为 source=ai 的计划；任务缺链接自动按题库回退补链。
  r.post('/import', (req, res) => {
    const { raw, startDate, days } = req.body ?? {};
    if (typeof raw !== 'string' || raw.trim() === '') {
      return res.status(400).json({ error: 'raw 必填：粘贴 AI 返回的计划 JSON 文本' });
    }
    const sd = typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
      ? startDate
      : today();
    const d = Number.isInteger(days) && days! > 0 && days! <= 90 ? days! : 14;
    try {
      const parsed = parsePlanJson(raw, sd, d);
      const planId = savePlan(db, DEFAULT_USER_ID, parsed, 'ai', raw);
      const plan = db.prepare('SELECT title FROM plans WHERE id = ?').get(planId) as { title: string };
      res.json({ ok: true, planId, title: plan.title, taskCount: parsed.tasks.length });
    } catch (e) {
      res.status(400).json({ error: `导入失败：${(e as Error).message}` });
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

  // PATCH /api/plans/tasks/:taskId → 编辑单条任务（仅更新提交的字段；url/note 传 null 可清空）
  r.patch('/tasks/:taskId', (req, res) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(taskId)) {
      return res.status(400).json({ error: 'taskId 非法' });
    }
    const task = db
      .prepare(
        `SELECT t.id FROM plan_tasks t JOIN plans p ON p.id = t.plan_id
          WHERE t.id = ? AND p.user_id = ?`,
      )
      .get(taskId, DEFAULT_USER_ID) as { id: number } | undefined;
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if ('taskDate' in body) {
      const d = body.taskDate;
      if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).json({ error: 'taskDate 格式需为 YYYY-MM-DD' });
      }
      sets.push('task_date = ?');
      args.push(d);
    }
    if ('title' in body) {
      const t = body.title;
      if (typeof t !== 'string' || !t.trim()) {
        return res.status(400).json({ error: 'title 不能为空' });
      }
      sets.push('title = ?');
      args.push(t.trim());
    }
    if ('kind' in body) {
      const k = body.kind;
      if (typeof k !== 'string' || !(TASK_KINDS as readonly string[]).includes(k)) {
        return res.status(400).json({ error: `kind 非法，需为 ${TASK_KINDS.join(' / ')}` });
      }
      sets.push('kind = ?');
      args.push(k);
    }
    for (const field of ['url', 'note'] as const) {
      if (field in body) {
        const v = body[field];
        if (v !== null && typeof v !== 'string') {
          return res.status(400).json({ error: `${field} 需为字符串或 null` });
        }
        sets.push(`${field} = ?`);
        args.push(v?.trim() ? v.trim() : null);
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: '没有可更新字段（taskDate/title/kind/url/note）' });
    }
    args.push(taskId);
    try {
      db.prepare(`UPDATE plan_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    } catch (e) {
      // UNIQUE(plan_id, task_date, title) 冲突时给出友好提示
      if (String((e as Error).message).includes('UNIQUE')) {
        return res.status(400).json({ error: '同一天已存在同名任务' });
      }
      throw e;
    }
    res.json({ ok: true });
  });

  // DELETE /api/plans/tasks/:taskId → 删除单条任务（打卡记录由外键级联删除）
  r.delete('/tasks/:taskId', (req, res) => {
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(taskId)) {
      return res.status(400).json({ error: 'taskId 非法' });
    }
    const result = db
      .prepare(
        `DELETE FROM plan_tasks WHERE id = ?
          AND plan_id IN (SELECT id FROM plans WHERE user_id = ?)`,
      )
      .run(taskId, DEFAULT_USER_ID);
    if (result.changes === 0) {
      return res.status(404).json({ error: '任务不存在' });
    }
    res.json({ ok: true });
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

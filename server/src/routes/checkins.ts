import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

export interface StreakInfo {
  current: number;
  longest: number;
  totalDays: number;
}

function toDate(str: string): number {
  return Number(new Date(`${str}T00:00:00Z`).getTime() / 86_400_000) | 0;
}

/** 由已打卡日期集合（YYYY-MM-DD 升序去重）计算连续打卡：current 从今天（或昨天）往前数，longest 为历史最长。 */
export function computeStreak(dates: string[], todayStr: string): StreakInfo {
  const days = [...new Set(dates)].map(toDate).sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0, totalDays: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    run = days[i] - days[i - 1] === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const today = toDate(todayStr);
  const set = new Set(days);
  let cursor = set.has(today) ? today : today - 1; // 今天尚未打卡不打断连续（以昨天为终点）
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor -= 1;
  }
  return { current, longest, totalDays: days.length };
}

export function checkinsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/checkins/streak → 连续打卡统计（桌面挂件亦可用）
  r.get('/streak', (_req, res) => {
    const rows = db
      .prepare('SELECT DISTINCT task_date FROM checkins WHERE user_id = ? ORDER BY task_date')
      .all(DEFAULT_USER_ID) as Array<{ task_date: string }>;
    const todayStr = new Date().toISOString().slice(0, 10);
    res.json(computeStreak(rows.map((r2) => r2.task_date), todayStr));
  });

  // GET /api/checkins?month=YYYY-MM → 月视图 [{ date, total, checked }]
  r.get('/', (req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month 格式需为 YYYY-MM' });
    }
    const rows = db
      .prepare(
        `SELECT task_date AS date, COUNT(*) AS total,
                COALESCE(SUM((SELECT 1 FROM checkins c WHERE c.task_id = t.id)), 0) AS checked
           FROM plan_tasks t
          WHERE t.task_date LIKE ?
          GROUP BY t.task_date`,
      )
      .all(`${month}%`) as unknown as Array<{ date: string; total: number; checked: number }>;
    res.json(rows);
  });

  // GET /api/checkins/date/:date → 当天任务（含打卡状态与跳转链接）
  r.get('/date/:date', (req, res) => {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date 格式需为 YYYY-MM-DD' });
    }
    const tasks = db
      .prepare(
        `SELECT t.id, t.task_date, t.title, t.kind, t.url, t.note,
                p.platform, p.problem_key, p.title AS problem_title, p.url AS problem_url,
                (SELECT 1 FROM checkins c WHERE c.task_id = t.id) AS checked
           FROM plan_tasks t
           LEFT JOIN problems p ON t.problem_id = p.id
          WHERE t.task_date = ?
          ORDER BY t.id`,
      )
      .all(date);
    res.json(tasks);
  });

  // POST /api/checkins  body: { taskId } → 打卡
  r.post('/', (req, res) => {
    const taskId = Number(req.body?.taskId);
    if (!Number.isInteger(taskId)) {
      return res.status(400).json({ error: 'taskId 必填' });
    }
    const task = db.prepare('SELECT id, task_date FROM plan_tasks WHERE id = ?').get(taskId) as
      | { id: number; task_date: string }
      | undefined;
    if (!task) return res.status(404).json({ error: '任务不存在' });
    db.prepare(
      'INSERT OR IGNORE INTO checkins (user_id, task_id, task_date) VALUES (?, ?, ?)',
    ).run(DEFAULT_USER_ID, taskId, task.task_date);
    res.json({ ok: true });
  });

  // DELETE /api/checkins/:taskId → 取消打卡
  r.delete('/:taskId', (req, res) => {
    const taskId = Number(req.params.taskId);
    db.prepare('DELETE FROM checkins WHERE task_id = ? AND user_id = ?').run(
      taskId,
      DEFAULT_USER_ID,
    );
    res.json({ ok: true });
  });

  return r;
}

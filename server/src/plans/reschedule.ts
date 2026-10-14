import type { Db } from '../db/index.ts';
import { dateAfterDays } from '../reviews/schedule.ts';
import { isCalendarDate } from './planService.ts';

export interface RescheduleOptions {
  days: number;
  skipWeekends?: boolean;
  dailyLimit?: number;
}

/** 只调整未完成练习/专题；固定比赛、复习及已完成任务保持原日期。 */
export function reschedulePlan(db: Db, userId: number, planId: number, opts: RescheduleOptions): { shifted: number; endDate: string } {
  if (!Number.isInteger(opts.days) || opts.days < 0 || opts.days > 30) throw new Error('顺延天数需为 0–30 的整数');
  if (opts.skipWeekends !== undefined && typeof opts.skipWeekends !== 'boolean') throw new Error('避开周末需为布尔值');
  if (opts.dailyLimit !== undefined && (!Number.isInteger(opts.dailyLimit) || opts.dailyLimit < 1 || opts.dailyLimit > 6)) throw new Error('每日任务上限需为 1–6 的整数');
  const plan = db.prepare('SELECT end_date FROM plans WHERE id = ? AND user_id = ?').get(planId, userId) as { end_date: string } | undefined;
  if (!plan) throw new Error('计划不存在');
  const tasks = db.prepare(`SELECT t.id, t.task_date, t.title, t.kind,
    EXISTS (SELECT 1 FROM checkins c WHERE c.task_id = t.id) AS checked
    FROM plan_tasks t WHERE t.plan_id = ? ORDER BY t.task_date, t.id`).all(planId) as Array<{ id: number; task_date: string; title: string; kind: string; checked: number }>;
  const movable = tasks.filter((t) => !t.checked && (t.kind === 'practice' || t.kind === 'topic'));
  const movingIds = new Set(movable.map((t) => t.id));
  const occupied = new Set<string>();
  const load = new Map<string, number>();
  for (const t of tasks.filter((t) => !movingIds.has(t.id))) {
    occupied.add(JSON.stringify([t.task_date, t.title]));
    load.set(t.task_date, (load.get(t.task_date) ?? 0) + 1);
  }
  const changes: Array<{ id: number; date: string }> = [];
  for (const t of movable) {
    let date = dateAfterDays(t.task_date, opts.days);
    let attempts = 0;
    while (true) {
      if (!isCalendarDate(date) || attempts > 36600) throw new Error('调整超出支持的日期范围');
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      const weekend = opts.skipWeekends && (day === 0 || day === 6);
      const full = opts.dailyLimit !== undefined && (load.get(date) ?? 0) >= opts.dailyLimit;
      if (!weekend && !full && !occupied.has(JSON.stringify([date, t.title]))) break;
      date = dateAfterDays(date, 1);
      attempts += 1;
    }
    occupied.add(JSON.stringify([date, t.title]));
    load.set(date, (load.get(date) ?? 0) + 1);
    if (date !== t.task_date) changes.push({ id: t.id, date });
  }
  if (changes.length === 0) return { shifted: 0, endDate: plan.end_date };
  // 周期同步顺延，并覆盖容量限制产生的额外日期。
  let endDate = dateAfterDays(plan.end_date, opts.days);
  for (const c of changes) if (c.date > endDate) endDate = c.date;
  if (!isCalendarDate(endDate)) throw new Error('调整超出支持的日期范围');
  const update = db.prepare('UPDATE plan_tasks SET task_date = ? WHERE id = ? AND plan_id = ?');
  db.exec('BEGIN');
  try {
    // 临时腾空旧日期，避免连续同名任务顺延时撞 UNIQUE；事务中不会被其它请求读到。
    for (const c of changes) update.run(`rescheduling:${c.id}`, c.id, planId);
    for (const c of changes) update.run(c.date, c.id, planId);
    db.prepare('UPDATE plans SET end_date = ? WHERE id = ? AND user_id = ?').run(endDate, planId, userId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { shifted: changes.length, endDate };
}

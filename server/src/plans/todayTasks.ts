import type { TodayPlanTask } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { problemIdentitySql } from '../problems/identity.ts';

/** 日期按本地日界限转成 UTC 时刻，与 submitted_at 的存储一致。 */
export function listTodayTasks(db: Db, userId: number, date: string): TodayPlanTask[] {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const rows = db.prepare(`
    SELECT t.id, t.task_date, t.title, t.kind, t.url, t.note,
           t.plan_id, plan.title AS plan_title,
           p.platform, p.problem_key, p.title AS problem_title, p.url AS problem_url,
           (SELECT 1 FROM checkins c WHERE c.task_id = t.id AND c.user_id = ?) AS checked,
           EXISTS (SELECT 1 FROM submissions s JOIN problems sp ON sp.id = s.problem_id
             WHERE s.user_id = ? AND ${problemIdentitySql('sp')} = ${problemIdentitySql('p')}
             AND s.verdict = 'AC' AND s.submitted_at >= ? AND s.submitted_at < ?) AS solvedToday
      FROM plan_tasks t JOIN plans plan ON plan.id = t.plan_id
      LEFT JOIN problems p ON p.id = t.problem_id
     WHERE plan.user_id = ? AND t.task_date = ? ORDER BY t.plan_id, t.id
  `).all(userId, userId, from.toISOString(), to.toISOString(), userId, date) as unknown as Array<Omit<TodayPlanTask, 'solvedToday'> & { solvedToday: number }>;
  return rows.map((row) => ({ ...row, solvedToday: row.solvedToday === 1 }));
}

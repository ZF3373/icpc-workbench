import type { ReviewPlanTask } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { problemIdentitySql } from '../problems/identity.ts';

/** 只关联用户当日明确排入计划的同题复习，不把练习、其它日期或其它用户任务算进去。 */
export function reviewPlanTasks(db: Db, userId: number, identity: string, date: string, includeChecked = false): ReviewPlanTask[] {
  return db.prepare(`
    SELECT t.id, t.title, plan.title AS planTitle
    FROM plan_tasks t JOIN plans plan ON plan.id = t.plan_id
    JOIN problems p ON p.id = t.problem_id
    WHERE plan.user_id = ? AND t.task_date = ? AND t.kind = 'review'
      AND ${problemIdentitySql('p')} = ?
      ${includeChecked ? '' : 'AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.task_id = t.id AND c.user_id = plan.user_id)'}
    ORDER BY t.id
  `).all(userId, date, identity) as unknown as ReviewPlanTask[];
}

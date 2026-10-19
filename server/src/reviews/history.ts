import type { ReviewHistory, ReviewHistoryEvent } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { IDENTITY_COLUMN_SQL } from '../problems/identity.ts';

/**
 * 先找原题/镜像 ID，再使用 (user_id, problem_id) 索引读取日志。
 * 身份用生成列等值查找走 idx_problems_identity：真实库实测这组两条查询合计
 * p10 16.0ms → 0.07ms（注入 2000 条日志后 16.5ms → 0.55ms）。
 * 写成身份表达式则每行重算 CASE，只能全表扫描。
 */
export function reviewHistory(db: Db, userId: number, identity: string, page: number, pageSize: number): ReviewHistory {
  const where = `re.user_id = ? AND re.problem_id IN (
    SELECT p.id FROM problems p WHERE ${IDENTITY_COLUMN_SQL} = ?
  )`;
  const counts = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN re.feedback = 'hard' THEN 1 ELSE 0 END), 0) AS lapseCount
    FROM review_events re WHERE ${where}`).get(userId, identity) as { total: number; lapseCount: number };
  const items = db.prepare(`SELECT re.id, p.platform, p.problem_key AS problemKey,
      re.reviewed_at AS reviewedAt, re.feedback, re.stage_before AS stageBefore, re.stage_after AS stageAfter,
      re.due_on AS dueOn, re.interval_days AS intervalDays, re.factor
    FROM review_events re JOIN problems p ON p.id = re.problem_id
    WHERE ${where}
    ORDER BY julianday(re.reviewed_at) DESC, re.id DESC LIMIT ? OFFSET ?`)
    .all(userId, identity, pageSize, (page - 1) * pageSize) as unknown as ReviewHistoryEvent[];
  return { ...counts, page, pageSize, items };
}

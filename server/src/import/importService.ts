import type { NormalizedSubmission } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';

export interface InsertResult {
  imported: number;
  skipped: number;
}

/**
 * 将统一 Submission 结构写入数据库：
 * - problems 按 (platform, problem_key) upsert（标题/难度/链接更新）
 * - submissions 按 (user_id, platform, external_id) INSERT OR IGNORE 去重
 * 供平台同步与手动导入共用。整个批次在事务中执行。
 */
export function insertNormalized(
  db: Db,
  userId: number,
  subs: NormalizedSubmission[],
): InsertResult {
  const upsertProblem = db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, problem_key) DO UPDATE SET
       title = excluded.title,
       difficulty = COALESCE(excluded.difficulty, problems.difficulty),
       url = COALESCE(excluded.url, problems.url),
       tags = excluded.tags`,
  );
  const insertSub = db.prepare(
    `INSERT OR IGNORE INTO submissions
       (user_id, platform, problem_id, verdict, language, submitted_at, external_id)
     VALUES (?, ?, (SELECT id FROM problems WHERE platform = ? AND problem_key = ?), ?, ?, ?, ?)`,
  );

  let imported = 0;
  let skipped = 0;
  db.exec('BEGIN');
  try {
    for (const s of subs) {
      upsertProblem.run(
        s.problem.platform,
        s.problem.problemKey,
        s.problem.title,
        s.problem.difficulty ?? null,
        s.problem.url ?? null,
        JSON.stringify(s.problem.tags),
      );
      const r = insertSub.run(
        userId,
        s.problem.platform,
        s.problem.platform,
        s.problem.problemKey,
        s.verdict,
        s.language ?? null,
        s.submittedAt,
        s.externalId,
      );
      if (r.changes > 0) imported += 1;
      else skipped += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported, skipped };
}

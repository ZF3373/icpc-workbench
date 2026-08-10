import type { NormalizedSubmission, PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';

export interface InsertResult {
  imported: number;
  skipped: number;
}

/**
 * 将统一 Submission 结构写入数据库（单事务）：
 * - problems 按 (platform, problem_key) upsert（标题/难度/链接更新）
 * - submissions 按 (user_id, platform, external_id) INSERT OR IGNORE 去重
 * - opts.clearPlatform：先删除该平台旧提交再插入（换账号场景，保证原子性）
 * 供平台同步与手动导入共用。
 */
export function insertNormalized(
  db: Db,
  userId: number,
  subs: NormalizedSubmission[],
  opts: { clearPlatform?: PlatformId } = {},
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
  // 手动导入（externalId 以 manual: 开头）与平台同步数据协调：
  // 同平台同题同结果已存在（无论来源是同步还是手动）→ 跳过，避免重复计数
  const manualDup = db.prepare(
    `SELECT 1 FROM submissions s JOIN problems p ON s.problem_id = p.id
     WHERE s.user_id = ? AND s.platform = ? AND p.problem_key = ? AND s.verdict = ?
     LIMIT 1`,
  );

  let imported = 0;
  let skipped = 0;
  db.exec('BEGIN');
  try {
    if (opts.clearPlatform) {
      db.prepare('DELETE FROM submissions WHERE user_id = ? AND platform = ?').run(
        userId,
        opts.clearPlatform,
      );
    }
    for (const s of subs) {
      upsertProblem.run(
        s.problem.platform,
        s.problem.problemKey,
        s.problem.title,
        s.problem.difficulty ?? null,
        s.problem.url ?? null,
        JSON.stringify(s.problem.tags),
      );
      // 手动导入协调：同题同结果已存在 → 跳过（不再重复计入）
      if (String(s.externalId).startsWith('manual:')) {
        const dup = manualDup.get(
          userId,
          s.problem.platform,
          s.problem.problemKey,
          s.verdict,
        );
        if (dup) {
          skipped += 1;
          continue;
        }
      }
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

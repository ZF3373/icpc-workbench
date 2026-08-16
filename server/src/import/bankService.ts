import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';

/** 纯题目批量入库结果 */
export interface BankImportResult {
  platform: PlatformId;
  /** 新入库题数（此前库中不存在） */
  inserted: number;
  /** 已存在被更新的题数 */
  updated: number;
}

/**
 * 将公开题库题目批量写入 problems 表（不产生 submissions，不污染刷题统计）。
 * - 按 (platform, problem_key) upsert：已有题（含手动导入/同步得来的）只更新元信息
 * - difficulty 保留库内已有值（用户手动标定的优先，题库值仅补空）：COALESCE(旧, 新)
 * - tags 仅在新值为非空数组时覆盖（题库来源的标签通常比手动录入的更全）
 * 注：SQLite ON CONFLICT DO UPDATE 的 changes 恒为 1，无法区分新增/更新，
 * 故先按平台统计库内已有 key 数，upsert 后用差值计算。
 */
export function upsertBankProblems(
  db: Db,
  rows: Array<{
    platform: PlatformId;
    problemKey: string;
    title: string;
    difficulty: number | null;
    url: string | null;
    tags: string[];
  }>,
): BankImportResult[] {
  const byPlatform = new Map<PlatformId, string[]>();
  for (const r of rows) {
    const keys = byPlatform.get(r.platform) ?? [];
    keys.push(r.problemKey);
    byPlatform.set(r.platform, keys);
  }

  const stmt = db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, problem_key) DO UPDATE SET
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE problems.title END,
       difficulty = COALESCE(problems.difficulty, excluded.difficulty),
       url = COALESCE(excluded.url, problems.url),
       tags = CASE WHEN excluded.tags != '[]' THEN excluded.tags ELSE problems.tags END`,
  );

  db.exec('BEGIN');
  try {
    // 库内已存在的 key 数（在写入前统计，作为 inserted/updated 的基准）
    const existedByPlatform = new Map<PlatformId, number>();
    const countExisting = db.prepare(
      'SELECT COUNT(*) AS c FROM problems WHERE platform = ? AND problem_key = ?',
    );
    for (const [platform, keys] of byPlatform) {
      let existed = 0;
      for (const key of keys) {
        if ((countExisting.get(platform, key) as { c: number }).c > 0) existed += 1;
      }
      existedByPlatform.set(platform, existed);
    }
    for (const r of rows) {
      stmt.run(
        r.platform,
        r.problemKey,
        r.title || r.problemKey,
        r.difficulty,
        r.url,
        JSON.stringify(r.tags ?? []),
      );
    }
    db.exec('COMMIT');
    return [...byPlatform.entries()].map(([platform, keys]) => {
      const existed = existedByPlatform.get(platform) ?? 0;
      // 同批内重复 key 只算一次存在
      const uniqueKeys = new Set(keys).size;
      const inserted = Math.max(0, uniqueKeys - existed);
      return { platform, inserted, updated: uniqueKeys - inserted };
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

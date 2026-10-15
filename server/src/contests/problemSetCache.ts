import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import type { ContestProblemRef } from './participationSources.ts';
import { problemSetMatchesContest } from './problemSetShape.ts';

/** 纯读库；空数组表示已确认无题，null 表示尚无可信题单。 */
export function readContestProblemSet(db: Db, platform: PlatformId, contestId: string): ContestProblemRef[] | null {
  const row = db.prepare('SELECT refs FROM contest_problem_sets WHERE platform = ? AND contest_id = ?')
    .get(platform, contestId) as { refs: string } | undefined;
  if (!row) return null;
  try {
    const refs: unknown = JSON.parse(row.refs);
    if (!Array.isArray(refs) || !refs.every(p => p && typeof p.id === 'string')) return null;
    // 旧解析器可能漏掉 AtCoder 共用题；只有新版官方 tasks 页归属证据才算完整。
    if (platform === 'atcoder' && refs.some(p => p.contestId !== contestId)) return null;
    return refs.length === 0 || problemSetMatchesContest(platform, contestId, refs) ? refs : null;
  } catch { return null; }
}

export function storeContestProblemSet(db: Db, platform: PlatformId, contestId: string, refs: ContestProblemRef[]): void {
  db.prepare(`INSERT INTO contest_problem_sets(platform, contest_id, refs, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, contest_id) DO UPDATE SET refs = excluded.refs, fetched_at = excluded.fetched_at`)
    .run(platform, contestId, JSON.stringify(refs), new Date().toISOString());
}

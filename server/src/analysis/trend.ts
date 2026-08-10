import type { Db } from '../db/index.ts';
import { bucketForDifficulty, fetchRows, type MutableStat } from './stats.ts';

export interface TrendPoint {
  week: string;
  attempts: number;
  ac: number;
  solved: number;
  avgDifficulty: number | null;
  /** 该周 AC 题按难度桶的计数 */
  difficultyDist: Record<string, number>;
}

/** ISO-8601 周键，如 2026-W33。 */
export function getWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computeTrend(
  db: Db,
  userId: number,
  weeks = 12,
): TrendPoint[] {
  const rows = fetchRows(db, userId);
  const byWeek = new Map<string, MutableStat>();
  const solvedByWeek = new Map<string, Set<string>>();
  const acDifficultyByWeek = new Map<string, number[]>();
  const distByWeek = new Map<string, Map<string, number>>();

  for (const r of rows) {
    const wk = getWeekKey(new Date(r.submitted_at));
    const isAc = r.verdict === 'AC';
    bump(byWeek, wk, isAc);
    if (isAc) {
      if (!solvedByWeek.has(wk)) solvedByWeek.set(wk, new Set());
      solvedByWeek.get(wk)!.add(`${r.platform}:${r.problem_key}`);
      if (r.difficulty !== null && Number.isFinite(r.difficulty)) {
        if (!acDifficultyByWeek.has(wk)) acDifficultyByWeek.set(wk, []);
        acDifficultyByWeek.get(wk)!.push(r.difficulty);
      }
      const bucket = bucketForDifficulty(r.difficulty);
      if (!distByWeek.has(wk)) distByWeek.set(wk, new Map());
      const dist = distByWeek.get(wk)!;
      dist.set(bucket, (dist.get(bucket) ?? 0) + 1);
    }
  }

  const allWeeks = [...byWeek.keys()].sort();
  const recent = allWeeks.slice(-weeks);
  return recent.map((wk) => {
    const s = byWeek.get(wk)!;
    const diffs = acDifficultyByWeek.get(wk) ?? [];
    const avg =
      diffs.length === 0
        ? null
        : Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10;
    const dist: Record<string, number> = {};
    for (const [bucket, count] of distByWeek.get(wk) ?? new Map()) {
      dist[bucket] = count;
    }
    return {
      week: wk,
      attempts: s.attempts,
      ac: s.ac,
      solved: solvedByWeek.get(wk)?.size ?? 0,
      avgDifficulty: avg,
      difficultyDist: dist,
    };
  });
}

function bump(map: Map<string, MutableStat>, key: string, isAc: boolean): void {
  const cur = map.get(key) ?? { attempts: 0, ac: 0 };
  cur.attempts += 1;
  if (isAc) cur.ac += 1;
  map.set(key, cur);
}

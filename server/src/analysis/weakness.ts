import type {
  DifficultyWeakness,
  WeaknessItem,
  WeaknessProfile,
} from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import {
  bump,
  bucketForDifficulty,
  fetchRows,
  rate,
  round2,
  safeTags,
  type MutableStat,
} from './stats.ts';

export type { DifficultyWeakness, WeaknessItem, WeaknessProfile };

export interface WeaknessOptions {
  minAttempts?: number;
  topN?: number;
}

/**
 * 弱项画像：相对用户自身总体 AC 率的偏差打分。
 * - 各 tag：gap = 总体AC率 - 该tagAC率（正 = 弱），过滤样本不足的 tag
 * - 各难度桶：同样偏差计算
 */
export function computeWeakness(
  db: Db,
  userId: number,
  opts: WeaknessOptions = {},
): WeaknessProfile {
  const minAttempts = opts.minAttempts ?? 5;
  const topN = opts.topN ?? 10;
  const rows = fetchRows(db, userId);
  const totalAc = rows.filter((r) => r.verdict === 'AC').length;
  const avgAcRate = rate(rows.length, totalAc);

  const tagMap = new Map<string, MutableStat>();
  const solvedByTag = new Map<string, Set<string>>();
  for (const r of rows) {
    const isAc = r.verdict === 'AC';
    for (const tag of safeTags(r.tags)) {
      bump(tagMap, tag, isAc);
      if (isAc) {
        if (!solvedByTag.has(tag)) solvedByTag.set(tag, new Set());
        solvedByTag.get(tag)!.add(`${r.platform}:${r.problem_key}`);
      }
    }
  }

  const items: WeaknessItem[] = [...tagMap.entries()]
    .map(([tag, s]) => {
      const acRate = rate(s.attempts, s.ac);
      return {
        tag,
        attempts: s.attempts,
        ac: s.ac,
        acRate,
        avgAcRate,
        gap: round2(avgAcRate - acRate),
        solved: solvedByTag.get(tag)?.size ?? 0,
      };
    })
    .filter((i) => i.attempts >= minAttempts)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, topN);

  const diffMap = new Map<string, MutableStat>();
  for (const r of rows) {
    bump(diffMap, bucketForDifficulty(r.difficulty), r.verdict === 'AC');
  }
  const byDifficulty: DifficultyWeakness[] = [...diffMap.entries()]
    .map(([bucket, s]) => {
      const acRate = rate(s.attempts, s.ac);
      return { bucket, attempts: s.attempts, ac: s.ac, acRate, gap: round2(avgAcRate - acRate) };
    })
    .filter((i) => i.attempts >= minAttempts)
    .sort((a, b) => b.gap - a.gap);

  return { items, byDifficulty, generatedAt: new Date().toISOString() };
}

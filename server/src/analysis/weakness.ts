import type {
  DifficultyWeakness,
  PlatformId,
  WeaknessItem,
  WeaknessProfile,
} from '../../../shared/src/index.ts';
import { canonicalTag, codeOfTag } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import {
  accountClause,
  bump,
  bucketForDifficulty,
  fetchRows,
  rate,
  round2,
  safeTags,
  type MutableStat,
} from './stats.ts';
import { filterNoiseTags } from './tags.ts';
import { informativenessFor } from '../knowledge/conceptStats.ts';

export type { DifficultyWeakness, WeaknessItem, WeaknessProfile };

export interface WeaknessOptions {
  minAttempts?: number;
  topN?: number;
  /** 覆盖 tags 列来源（双口径对比：'p.tags AS tags' = tag 口径；缺省 = 知识点口径） */
  tagsSql?: string;
  /** 账号/平台作用域：整体平均 AC 率（弱项基准）也随作用域收窄，见 accountClause */
  platform?: PlatformId;
  account?: string;
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
  const scope = { platform: opts.platform, account: opts.account };
  const rows = fetchRows(db, userId, scope, opts.tagsSql);
  const totalAc = rows.filter((r) => r.verdict === 'AC').length;
  const avgAcRate = rate(rows.length, totalAc);

  const tagMap = new Map<string, MutableStat>();
  const solvedByTag = new Map<string, Set<string>>();
  for (const r of rows) {
    const isAc = r.verdict === 'AC';
    // 只统计算法能力维度标签：来源/赛事/年份等噪声标签不参与弱项画像；
    // 英文别名归并到中文规范名（dp → 动态规划），避免同一知识点拆成两个弱项条目
    for (const tag of filterNoiseTags(safeTags(r.tags)).map((t) => canonicalTag(t))) {
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
      const gap = round2(avgAcRate - acRate);
      // 该 tag 对应的概念 code（粗类标签如「数学（综合）」也能取到）；
      // 取不到 code 时权重按 1 处理（不惩罚未纳入 taxonomy 的标签）
      const code = codeOfTag(tag);
      const weight =
        code === undefined ? 1 : averageWeightForCode(db, userId, code, scope);
      return {
        tag,
        attempts: s.attempts,
        ac: s.ac,
        acRate,
        avgAcRate,
        gap,
        rank: round2(gap * weight),
        solved: solvedByTag.get(tag)?.size ?? 0,
      };
    })
    .filter((i) => i.attempts >= minAttempts)
    .sort((a, b) => b.rank - a.rank)
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

/**
 * 同一概念横跨多个难度桶时，按用户在**各桶的尝试数**加权平均其信息量权重。
 * 只用到该用户实际做过的题所在桶，避免把用户从未接触的难度区间的膨胀也计入。
 */
function averageWeightForCode(
  db: Db,
  userId: number,
  code: string,
  scope: { platform?: PlatformId; account?: string },
): number {
  const clause = accountClause(scope);
  const rows = db
    .prepare(
      `SELECT p.difficulty AS difficulty, COUNT(*) AS attempts
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ?${clause.sql}
        GROUP BY p.difficulty`,
    )
    .all(userId, ...clause.params) as unknown as Array<{
    difficulty: number | null;
    attempts: number;
  }>;
  let total = 0;
  let weighted = 0;
  for (const r of rows) {
    const w = informativenessFor(db, bucketForDifficulty(r.difficulty), code);
    total += r.attempts;
    weighted += r.attempts * w;
  }
  return total === 0 ? 1 : weighted / total;
}

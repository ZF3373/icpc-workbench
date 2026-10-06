/**
 * 复习间隔的留存系数：阶梯只回答「这一档该隔几天」，但同档的三道题脆弱程度完全不同。
 * 反复失手过的、靠题解才做出来的、所属知识点还没掌握的——都该排得更近；
 * 连续稳定答对、知识点已熟练的——该排得更远。系数只作用于排期，档位本身不变，
 * 所以阶梯仍然可解释（用户看到的「第 N 档」不会被系数悄悄改写）。
 *
 * 信号全部来自库里已有的数据，不引入新采集：
 * - review_events：该条目自己的复习史（次数 / 失手次数）
 * - problem_keypoints × submissions：知识点的掌握度档位（与掌握度地图同口径 levelFor）
 * - submission_intents：该题记过的卡点（看题解 / 完全没思路 / 赛后补题 = 留存最差）
 */
import type { Db } from '../db/index.ts';
import { levelFor } from '../analysis/mastery.ts';
import { rate } from '../analysis/stats.ts';
import { READABLE_SOURCES_SQL } from '../knowledge/store.ts';

export interface RetentionSignals {
  /** 该条目本次之前的复习次数 */
  reviews: number;
  /** 其中判为 hard（失手）的次数 */
  lapses: number;
  /** 任一所属知识点掌握度 ≤ 接触 */
  weakConcept: boolean;
  /** 所属知识点全部 ≥ 掌握 */
  solidConcept: boolean;
  /** 该题记过「看题解/完全没思路/赛后补题才做出」 */
  stuckByIntent: boolean;
}

/** 系数夹逼：再差的留存也不排到「今天重复」，再好也不排到半年后见不到 */
export const FACTOR_FLOOR = 0.5;
export const FACTOR_CEIL = 1.6;

/** 掌握度 ≥ 此档（掌握）才算「这个知识点已经稳」；≤ 接触档算薄弱 */
const SOLID_LEVEL = 3;
const WEAK_LEVEL = 1;
/** 连续稳定判定所需的复习次数（不足则样本太少，不给放宽） */
const STABLE_REVIEWS = 4;

/** 卡点里最能说明「不是自己想出来」的：看题解 / 完全没思路 / 赛时未做出的赛后补题 */
const STUCK_OUTCOMES = ['cant_start', 'editorial', 'upsolved'];

export function retentionFactor(s: RetentionSignals): number {
  let f = 1;
  // 自己的复习史最可靠：失手一次收 15%，两次及以上收 30%
  if (s.lapses >= 2) f *= 0.7;
  else if (s.lapses === 1) f *= 0.85;
  // 从未失手且已练够次数，说明这个间隔还太保守
  if (s.reviews >= STABLE_REVIEWS && s.lapses === 0) f *= 1.25;
  if (s.stuckByIntent) f *= 0.75;
  if (s.weakConcept) f *= 0.8;
  else if (s.solidConcept) f *= 1.15;
  return Math.min(FACTOR_CEIL, Math.max(FACTOR_FLOOR, Math.round(f * 100) / 100));
}

/**
 * 采集某条目当前的留存信号。
 * 知识点掌握度按**该知识点在全库的练习情况**算，不是只看队列里这几道题——
 * 「DP 只做过 1 题」和「DP 刷过 40 题」下的同一道复习题，可靠性完全不同。
 */
export function collectRetentionSignals(
  db: Db,
  userId: number,
  item: { id: number; problemId: number; platform: string; problemKey: string },
): RetentionSignals {
  const history = db
    .prepare(
      `SELECT COUNT(*) AS reviews,
              COALESCE(SUM(CASE WHEN feedback = 'hard' THEN 1 ELSE 0 END), 0) AS lapses
         FROM review_events WHERE review_item_id = ? AND user_id = ?`,
    )
    .get(item.id, userId) as { reviews: number; lapses: number };

  const codes = db
    .prepare(
      `SELECT DISTINCT code FROM problem_keypoints
        WHERE platform = ? AND problem_key = ? AND ${READABLE_SOURCES_SQL}`,
    )
    .all(item.platform, item.problemKey) as Array<{ code: string }>;

  let weakConcept = false;
  let solidConcept = codes.length > 0;
  if (codes.length > 0) {
    const placeholders = codes.map(() => '?').join(',');
    const stats = db
      .prepare(
        `SELECT pk.code AS code, COUNT(*) AS attempts,
                COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac,
                COUNT(DISTINCT CASE WHEN s.verdict = 'AC' THEN s.problem_id END) AS solved
           FROM submissions s
           JOIN problems p ON p.id = s.problem_id
           JOIN problem_keypoints pk ON pk.platform = p.platform AND pk.problem_key = p.problem_key
          WHERE s.user_id = ? AND pk.${READABLE_SOURCES_SQL} AND pk.code IN (${placeholders})
          GROUP BY pk.code`,
      )
      .all(userId, ...codes.map((c) => c.code)) as unknown as Array<{
      code: string;
      attempts: number;
      ac: number;
      solved: number;
    }>;
    const levelByCode = new Map(stats.map((r) => [r.code, levelFor(r.solved, rate(r.attempts, r.ac))]));
    for (const { code } of codes) {
      // 库里没有该知识点的练习记录 = 从没做过，自然算薄弱
      const level = levelByCode.get(code) ?? 0;
      if (level <= WEAK_LEVEL) weakConcept = true;
      if (level < SOLID_LEVEL) solidConcept = false;
    }
  }

  const stuck = db
    .prepare(
      `SELECT 1 AS hit FROM submission_intents
        WHERE user_id = ? AND problem_id = ? AND outcome IN (${STUCK_OUTCOMES.map(() => '?').join(',')})
        LIMIT 1`,
    )
    .get(userId, item.problemId, ...STUCK_OUTCOMES);

  return {
    reviews: history.reviews,
    lapses: history.lapses,
    weakConcept,
    solidConcept: solidConcept && !weakConcept,
    stuckByIntent: stuck !== undefined,
  };
}

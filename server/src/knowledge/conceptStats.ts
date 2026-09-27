/**
 * 知识点概念的统计特征：覆盖率与信息量（清洗重构 spec §2.2–2.4）。
 *
 * 为什么需要它：题源标签在低难度区间严重膨胀 —— CF difficulty<1200 的题里
 * 贪心 38% / 数学 39% / 模拟 45%（实测），这类标签几乎不含判别信息；
 * 而数论 5.9% / 双指针 5.5% 则很有区分度。
 *
 * 解法不是删掉膨胀标签（那会放弃它们覆盖的题），而是按实测信息量给它们降权：
 *   informativeness(p) = 1 - H_b(p) / 1bit
 *   H_b(p) = -(p·log2 p + (1-p)·log2(1-p))
 * p→0.5 时 H_b→1，信息量 → 0（最无区分度）；
 * p→0 或 p→1 时 H_b→0，按 spec 边界性质信息量 → 0（退化：全库皆有或全无）。
 *
 * 注意：spec §2.2 的公式行写作 H_b(p)，但其全部实测值（§2.2 表格、§2.3 两例）
 * 都是 1 - H_b(p)。例如数学 share 0.248 对应 informativeness ≈ 0.19，
 * 数论 share 0.059 对应  0.68；若用原始 H_b 则会颠倒。
 * 因此实现取补集，并令退化端点返回 0 以匹配 spec 的边界描述。
 *
 * 权重下限 FLOOR 由消费端（informativenessFor）在取用时施加，
 * 表内存放的 informativeness 是原始值，这样既能复现 spec 表格，
 * 也能让消费端按需求决定是否夹取。
 */
import type { Db } from '../db/index.ts';
import { difficultyBucketOf } from '../../../shared/src/difficulty.ts';

export const INFORMATIVENESS_FLOOR = 0.25;

/**
 * 概念的信息量：越「常见」的概念越没有区分度。
 *
 * @param p 该概念在库内（或某难度桶内）的占比，取值 (0,1)
 * @returns 原始信息量 1 - H_b(p)，取值 [0,1]；退化输入返回 0
 */
export function informativeness(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0; // 退化：全库皆有或全库皆无 → 无区分度
  const h = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
  return Math.min(1, Math.max(0, 1 - h));
}

/** 难度桶：唯一真源在 shared/src/difficulty.ts（分档改动只需改那一处，含 routes/problems 的口径） */
const bucketOf = difficultyBucketOf;

/**
 * 重算并物化全部 (code × bucket) 统计。幂等：同一数据重复执行结果一致。
 * @returns 写入的行数
 */
export function recomputeConceptStats(db: Db): number {
  const rows = db
    .prepare(
      `SELECT p.id, p.difficulty, pk.code
         FROM problems p JOIN problem_keypoints pk
           ON pk.platform = p.platform AND pk.problem_key = p.problem_key
        WHERE pk.source IN ('tag','rule','manual')`,
    )
    .all() as unknown as Array<{ id: number; difficulty: number | null; code: string }>;

  // 每题在同一桶内对一个 code 只计一次
  const totalByBucket = new Map<string, number>();
  const codeByBucket = new Map<string, Set<number>>();
  const allProblems = db
    .prepare('SELECT id, difficulty FROM problems')
    .all() as unknown as Array<{ id: number; difficulty: number | null }>;
  for (const p of allProblems) {
    const b = bucketOf(p.difficulty);
    totalByBucket.set(b, (totalByBucket.get(b) ?? 0) + 1);
  }
  for (const r of rows) {
    const b = bucketOf(r.difficulty);
    const key = `${b}\u0000${r.code}`;
    const set = codeByBucket.get(key) ?? new Set<number>();
    set.add(r.id);
    codeByBucket.set(key, set);
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM knowledge_concept_stats');
    const ins = db.prepare(
      `INSERT INTO knowledge_concept_stats (code, bucket, problem_count, share, informativeness)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let written = 0;
    for (const [key, ids] of codeByBucket) {
      const [bucket, code] = key.split('\u0000');
      const total = totalByBucket.get(bucket) ?? 0;
      if (total === 0) continue;
      const share = ids.size / total;
      ins.run(code, bucket, ids.size, share, informativeness(share));
      written += 1;
    }
    db.exec('COMMIT');
    return written;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 某难度桶的 code → 原始 informativeness；用于批量加权 */
export function conceptStatsFor(db: Db, bucket: string): Map<string, number> {
  const rows = db
    .prepare('SELECT code, informativeness FROM knowledge_concept_stats WHERE bucket = ?')
    .all(bucket) as unknown as Array<{ code: string; informativeness: number }>;
  return new Map(rows.map((r) => [r.code, r.informativeness]));
}

/**
 * 单点权重查询：统计缺失时返回 1（不惩罚未统计到的概念）。
 * 消费端在原始值与 FLOOR 之间取 max，保证低信息量概念仍出现在弱项列表里（只是排在后面）。
 */
export function informativenessFor(db: Db, bucket: string, code: string): number {
  const row = db
    .prepare('SELECT informativeness FROM knowledge_concept_stats WHERE bucket = ? AND code = ?')
    .get(bucket, code) as { informativeness: number } | undefined;
  if (!row) return 1; // 未统计到的概念不惩罚
  return Math.max(INFORMATIVENESS_FLOOR, row.informativeness);
}

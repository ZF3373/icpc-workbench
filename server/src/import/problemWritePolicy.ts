/**
 * 题目写入策略：统一 problems 表的 upsert 语义。
 *
 * 历史缺陷：同一字段、两条路径、相反的优先级 ——
 *   bankService（拉题库）用 COALESCE(problems.difficulty, excluded.difficulty) 保留旧值，
 *   importService（同步 / 手动导入）用 COALESCE(excluded.difficulty, problems.difficulty) 采用新值。
 *   结果是「手动标定的难度被下一次同步覆盖」与「题库补的新难度永远不进已有题」同时存在。
 *
 * 现在改为显式来源优先级（difficulty_source，迁移补列；历史 NULL 视为 'sync' 保持原行为）：
 *   manual(4) > backfill(3) > sync(2) > bank(1)
 * 新值非空且来源优先级 ≥ 已有优先级才覆盖。
 *
 * 标签语义同时收敛为一条：**写入即净化**（filterNoiseTags + canonicalTag），
 * 且非空新值覆盖空值。净化下沉到写入路径后，`POST /api/problems/clean-tags`
 * 退化为幂等操作，「清洗结果被下次同步覆盖」的问题不再存在。
 */
import { canonicalTag, filterNoiseTags } from '../../../shared/src/index.ts';

export type DifficultySource = 'manual' | 'backfill' | 'sync' | 'bank';

/** 来源优先级：数值大者覆盖数值小者 */
export const DIFFICULTY_PRIORITY: Record<DifficultySource, number> = {
  manual: 4,
  backfill: 3,
  sync: 2,
  bank: 1,
};

/** 已有行来源优先级（历史 NULL 视为 'sync'，与迁移前的行为等价） */
const EXISTING_PRIORITY_SQL =
  "CASE COALESCE(problems.difficulty_source, 'sync') " +
  "WHEN 'manual' THEN 4 WHEN 'backfill' THEN 3 WHEN 'sync' THEN 2 WHEN 'bank' THEN 1 ELSE 0 END";

/**
 * problems upsert 语句（当源由参数决定）。
 * - title：非空才覆盖（题库偶尔给出空标题）；且**不覆盖为题号本身**——上游拉取失败时
 *   适配器会退化成 title = problemKey 兜底（如洛谷风控），这不算"拿到了标题"，
 *   覆盖掉人工/题库先落下的好标题是脏写
 * - url：COALESCE 保留已有
 * - tags：**写入即净化**；非空才覆盖
 * - difficulty / difficulty_source：按来源优先级决定是否覆盖
 * - native_difficulty / difficulty_scale：与 difficulty **同一条决策**（同一组 WHEN 条件），
 *   即「本次写入是否被允许拥有这道题的难度」决定它是否连带更新原生值/标度。
 *   历史缺陷：这两列曾用 `problems.<col> IS NULL`（有则保留、空则填）判据，于是
 *   「手动标定难度 2400（原生值为空）+ 低优先级题库写入档位 5」会落成
 *   `difficulty=2400 / difficulty_source=manual / native_difficulty='5' / scale=luogu-2026-06`
 *   —— 难度与原生值不同源，API 由原生值派生的档位名（提高 = 2200）与难度自相矛盾。
 *   analysis/difficultyBackfill.ts 的写入明确拒绝这种组合，两个写入方现在遵循同一规则。
 */
export function problemUpsertSql(source: DifficultySource): string {
  const prio = DIFFICULTY_PRIORITY[source];
  return `
    INSERT INTO problems
      (platform, problem_key, title, difficulty, url, tags, difficulty_source, native_difficulty, difficulty_scale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, problem_key) DO UPDATE SET
      title = CASE WHEN excluded.title != '' AND excluded.title != problems.problem_key
                   THEN excluded.title ELSE problems.title END,
      url = COALESCE(excluded.url, problems.url),
      tags = CASE WHEN excluded.tags != '[]' THEN excluded.tags ELSE problems.tags END,
      difficulty = CASE
        WHEN excluded.difficulty IS NULL THEN problems.difficulty
        WHEN problems.difficulty IS NULL THEN excluded.difficulty
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.difficulty
        ELSE problems.difficulty
      END,
      difficulty_source = CASE
        WHEN excluded.difficulty IS NULL THEN problems.difficulty_source
        WHEN problems.difficulty IS NULL THEN excluded.difficulty_source
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.difficulty_source
        ELSE problems.difficulty_source
      END,
      native_difficulty = CASE
        WHEN excluded.native_difficulty IS NULL THEN problems.native_difficulty
        WHEN problems.difficulty IS NULL THEN excluded.native_difficulty
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.native_difficulty
        ELSE problems.native_difficulty
      END,
      difficulty_scale = CASE
        WHEN excluded.difficulty_scale IS NULL THEN problems.difficulty_scale
        WHEN problems.difficulty IS NULL THEN excluded.difficulty_scale
        WHEN ${prio} >= ${EXISTING_PRIORITY_SQL} THEN excluded.difficulty_scale
        ELSE problems.difficulty_scale
      END`;
}

/** 标签净化：噪声标签过滤 + 同义词归并 + 去重（写库前统一调用） */
export function purifyTags(tags: readonly string[] | null | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  return [...new Set(filterNoiseTags([...tags].map((t) => String(t))).map((t) => canonicalTag(t)))];
}

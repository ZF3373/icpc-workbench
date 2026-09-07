import type { Db } from '../db/index.ts';
import { estimateLevel } from './select.ts';
import type { PracticeSummary } from '../analysis/summary.ts';

/** AI 能力值调整的持久化结构（settings 表 key = ability.override） */
export interface AbilityOverride {
  level: number;
  reason?: string;
  updatedAt: string;
  /** 调整依据概述（AI 给出的理由，供用户复核） */
  basis?: string;
}

export const ABILITY_OVERRIDE_KEY = 'ability.override';

/** 读取 AI 调整的能力值（无 / 解析失败返回 null，不影响计算值） */
export function getAbilityOverride(db: Db): AbilityOverride | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ABILITY_OVERRIDE_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as AbilityOverride;
    return Number.isFinite(v?.level) && v.level > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 保存 / 清除（level 传 null 时清除）AI 能力值调整 */
export function setAbilityOverride(db: Db, override: AbilityOverride | null): void {
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (override) up.run(ABILITY_OVERRIDE_KEY, JSON.stringify(override));
  else del.run(ABILITY_OVERRIDE_KEY);
}

/**
 * 估算能力值：近 windowDays 天 AC 难度中位数（样本 ≥5），
 * 不足时回退全部 AC 难度中位数，再回退 1200。与 select.ts 的 estimateLevel 同标尺（四舍五入到百）。
 */
export function computeAbility(db: Db, userId: number, windowDays = 60): number {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const recent = db
    .prepare(
      `SELECT p.difficulty FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL AND s.submitted_at >= ?`,
    )
    .all(userId, since) as Array<{ difficulty: number | null }>;
  if (recent.length >= 5) {
    return estimateLevel(recent.map((x) => x.difficulty as number));
  }
  const allAc = db
    .prepare(
      `SELECT p.difficulty FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL`,
    )
    .all(userId) as Array<{ difficulty: number | null }>;
  return estimateLevel(allAc.map((x) => x.difficulty as number));
}

/** 生效能力值：AI 调整优先于计算值 */
export function effectiveAbility(db: Db, userId: number, windowDays = 60): { computed: number; override: AbilityOverride | null; effective: number } {
  const computed = computeAbility(db, userId, windowDays);
  const override = getAbilityOverride(db);
  return { computed, override, effective: override?.level ?? computed };
}

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx];
};

/**
 * 能力评估数据（注入 AI 助手，Markdown）：近 60 天逐次 AC 难度的分位数/分布直方图/明细、
 * 全历史最高、12 周趋势、卡壳题——让 AI 能基于完整刷题情况独立判断真实水平，
 * 而不是默认信任中位数基线（中位数易被极值/小样本带偏）。
 */
export function renderAbilityEvidence(db: Db, userId: number, summary: PracticeSummary, windowDays = 60): string {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const recent = db
    .prepare(
      `SELECT p.difficulty, MAX(s.submitted_at) AS solved_at
        FROM submissions s JOIN problems p ON s.problem_id = p.id
        WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL AND s.submitted_at >= ?
        GROUP BY p.id ORDER BY solved_at DESC`,
    )
    .all(userId, since) as Array<{ difficulty: number; solved_at: string }>;
  const maxAll = db
    .prepare(
      `SELECT MAX(p.difficulty) AS d FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL`,
    )
    .get(userId) as { d: number | null };

  const L: string[] = [`### 近 ${windowDays} 天 AC 证据`];
  const diffs = recent.map((r) => r.difficulty).sort((a, b) => a - b);
  if (diffs.length === 0) {
    L.push(`- 近 ${windowDays} 天无带难度的 AC 记录，证据不足：不要建议调整能力值，先引导用户同步刷题数据`);
    return L.join('\n');
  }
  L.push(
    `- 近 ${windowDays} 天 AC ${diffs.length} 题：难度分位 P25=${percentile(diffs, 25)} / P50=${percentile(diffs, 50)} / P75=${percentile(diffs, 75)}；区间最高 ${diffs[diffs.length - 1]}；全历史最高 ${maxAll.d ?? '未知'}`,
  );
  // 直方图（200 分一档）
  const buckets = new Map<number, number>();
  for (const d of diffs) {
    const lo = Math.floor(d / 200) * 200;
    buckets.set(lo, (buckets.get(lo) ?? 0) + 1);
  }
  L.push(
    `- 难度分布（200 分一档）：${[...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([lo, n]) => `${lo}-${lo + 200}:${n}`).join(' ')}`,
  );
  // 最近 AC 明细（难度(日期)，新→旧，至多 25 条）
  L.push(
    `- 最近 AC（新→旧）：${recent.slice(0, 25).map((r) => `${r.difficulty}(${r.solved_at.slice(5, 10)})`).join(' ')}`,
  );
  // 12 周趋势
  if (summary.trend.length > 0) {
    L.push(`- 近 12 周趋势（周｜提交/AC/过题）：${summary.trend.map((t) => `${t.week.slice(5)}｜${t.attempts}/${t.ac}/${t.solved}`).join(' ')}`);
  }
  // 卡壳题（尝试 ≥3 未过，带难度的前 8 道）
  const stuck = summary.stuckProblems.filter((p) => p.attempts >= 3).slice(0, 8);
  if (stuck.length > 0) {
    L.push(`- 卡壳题（尝试≥3 次未通过）：${stuck.map((p) => `${p.platform}/${p.problemKey}（难度${p.difficulty ?? '未知'}）×${p.attempts}`).join(' ')}`);
  }
  return L.join('\n');
}

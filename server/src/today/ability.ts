import type { Db } from '../db/index.ts';
import { estimateLevel } from './select.ts';

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

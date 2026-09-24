import type { TodayBandKey, TodayProblem } from '../../../shared/src/index.ts';

/**
 * 今日训练选题（借鉴 cf-compass 今日训练）：
 * - 能力值 level 由 ability.ts 的加权解题证据模型估算（本模块的 estimateLevel 仅作样本不足时的回退）
 * - 三档难度带：巩固区 [level-200, level) / 同段区 [level, level+200] / 挑战区 (level+200, level+400]
 * - 每档优先命中弱项标签的题，再按「离档心最近」补齐；同日多次请求结果稳定（rotate 平移窗口）
 * - 排序是确定性的，所以「今天不再出现同一批」完全依赖调用方传入的冷却排除集
 *   （见 routes/today.ts 与 today_recommendations 表）
 */

export interface CandidateProblem {
  id: number;
  platform: string;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
  /** 已在复习队列时为 review_items.id，否则 null/undefined */
  reviewItemId?: number | null;
  /** 最近一次被推荐进题单的日期（YYYY-MM-DD），从未推荐过为 null */
  recommendedOn: string | null;
  /** 已在复习队列中（复习库里的题不该再当新推荐出现） */
  inReview: boolean;
}

export interface BandRange {
  key: TodayBandKey;
  label: string;
  description: string;
  min: number | null;
  max: number | null;
  /** 档心难度：排序时距离最近的优先 */
  center: number | null;
}

export const BAND_LABELS: Record<TodayBandKey, { label: string; description: string }> = {
  consolidation: { label: '巩固区', description: '略低于当前水平，练稳定性和手感' },
  core: { label: '同段区', description: '贴合当前水平，每天最主要的能力训练' },
  challenge: { label: '挑战区', description: '略高于当前水平，试探新的上限' },
};

export function bandRanges(level: number): Record<TodayBandKey, BandRange> {
  return {
    consolidation: {
      ...BAND_LABELS.consolidation,
      key: 'consolidation',
      min: level - 200,
      max: level - 1,
      center: level - 100,
    },
    core: { ...BAND_LABELS.core, key: 'core', min: level, max: level + 200, center: level + 100 },
    challenge: {
      ...BAND_LABELS.challenge,
      key: 'challenge',
      min: level + 201,
      max: level + 400,
      center: level + 300,
    },
  };
}

/**
 * AC 难度中位数 → 能力值（四舍五入到百；空数据回退 1200）。
 * 仅作 ability.ts 的样本不足回退路径；过滤 ≤0：AtCoder Problems 难度标尺可为负（水题），
 * 混入会把中位数拉到不存在的 rating 段。
 */
export function estimateLevel(acDifficulties: number[], fallback = 1200): number {
  const xs = acDifficulties.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (xs.length === 0) return fallback;
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
  return Math.round(median / 100) * 100;
}

function weakOverlap(tags: string[], weakTags: string[]): string[] {
  const weak = new Set(weakTags);
  return tags.filter((t) => weak.has(t));
}

/**
 * 从候选中选出一档题单：
 * - 只保留难度落在 [min, max] 的题（null 难度视为不匹配，避免乱档）
 * - 弱项命中优先，其次离档心最近，最后按 id 稳定排序
 * - rotate 用于「换一批」：步长为 count（整批平移），点一次换掉的是全部 count 题；
 *   池子长度是 count 整数倍时相邻两批零重叠，否则回绕的那一份会复现最早期批次的
 *   1-2 题；rotate 大到超过槽位数会重新回到首批
 */
export function pickBand(
  candidates: CandidateProblem[],
  band: BandRange,
  count: number,
  weakTags: string[],
  excludeIds: Set<number>,
  rotate = 0,
): { problems: TodayProblem[]; pool: number } {
  const inBand = candidates.filter(
    (c) =>
      c.difficulty != null &&
      band.min != null &&
      band.max != null &&
      c.difficulty >= band.min &&
      c.difficulty <= band.max &&
      !excludeIds.has(c.id),
  );
  const ordered = inBand
    .map((c) => ({ c, weak: weakOverlap(c.tags, weakTags) }))
    .sort(
      (a, b) =>
        b.weak.length - a.weak.length ||
        Math.abs((a.c.difficulty ?? 0) - (band.center ?? 0)) -
          Math.abs((b.c.difficulty ?? 0) - (band.center ?? 0)) ||
        a.c.id - b.c.id,
    );
  const slots = count > 0 ? Math.ceil(ordered.length / count) : 0;
  const start = slots > 0 ? ((rotate % slots) * count) % ordered.length : 0;
  const picked = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, count);
  return {
    pool: inBand.length,
    problems: picked.map(({ c, weak }) => ({
      id: c.id,
      platform: c.platform as TodayProblem['platform'],
      problemKey: c.problem_key,
      title: c.title,
      difficulty: c.difficulty,
      url: c.url,
      tags: c.tags,
      weakTags: weak,
      reviewItemId: c.reviewItemId ?? null,
    })),
  };
}

/** 一档排除策略：冷却窗口天数 + 是否排除复习队列中的题 */
export interface SuppressionTier {
  cooldownDays: number;
  excludeReview: boolean;
}

/**
 * 放宽阶梯，从严到松逐档尝试，直到该档候选题够 count。
 * 题池小的难度段（挑战区最常见）如果只走严格档会直接出空题单，
 * 所以宁可提前重复，也不能空档 —— 实际用了第几档要回给前端说明。
 */
export const SUPPRESSION_TIERS: SuppressionTier[] = [
  { cooldownDays: 14, excludeReview: true },
  { cooldownDays: 7, excludeReview: true },
  { cooldownDays: 3, excludeReview: true },
  { cooldownDays: 0, excludeReview: true },
  { cooldownDays: 0, excludeReview: false },
];

/** ISO 日期（YYYY-MM-DD）相差的天数；任一非法返回 null */
export function daysBetweenDates(fromISO: string, toISO: string): number | null {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * 本档应排除的题目 id：
 * - 冷却窗口内「往日」推荐过的题（daysAgo >= 1 才排除：当天已展示的那批交给
 *   rotate 平移处理，否则刚写入的冷却记录会立刻把「换一批」的新窗口又排除掉）
 * - 复习队列中的题（tier.excludeReview 时）
 */
export function suppressedProblemIds(
  candidates: CandidateProblem[],
  tier: SuppressionTier,
  todayISO: string,
): Set<number> {
  const out = new Set<number>();
  for (const c of candidates) {
    if (tier.excludeReview && c.inReview) {
      out.add(c.id);
      continue;
    }
    if (tier.cooldownDays > 0 && c.recommendedOn) {
      const ago = daysBetweenDates(c.recommendedOn, todayISO);
      if (ago != null && ago >= 1 && ago <= tier.cooldownDays) out.add(c.id);
    }
  }
  return out;
}

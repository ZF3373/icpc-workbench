import type { TodayBandKey, TodayProblem } from '../../../shared/src/index.ts';

/**
 * 今日训练选题（借鉴 cf-compass 今日训练）：
 * - 能力值 level = 近期 AC 难度中位数（千位内四舍五入到百），无数据回退 1200
 * - 三档难度带：巩固区 [level-200, level) / 同段区 [level, level+200] / 挑战区 (level+200, level+400]
 * - 每档优先命中弱项标签的题，再按「离档心最近」补齐；同日多次请求结果稳定（rotate 平移窗口）
 */

export interface CandidateProblem {
  id: number;
  platform: string;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
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
 * 近期 AC 难度中位数 → 能力值（四舍五入到百；空数据回退 1200）。
 * 过滤 ≤0：AtCoder Problems 难度标尺可为负（水题），混入会把中位数拉到不存在的 rating 段。
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
 * - rotate 用于「换一批」：在有序列表上平移窗口，保持确定性
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
  const start = ordered.length ? rotate % ordered.length : 0;
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
    })),
  };
}

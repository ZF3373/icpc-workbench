import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS, canonicalTag } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { filterNoiseTags } from './tags.ts';
import { knowledgeTagsSql } from '../knowledge/store.ts';

export function bucketForDifficulty(difficulty: number | null | undefined): string {
  if (difficulty === null || difficulty === undefined || !Number.isFinite(difficulty)) {
    return '未知';
  }
  const bounds = [1200, 1400, 1600, 1900, 2200];
  const labels = ['<1200', '1200-1399', '1400-1599', '1600-1899', '1900-2199', '2200+'];
  for (let i = 0; i < bounds.length; i += 1) {
    if (difficulty < bounds[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

export interface CountStat {
  attempts: number;
  ac: number;
  acRate: number;
}

export interface TagStat extends CountStat {
  tag: string;
  solved: number;
}

export interface DifficultyStat extends CountStat {
  bucket: string;
}

export interface PlatformStat extends CountStat {
  platform: PlatformId;
  solved: number;
}

export interface OverallStats extends CountStat {
  solvedProblems: number;
  byPlatform: PlatformStat[];
  byDifficulty: DifficultyStat[];
  byTag: TagStat[];
}

export interface StatsFilter {
  from?: string;
  to?: string;
  platform?: PlatformId;
}

export interface SubmissionRow {
  platform: PlatformId;
  verdict: string;
  submitted_at: string;
  problem_key: string;
  difficulty: number | null;
  tags: string;
}

/** 拉取用户提交（join problems），供统计/弱项/趋势共用。
 *  tags 列默认走知识点管线读取路径（problem_keypoints → 题源 tags 回退）；
 *  tagsSql 可覆盖（双口径对比时传 'p.tags AS tags' 取 tag 口径）。 */
export function fetchRows(
  db: Db,
  userId: number,
  filter: StatsFilter = {},
  tagsSql?: string,
): SubmissionRow[] {
  let sql = `
    SELECT s.platform, s.verdict, s.submitted_at, p.problem_key, p.difficulty,
           ${tagsSql ?? knowledgeTagsSql(db)}
    FROM submissions s JOIN problems p ON s.problem_id = p.id
    WHERE s.user_id = ?
  `;
  const params: Array<string | number> = [userId];
  if (filter.platform) {
    sql += ' AND s.platform = ?';
    params.push(filter.platform);
  }
  if (filter.from) {
    sql += ' AND s.submitted_at >= ?';
    params.push(filter.from);
  }
  if (filter.to) {
    // 日期写法（YYYY-MM-DD）是「含当天」的闭区间：submitted_at 存完整 ISO 时刻，
    // 直接 <= '2026-09-20' 会按字典序把当天所有提交排掉（都大于那个纯日期串）。
    // 与 history.ts 的 parseExclusiveTo 同口径：日期 → 次日零点 + 开区间。
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(filter.to);
    const nextDay = dateOnly ? Date.parse(`${filter.to}T00:00:00.000Z`) + 86_400_000 : NaN;
    if (Number.isFinite(nextDay)) {
      sql += ' AND s.submitted_at < ?';
      params.push(new Date(nextDay).toISOString());
    } else {
      sql += ' AND s.submitted_at <= ?';
      params.push(filter.to);
    }
  }
  return db.prepare(sql).all(...params) as unknown as SubmissionRow[];
}

export function computeOverall(
  db: Db,
  userId: number,
  filter: StatsFilter = {},
): OverallStats {
  const rows = fetchRows(db, userId, filter);
  const byPlatform = new Map<PlatformId, MutableStat>();
  // 始终显示全部接入平台（含 0 数据），避免平台列表中缺失（如洛谷未同步时仍展示）
  for (const p of PLATFORMS) {
    byPlatform.set(p.id, { attempts: 0, ac: 0 });
  }
  const byDifficulty = new Map<string, MutableStat>();
  const byTag = new Map<string, MutableStat>();
  const solvedSet = new Set<string>();
  const solvedByTag = new Map<string, Set<string>>();
  const solvedByPlatform = new Map<PlatformId, Set<string>>();

  for (const r of rows) {
    const isAc = r.verdict === 'AC';
    bump(byPlatform, r.platform, isAc);
    bump(byDifficulty, bucketForDifficulty(r.difficulty), isAc);
    for (const tag of filterNoiseTags(safeTags(r.tags)).map((t) => canonicalTag(t))) {
      bump(byTag, tag, isAc);
      if (isAc) {
        if (!solvedByTag.has(tag)) solvedByTag.set(tag, new Set());
        solvedByTag.get(tag)!.add(`${r.platform}:${r.problem_key}`);
      }
    }
    if (isAc) {
      solvedSet.add(`${r.platform}:${r.problem_key}`);
      if (!solvedByPlatform.has(r.platform)) solvedByPlatform.set(r.platform, new Set());
      solvedByPlatform.get(r.platform)!.add(r.problem_key);
    }
  }

  return {
    attempts: rows.length,
    ac: rows.filter((r) => r.verdict === 'AC').length,
    acRate: rate(rows.length, rows.filter((r) => r.verdict === 'AC').length),
    solvedProblems: solvedSet.size,
    byPlatform: [...byPlatform.entries()].map(([platform, s]) => ({
      platform,
      ...toStat(s),
      solved: solvedByPlatform.get(platform)?.size ?? 0,
    })),
    byDifficulty: [...byDifficulty.entries()].map(([bucket, s]) => ({
      bucket,
      ...toStat(s),
    })),
    byTag: [...byTag.entries()].map(([tag, s]) => ({
      tag,
      ...toStat(s),
      solved: solvedByTag.get(tag)?.size ?? 0,
    })),
  };
}

export interface MutableStat {
  attempts: number;
  ac: number;
}

export function bump(map: Map<string, MutableStat>, key: string, isAc: boolean): void {
  const cur = map.get(key) ?? { attempts: 0, ac: 0 };
  cur.attempts += 1;
  if (isAc) cur.ac += 1;
  map.set(key, cur);
}

function toStat(s: MutableStat): CountStat {
  return { attempts: s.attempts, ac: s.ac, acRate: rate(s.attempts, s.ac) };
}

export function rate(attempts: number, ac: number): number {
  return attempts === 0 ? 0 : Math.round((ac / attempts) * 1000) / 10;
}

export function safeTags(json: string): string[] {
  try {
    const t = JSON.parse(json) as unknown;
    return Array.isArray(t) ? t.map(String) : [];
  } catch {
    return [];
  }
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

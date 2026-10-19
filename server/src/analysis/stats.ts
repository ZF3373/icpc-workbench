import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS, canonicalTag } from '../../../shared/src/index.ts';
import { compareDifficultyBuckets, difficultyBucketOf } from '../../../shared/src/difficulty.ts';
import type { Db } from '../db/index.ts';
import { filterNoiseTags } from './tags.ts';
import { knowledgeTagsSql } from '../knowledge/store.ts';

/**
 * 难度分档（分档表唯一真源在 shared/src/difficulty.ts，此处保留既有导入名）。
 * 分档边界与档名不得在本文件另写一份。
 */
export const bucketForDifficulty = difficultyBucketOf;

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
  /** 归属账号 handle（多账号隔离）；必须与 platform 同时给，见 accountClause */
  account?: string;
}

/**
 * 账号作用域的 SQL 片段（供统计族共用，别名默认为 submissions 的 `s`）。
 * handle 只在平台内唯一（platform_accounts UNIQUE(user_id, platform, handle)），
 * 只给 account 不 platform 会跨平台静默合并同名账号（洛谷/牛客 uid 都是数字），
 * 因此这里直接拒绝，而不是猜一个作用域。
 */
export function accountClause(
  scope: { platform?: PlatformId; account?: string },
  alias = 's',
): { sql: string; params: Array<string | number> } {
  if (!scope.account) {
    if (!scope.platform) return { sql: '', params: [] };
    return { sql: ` AND ${alias}.platform = ?`, params: [scope.platform] };
  }
  if (!scope.platform) throw new Error('account 过滤必须同时指定 platform');
  return {
    sql: ` AND ${alias}.platform = ? AND ${alias}.account = ?`,
    params: [scope.platform, scope.account],
  };
}

export interface SubmissionRow {
  platform: PlatformId;
  verdict: string;
  submitted_at: string;
  problem_key: string;
  difficulty: number | null;
  tags: string;
}

/**
 * 时间窗的 SQL 片段（fetchRows 与 computeOverall 共用，保证两处口径一致）。
 * 日期写法（YYYY-MM-DD）是「含当天」的闭区间：submitted_at 存完整 ISO 时刻，
 * 直接 <= '2026-09-20' 会按字典序把当天所有提交排掉（都大于那个纯日期串）。
 * 与 history.ts 的 parseExclusiveTo 同口径：日期 → 次日零点 + 开区间。
 */
export function timeClause(filter: StatsFilter): { sql: string; params: Array<string | number> } {
  let sql = '';
  const params: Array<string | number> = [];
  if (filter.from) {
    sql += ' AND s.submitted_at >= ?';
    params.push(filter.from);
  }
  if (filter.to) {
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
  return { sql, params };
}

/** 未带 tags 的提交行：趋势/热力只用得到判定、时间、难度与题号。 */
export interface SubmissionLiteRow extends Omit<SubmissionRow, 'tags'> {}

/** 提交行查询的公共 WHERE 片段（账号作用域 + 时间窗），供 fetchRows / fetchLiteRows 共用 */
function rowWhere(
  userId: number,
  filter: StatsFilter,
): { sql: string; params: Array<string | number> } {
  const scope = accountClause(filter);
  const time = timeClause(filter);
  return {
    sql: ` WHERE s.user_id = ?${scope.sql}${time.sql}`,
    params: [userId, ...scope.params, ...time.params],
  };
}

/** 拉取用户提交（join problems），供统计/弱项/趋势共用。
 *  tags 列默认走知识点管线读取路径（problem_keypoints → 题源 tags 回退）；
 *  tagsSql 可覆盖（双口径对比时传 'p.tags AS tags' 取 tag 口径）。
 *  行序不显式排序：沿用 SQLite 选中的索引扫描序（byTag 的条目顺序依赖它，见 computeOverall）。 */
export function fetchRows(
  db: Db,
  userId: number,
  filter: StatsFilter = {},
  tagsSql?: string,
): SubmissionRow[] {
  const where = rowWhere(userId, filter);
  const sql = `
    SELECT s.platform, s.verdict, s.submitted_at, p.problem_key, p.difficulty,
           ${tagsSql ?? knowledgeTagsSql(db)}
    FROM submissions s JOIN problems p ON s.problem_id = p.id${where.sql}
  `;
  return db.prepare(sql).all(...where.params) as unknown as SubmissionRow[];
}

/**
 * 同 fetchRows 但不查 tags 列：tags 走 knowledgeTagsSql 时是逐行 EXISTS + 相关子查询，
 * 在 5 万提交上占了大半查询时间；趋势/热力完全不需要标签，用这条可以省掉。
 * orderBy 供趋势固定行序（difficultyDist 的键序依赖它）。
 */
export function fetchLiteRows(
  db: Db,
  userId: number,
  filter: StatsFilter = {},
  orderBy?: string,
): SubmissionLiteRow[] {
  const where = rowWhere(userId, filter);
  let sql = `
    SELECT s.platform, s.verdict, s.submitted_at, p.problem_key, p.difficulty
    FROM submissions s JOIN problems p ON s.problem_id = p.id${where.sql}
  `;
  if (orderBy) sql += ` ORDER BY ${orderBy}`;
  return db.prepare(sql).all(...where.params) as unknown as SubmissionLiteRow[];
}

/**
 * fetchRows 的行序键：SQLite 为 fetchRows 选索引时，带时间窗走
 * `idx_submissions_user_time`（submitted_at, id），否则走
 * `idx_submissions_user_account`（platform, account, id）。
 * 需要复刻该顺序的聚合（`computeOverall` 的 byTag 首次出现序）用 MIN(...) 还原「该题最早
 * 出现的那一份」，char(31) 分隔避免字段拼接歧义，id 补零保证按数值比较。
 */
function rowOrderKey(byTime: boolean): string {
  return byTime
    ? `s.submitted_at || char(31) || printf('%020d', s.id)`
    : `s.platform || char(31) || s.account || char(31) || printf('%020d', s.id)`;
}

/**
 * 总体统计。聚合法**按题目**（GROUP BY p.id）而不是按提交：标签/难度/平台都与具体
 * 提交无关，一题在窗口内的全部提交可以先压成一行（attempts/ac），再由 JS 展开。
 *
 * 为什么不把 tags 也用 json_each 在 SQL 里分组：byTag 的条目顺序是既有返回结构的一部分
 * （前端与导出的 Markdown 都按服务端顺序渲染），而它取决于 fetchRows 的行序下每个 tag
 * 首次出现的先后。fetchRows 的行序由 SQLite 选中的索引决定——带时间窗走
 * `idx_submissions_user_time`（submitted_at, id），否则走
 * `idx_submissions_user_account`（platform, account, id）。聚合时用 MIN(orderKey) 复刻
 * 这个行序，tags 仍由 knowledgeTagsSql 原样取出，因此 byTag 的顺序、去重口径与旧实现逐字节一致。
 */
export function computeOverall(
  db: Db,
  userId: number,
  filter: StatsFilter = {},
): OverallStats {
  const scope = accountClause(filter);
  const time = timeClause(filter);
  const rows = db
    .prepare(
      `SELECT p.platform AS platform, p.difficulty AS difficulty, p.problem_key AS problem_key,
              COUNT(*) AS attempts,
              SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END) AS ac,
              MIN(${rowOrderKey(time.sql !== '')}) AS first_seen,
              ${knowledgeTagsSql(db)}
         FROM submissions s JOIN problems p ON s.problem_id = p.id
        WHERE s.user_id = ?${scope.sql}${time.sql}
        GROUP BY p.id
        ORDER BY first_seen`,
    )
    .all(userId, ...scope.params, ...time.params) as unknown as Array<{
    platform: PlatformId;
    difficulty: number | null;
    problem_key: string;
    attempts: number;
    ac: number;
    tags: string;
  }>;

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
  let attempts = 0;
  let ac = 0;

  for (const r of rows) {
    const isAc = r.ac > 0;
    const n = r.attempts;
    attempts += n;
    ac += r.ac;
    let plat = byPlatform.get(r.platform);
    if (!plat) {
      // 平台枚举之外的脏值（历史数据）也要计入，旧实现同样会 bump 出新条目
      plat = { attempts: 0, ac: 0 };
      byPlatform.set(r.platform, plat);
    }
    plat.attempts += n;
    plat.ac += r.ac;
    const bucket = bucketForDifficulty(r.difficulty);
    const d = byDifficulty.get(bucket) ?? { attempts: 0, ac: 0 };
    d.attempts += n;
    d.ac += r.ac;
    byDifficulty.set(bucket, d);
    for (const tag of filterNoiseTags(safeTags(r.tags)).map((t) => canonicalTag(t))) {
      const t = byTag.get(tag) ?? { attempts: 0, ac: 0 };
      t.attempts += n;
      t.ac += r.ac;
      byTag.set(tag, t);
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
    attempts,
    ac,
    acRate: rate(attempts, ac),
    solvedProblems: solvedSet.size,
    byPlatform: [...byPlatform.entries()].map(([platform, s]) => ({
      platform,
      ...toStat(s),
      solved: solvedByPlatform.get(platform)?.size ?? 0,
    })),
    byDifficulty: [...byDifficulty.entries()]
      .map(([bucket, s]) => ({
        bucket,
        ...toStat(s),
      }))
      // 必须按档位升序返回：Map 的插入序取决于提交行的先后，数据一变横轴顺序就变 ——
      // 现场表现为 1400-1599 排在 1200-1399 前面（issue 37「统计图的神秘问题」）。
      .sort((a, b) => compareDifficultyBuckets(a.bucket, b.bucket)),
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

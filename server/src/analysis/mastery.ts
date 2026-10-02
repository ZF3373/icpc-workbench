/**
 * 知识点掌握度地图：把三类既有数据串成闭环——
 * 刷题记录（按标签聚合 solved / AC 率 / 近期活跃度）
 * × 弱项画像基准（相对自身平均 AC 率的 gap）
 * × 模板课程（每个知识点关联的课程模板与学习状态）。
 * 掌握度档位完全由练习数据推导：未开始（仅出现在课程大纲中）/ 接触 / 入门 / 掌握 / 熟练。
 */
import type {
  MasteryLevel,
  MasteryPoint,
  MasteryReport,
  MasteryTemplateLink,
  PlatformId,
} from '../../../shared/src/index.ts';
import { canonicalTag, expandTag } from '../../../shared/src/index.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import type { Db } from '../db/index.ts';
import { accountClause, fetchRows, rate, round2, safeTags } from './stats.ts';
import { filterNoiseTags } from './tags.ts';
import { allPoints } from '../knowledge/taxonomy.ts';
import { getConfidenceThreshold, READABLE_SOURCES_SQL } from '../knowledge/store.ts';

const RECENT_WINDOW_DAYS = 56;

export interface MasteryOptions {
  /** 保留至少 N 道题的练习知识点（0 = 连课程里还没刷过的知识点也输出） */
  minSolved?: number;
  /** 账号/平台作用域（须同时给）：省略 = 全部账号 */
  platform?: PlatformId;
  account?: string;
}

/**
 * 由练习数据推导掌握度档位（solved 为去重后的通过题数；acRate 为百分数 0-100，
 * 与 analysis/stats.ts 的 rate() 同量纲，只作为最高档「熟练」的质量门槛）。
 */
export function levelFor(solved: number, acRate: number): MasteryLevel {
  if (solved >= 20 && acRate >= 70) return 4;
  if (solved >= 10) return 3;
  if (solved >= 5) return 2;
  if (solved >= 1) return 1;
  return 0;
}

/** template_progress 状态表（一次加载，供全部 tag 复用，避免逐 tag 重复查询） */
export function loadTemplateStatuses(
  db: Db,
  userId: number,
): Map<string, 'todo' | 'learning' | 'mastered'> {
  const statusRows = db
    .prepare('SELECT template_id, status FROM template_progress WHERE user_id = ?')
    .all(userId) as unknown as Array<{ template_id: string; status: string }>;
  const statusOf = new Map<string, 'todo' | 'learning' | 'mastered'>();
  for (const row of statusRows) {
    statusOf.set(
      row.template_id,
      row.status === 'learning' || row.status === 'mastered' ? row.status : 'todo',
    );
  }
  return statusOf;
}

/** tag → 关联的课程模板（含学习状态），供掌握度页直跳模板库 */
export function templatesForTag(
  db: Db,
  userId: number,
  tag: string,
  preloadStatus?: Map<string, 'todo' | 'learning' | 'mastered'>,
): MasteryTemplateLink[] {
  const statusOf = preloadStatus ?? loadTemplateStatuses(db, userId);
  const links: MasteryTemplateLink[] = [];
  const aliases = new Set(expandTag(tag));
  for (const cat of CURRICULUM) {
    for (const t of cat.templates) {
      if (!t.tags.some((tt) => aliases.has(tt))) continue;
      links.push({
        id: t.id,
        name: t.name,
        categoryKey: cat.key,
        categoryName: cat.name,
        status: statusOf.get(t.id) ?? 'todo',
      });
    }
  }
  return links;
}

/**
 * 掌握度地图（知识点口径）：有达标知识点标注的提交按 taxonomy code 聚合、
 * templateIds 直达课程（比 tag 更准）；无标注的提交回退净化 tag 聚合（未覆盖桶），
 * 与同名 code 合并，避免切换期同一知识点裂成两个点。
 */
export function computeMastery(db: Db, userId: number, opts: MasteryOptions = {}): MasteryReport {
  const minSolved = Math.max(0, opts.minSolved ?? 0);
  const threshold = getConfidenceThreshold(db);
  const statusMap = loadTemplateStatuses(db, userId);
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
  const scope = { platform: opts.platform, account: opts.account };
  const clause = accountClause(scope);

  // 总体 AC 率是掌握度 gap 的基准，必须与知识点统计同一作用域，否则「相对自身平均」
  // 仍是全部账号的稀释平均
  const totals = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac FROM submissions s WHERE s.user_id = ?${clause.sql}`)
    .get(userId, ...clause.params) as { n: number; ac: number };
  const avgAcRate = rate(totals.n, totals.ac);

  interface Acc {
    attempts: number;
    ac: number;
    solved: Set<string>;
    recentSolved: Set<string>;
  }
  const bumpAcc = (map: Map<string, Acc>, key: string, isAc: boolean, platform: string, problemKey: string, submittedAt: string): void => {
    let acc = map.get(key);
    if (!acc) {
      acc = { attempts: 0, ac: 0, solved: new Set(), recentSolved: new Set() };
      map.set(key, acc);
    }
    acc.attempts += 1;
    if (isAc) {
      acc.ac += 1;
      acc.solved.add(`${platform}:${problemKey}`);
      if (submittedAt >= recentCutoff) acc.recentSolved.add(`${platform}:${problemKey}`);
    }
  };

  // 1) 知识点口径：problem_keypoints 达标标注（一题多 code 各自计入）
  const byCode = new Map<string, Acc>();
  const codeRows = db
    .prepare(
      `SELECT s.platform, s.verdict, s.submitted_at, p.problem_key, pk.code
       FROM submissions s
       JOIN problems p ON s.problem_id = p.id
       JOIN problem_keypoints pk ON pk.platform = p.platform AND pk.problem_key = p.problem_key AND pk.confidence >= ? AND pk.${READABLE_SOURCES_SQL}
       WHERE s.user_id = ?${clause.sql}`,
    )
    .all(threshold, userId, ...clause.params) as unknown as Array<{
    platform: string;
    verdict: string;
    submitted_at: string;
    problem_key: string;
    code: string;
  }>;
  for (const r of codeRows) {
    bumpAcc(byCode, r.code, r.verdict === 'AC', r.platform, r.problem_key, r.submitted_at);
  }

  // 2) 未覆盖回退：无达标标注的提交按净化 tag 聚合；与 taxonomy 同名的并入对应 code
  const nameToCode = new Map(allPoints().map((p) => [p.name, p.code]));
  const fallbackSql =
    `CASE WHEN EXISTS (SELECT 1 FROM problem_keypoints pk WHERE pk.platform = p.platform AND pk.problem_key = p.problem_key AND pk.confidence >= ${threshold} AND pk.${READABLE_SOURCES_SQL}) ` +
    `THEN '[]' ELSE p.tags END AS tags`;
  const fallbackRows = fetchRows(db, userId, scope, fallbackSql);
  const byTag = new Map<string, Acc>();
  for (const r of fallbackRows) {
    const isAc = r.verdict === 'AC';
    // CF 等平台的英文标签归并到课程中文知识点（binary search → 二分），避免同一知识点拆成两个点
    for (const tag of filterNoiseTags(safeTags(r.tags)).map((t) => canonicalTag(t))) {
      const code = nameToCode.get(tag);
      if (code) bumpAcc(byCode, code, isAc, r.platform, r.problem_key, r.submitted_at);
      else bumpAcc(byTag, tag, isAc, r.platform, r.problem_key, r.submitted_at);
    }
  }

  // 课程模板索引：templateIds 直达课程（掌握度地图「看课」入口）
  const templateIndex = new Map(
    CURRICULUM.flatMap((cat) => cat.templates.map((t) => [t.id, { t, cat }] as const)),
  );

  const points: MasteryPoint[] = [];
  const pushPoint = (tag: string, code: string | undefined, acc: Acc | undefined, templates: MasteryTemplateLink[]): void => {
    const solved = acc?.solved.size ?? 0;
    if (solved < minSolved) return;
    const attempts = acc?.attempts ?? 0;
    const ac = acc?.ac ?? 0;
    const acRate = attempts > 0 ? rate(attempts, ac) : 0;
    points.push({
      tag,
      ...(code !== undefined ? { code } : {}),
      solved,
      attempts,
      acRate,
      avgAcRate,
      gap: round2(avgAcRate - acRate),
      level: levelFor(solved, acRate),
      recentSolved: acc?.recentSolved.size ?? 0,
      templates,
    });
  };

  // taxonomy 全部 code 进地图（0 练习 = 未开始，正是地图要暴露的盲区）
  for (const p of allPoints()) {
    const templates: MasteryTemplateLink[] = [];
    for (const id of p.templateIds ?? []) {
      const found = templateIndex.get(id);
      if (!found) continue;
      templates.push({
        id: found.t.id,
        name: found.t.name,
        categoryKey: found.cat.key,
        categoryName: found.cat.name,
        status: statusMap.get(id) ?? 'todo',
      });
    }
    pushPoint(p.name, p.code, byCode.get(p.code), templates);
  }
  // 未覆盖桶：无法归入 taxonomy 的净化 tag（brute force 等保留原样）
  for (const [tag, acc] of byTag) {
    pushPoint(tag, undefined, acc, templatesForTag(db, userId, tag, statusMap));
  }

  points.sort((a, b) => b.level - a.level || b.solved - a.solved || a.tag.localeCompare(b.tag));
  return { generatedAt: new Date().toISOString(), points };
}

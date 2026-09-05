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
} from '../../../shared/src/index.ts';
import { canonicalTag, expandTag } from '../../../shared/src/index.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import type { Db } from '../db/index.ts';
import { fetchRows, rate, round2, safeTags } from './stats.ts';
import { filterNoiseTags } from './tags.ts';

const RECENT_WINDOW_DAYS = 56;

export interface MasteryOptions {
  /** 保留至少 N 道题的练习知识点（0 = 连课程里还没刷过的知识点也输出） */
  minSolved?: number;
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

export function computeMastery(db: Db, userId: number, opts: MasteryOptions = {}): MasteryReport {
  const minSolved = Math.max(0, opts.minSolved ?? 0);
  const rows = fetchRows(db, userId);
  const totalAc = rows.filter((r) => r.verdict === 'AC').length;
  const avgAcRate = rate(rows.length, totalAc);

  interface Acc {
    attempts: number;
    ac: number;
    solved: Set<string>;
    recentSolved: Set<string>;
  }
  const byTag = new Map<string, Acc>();
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();

  for (const r of rows) {
    const isAc = r.verdict === 'AC';
    for (const rawTag of filterNoiseTags(safeTags(r.tags))) {
      // CF 等平台的英文标签归并到课程中文知识点（binary search → 二分），避免同一知识点拆成两个点
      const tag = canonicalTag(rawTag);
      let acc = byTag.get(tag);
      if (!acc) {
        acc = { attempts: 0, ac: 0, solved: new Set(), recentSolved: new Set() };
        byTag.set(tag, acc);
      }
      acc.attempts += 1;
      if (isAc) {
        acc.ac += 1;
        acc.solved.add(`${r.platform}:${r.problem_key}`);
        if (r.submitted_at >= recentCutoff) acc.recentSolved.add(`${r.platform}:${r.problem_key}`);
      }
    }
  }

  // 课程大纲中出现的知识点即使 0 练习也纳入（「未开始」正是地图要暴露的盲区）；
  // 同样做别名归并（课程里个别模板直接写了英文别名 tag，如 two pointers）
  const curriculumTags = new Set<string>();
  for (const cat of CURRICULUM) for (const t of cat.templates) for (const tag of t.tags) curriculumTags.add(canonicalTag(tag));

  const tags = new Set<string>([...byTag.keys(), ...curriculumTags]);
  // 学习状态一次性加载，避免逐 tag 重复查询 template_progress（tag 数量 100+）
  const statusMap = loadTemplateStatuses(db, userId);
  const points: MasteryPoint[] = [];
  for (const tag of tags) {
    const acc = byTag.get(tag);
    const solved = acc?.solved.size ?? 0;
    if (solved < minSolved) continue;
    const attempts = acc?.attempts ?? 0;
    const ac = acc?.ac ?? 0;
    const acRate = attempts > 0 ? rate(attempts, ac) : 0;
    points.push({
      tag,
      solved,
      attempts,
      acRate,
      avgAcRate,
      gap: round2(avgAcRate - acRate),
      level: levelFor(solved, acRate),
      recentSolved: acc?.recentSolved.size ?? 0,
      templates: templatesForTag(db, userId, tag, statusMap),
    });
  }

  points.sort((a, b) => b.level - a.level || b.solved - a.solved || a.tag.localeCompare(b.tag));
  return { generatedAt: new Date().toISOString(), points };
}

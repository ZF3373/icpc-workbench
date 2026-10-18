/**
 * 知识点掌握度地图：把三类既有数据串成闭环——
 * 刷题记录（按标签聚合 solved / AC 率 / 近期活跃度）
 * × 弱项画像基准（相对自身平均 AC 率的 gap）
 * × 模板课程（每个知识点关联的课程模板与学习状态）。
 * 档位按去重题目的有效掌握证据推导（卡点降权、成功复习恢复）：未开始 / 接触 / 入门 / 掌握 / 熟练。
 */
import type {
  MasteryLevel,
  MasteryPoint,
  MasteryReport,
  MasteryTemplateLink,
  PlatformId,
} from '../../../shared/src/index.ts';
import { canonicalTag, codeOfTag, expandTag } from '../../../shared/src/index.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import type { Db } from '../db/index.ts';
import { accountClause, rate, round2, safeTags } from './stats.ts';
import { filterNoiseTags } from './tags.ts';
import { allPoints } from '../knowledge/taxonomy.ts';
import { getConfidenceThreshold, READABLE_SOURCES_SQL } from '../knowledge/store.ts';
import { loadPracticeEvidence } from './practiceEvidence.ts';
import { problemIdentity } from '../problems/identity.ts';

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
  const evidenceFor = loadPracticeEvidence(db, userId);

  interface Acc {
    attempts: number;
    ac: number;
    solved: Set<string>;
    recentSolved: Set<string>;
    attempted: Set<string>;
    evidenceSolved: Set<string>;
  }
  /**
   * 按题聚合后的一次性累加：attempts/ac 为整题合计；
   * attempted 记录「练过的题」（无论是否 AC，与旧实现逐提交 bump 的集合内容一致），
   * solved/recentSolved/evidenceSolved 只在该题至少一次 AC 时计入。
   */
  const bumpProblem = (
    map: Map<string, Acc>,
    key: string,
    attempts: number,
    ac: number,
    hadRecentAc: boolean,
    platform: string,
    problemKey: string,
  ): void => {
    let acc = map.get(key);
    if (!acc) {
      acc = { attempts: 0, ac: 0, solved: new Set(), recentSolved: new Set(), attempted: new Set(), evidenceSolved: new Set() };
      map.set(key, acc);
    }
    acc.attempts += attempts;
    const identity = problemIdentity({ platform, problemKey });
    acc.attempted.add(identity);
    if (ac > 0) {
      acc.ac += ac;
      acc.solved.add(`${platform}:${problemKey}`);
      acc.evidenceSolved.add(identity);
      if (hadRecentAc) acc.recentSolved.add(`${platform}:${problemKey}`);
    }
  };

  // 提交先按题压成一行（attempts / ac / 近期是否 AC）：标签、知识点和判定都与具体提交无关，
  // 一题无论刷了多少次都只需处理一次。旧实现每条提交各跑一遍 JOIN（知识点口径 + 回退口径
  // 两次全量扫描），5 万提交时两段各扫 5 万行，同一题在 JS 里被重复累加数十次。
  //
  // 知识点用 json_group_array 在题目级一次取回（无标注 = '[]' → 走 tag 回退），
  // 取代旧实现「EXISTS 决定 tags 是否取 '[]' + 另跑一次 JOIN 拿 code」的两遍写法：
  // 标注表只在这里点查一次，回退判断直接看数组是否为空。
  //
  // 总体 AC 率的基准也在 CTE 层汇总（tot 单行，CROSS JOIN 代价可忽略）：旧实现的总计查询
  // 不 JOIN problems，指向已删题目的提交（正常情况下外键拦住了，只可能来自历史脏库）仍计入分母；
  // 直接对 JOIN 后的行求和会把这类提交静默漏掉，改变 gap 基准。
  //
  // 不排序：返回结构不受影响 —— 各知识点只累加计数与集合（去重后与顺序无关），
  // points 末尾另有全序排序 (level, solved, tag)，且 tag 在同一点集内唯一。
  // 唯一与顺序有关的浮点累加（evidence 的 creditedSolved/supportGap）按题目集合求和，
  // 对真实库（984 条提交）与合成库（5 万条提交）验证过：改变扫描序后输出仍逐字节一致。
  //
  // 口径提醒：近期 AC 用 MAX(CASE ...) 而不是比较 MAX(submitted_at) —— 窗口口径是
  // 「56 天内有过 AC」，取时间最大值会把「很久前 AC + 最近一次 WA」误判为非近期。
  const rows = db
    .prepare(
      `WITH sub AS MATERIALIZED (
         SELECT s.problem_id AS problem_id, s.platform AS platform,
                COUNT(*) AS attempts,
                SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END) AS ac,
                MAX(CASE WHEN s.verdict = 'AC' AND s.submitted_at >= ? THEN 1 ELSE 0 END) AS recent_ac
           FROM submissions s
          WHERE s.user_id = ?${clause.sql}
          GROUP BY s.problem_id, s.platform
       ), tot AS (
         SELECT COALESCE(SUM(attempts), 0) AS attempts, COALESCE(SUM(ac), 0) AS ac FROM sub
       )
       SELECT sub.platform AS platform, p.problem_key AS problem_key, p.tags AS tags,
              sub.attempts AS attempts, sub.ac AS ac, sub.recent_ac AS recent_ac,
              tot.attempts AS total_attempts, tot.ac AS total_ac,
              COALESCE((SELECT json_group_array(pk.code) FROM problem_keypoints pk
                         WHERE pk.platform = p.platform AND pk.problem_key = p.problem_key
                           AND pk.confidence >= ? AND pk.${READABLE_SOURCES_SQL}), '[]') AS codes
         FROM sub JOIN problems p ON p.id = sub.problem_id CROSS JOIN tot`,
    )
    .all(recentCutoff, userId, ...clause.params, threshold) as unknown as Array<{
    platform: string;
    problem_key: string;
    tags: string;
    attempts: number;
    ac: number;
    recent_ac: number;
    total_attempts: number;
    total_ac: number;
    codes: string;
  }>;

  // 总计与行集同时返回（老实现另跑一次 COUNT/SUM 全表扫描）；全部同作用域，
  // 「相对自身平均」的基准不会退化成全部账号的稀释平均。
  const avgAcRate = rate(rows[0]?.total_attempts ?? 0, rows[0]?.total_ac ?? 0);

  const byCode = new Map<string, Acc>();
  const byTag = new Map<string, Acc>();
  const nameToCode = new Map(allPoints().map((p) => [p.name, p.code]));

  for (const r of rows) {
    const hadRecentAc = r.recent_ac === 1;
    const codes = JSON.parse(r.codes) as string[];
    if (codes.length > 0) {
      // 知识点口径：problem_keypoints 达标标注（一题多 code 各自计入）
      for (const code of codes) {
        bumpProblem(byCode, code, r.attempts, r.ac, hadRecentAc, r.platform, r.problem_key);
      }
      continue;
    }
    // 未覆盖回退：无达标标注的题按净化 tag 聚合；与 taxonomy 同名的并入对应 code
    // （CF 等平台的英文标签归并到课程中文知识点：binary search → 二分，避免同一知识点拆成两个点）
    for (const tag of new Set(filterNoiseTags(safeTags(r.tags)).map((t) => canonicalTag(t)))) {
      const code = nameToCode.get(tag);
      if (code) bumpProblem(byCode, code, r.attempts, r.ac, hadRecentAc, r.platform, r.problem_key);
      else bumpProblem(byTag, tag, r.attempts, r.ac, hadRecentAc, r.platform, r.problem_key);
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
    const evidence = evidenceFor(acc?.attempted ?? new Set(), acc?.evidenceSolved ?? new Set(), code ?? codeOfTag(tag));
    const gap = round2(avgAcRate - acRate);
    points.push({
      tag,
      ...(code !== undefined ? { code } : {}),
      solved,
      attempts,
      acRate,
      avgAcRate,
      gap,
      // 有过通过即至少「接触」，折算题量不能把已学过的知识点显示为「未开始」。
      level: levelFor(solved > 0 ? Math.max(1, evidence.creditedSolved) : 0, acRate),
      recentSolved: acc?.recentSolved.size ?? 0,
      templates,
      evidence,
      evidenceGap: round2(gap + evidence.supportGap),
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

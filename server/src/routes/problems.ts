import { Router } from 'express';
import { canonicalTag, expandTag, filterNoiseTags } from '../../../shared/src/index.ts';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { nativeDifficultyLabel } from '../../../shared/src/difficulty.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { safeTags } from '../analysis/stats.ts';
import { backfillDifficulties } from '../analysis/difficultyBackfill.ts';
import { fetchLuoguBank, fetchNowcoderBank, fetchCodeforcesBank, fetchLeetcodeBank, fetchAtcoderBank, fetchDaimayuanBank, fetchJisuankeBank } from '../adapters/problemBank.ts';
import type { LuoguProblemType } from '../adapters/problemBank.ts';
import { upsertBankProblems } from '../import/bankService.ts';
import { problemKeypointsCte, knowledgeTagsJoinSql, knowledgeTagsCoalesceSql, knowledgeTagsExpr, appendAnnotations, effectiveDataDir, tombstoneLine } from '../knowledge/store.ts';
import { isValidCode } from '../knowledge/taxonomy.ts';
import { annotateProblemsL1 } from '../knowledge/pipeline.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

interface ProblemRow {
  id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string;
  /** 平台原生难度原文（未知为 null；与 difficulty 双标度并存） */
  native_difficulty: string | null;
  /** 原生难度所属标度（见 shared/src/difficulty.ts） */
  difficulty_scale: string | null;
  attempts: number;
  ac_count: number;
  last_ac_at: string | null;
  /** 已在复习队列时为 review_items.id，否则 null */
  review_item_id: number | null;
}

/** deleted_problems 墓碑行（含删除时刻的题目快照，回收站恢复依据；快照列对旧墓碑可为 null） */
interface ProblemSnapshot {
  platform: string;
  problem_key: string;
  deleted_at: string;
  title: string | null;
  difficulty: number | null;
  url: string | null;
  tags: string | null;
  difficulty_source: string | null;
  native_difficulty: string | null;
  difficulty_scale: string | null;
}

/** 难度分桶（与客户端 DIFF_BUCKETS / analysis/stats.bucketForDifficulty 同口径） */
const DIFFICULTY_BUCKETS: Record<string, { min: number | null; max: number | null }> = {
  '未知': { min: null, max: null },
  '<1200': { min: null, max: 1199 },
  '1200-1399': { min: 1200, max: 1399 },
  '1400-1599': { min: 1400, max: 1599 },
  '1600-1899': { min: 1600, max: 1899 },
  '1900-2199': { min: 1900, max: 2199 },
  '2200+': { min: 2200, max: null },
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/** 洛谷题库类型白名单（与 adapters/problemBank.ts 的 LuoguProblemType 同源；此处只做入参校验） */
const LUOGU_PROBLEM_TYPES: ReadonlySet<LuoguProblemType> = new Set<LuoguProblemType>([
  'P', 'B', 'CF', 'AT', 'SP', 'UVA',
]);

type StatusFilter = 'all' | 'ac' | 'tried' | 'none';

const STATUS_FILTERS: ReadonlySet<string> = new Set<StatusFilter>(['all', 'ac', 'tried', 'none']);

/** 请求里的过滤条件（解析后的强类型形态） */
interface ProblemFilters {
  platform?: string;
  /** 难度区间（闭区间，rating 标尺） */
  diffMin?: number;
  diffMax?: number;
  /** 已展开同义别名的标签集合；空集 = 不限标签 */
  tagAliases: string[];
  q?: string;
  /** 是否包含未做过的题库题 */
  includeBank: boolean;
  status: StatusFilter;
  /** 只保留难度未知的题（difficulty=未知 分桶） */
  unknownOnly: boolean;
}

/**
 * 把过滤条件下推成 SQL 片段（不含状态，状态需在聚合后判定）。
 *
 * 关键性能取舍：difficulty / tag 曾在前端对「全量 1.9 万行」用 JS filter 过滤，
 * 现在全部变成 SQL 条件 —— 难度按分桶区间下推，标签用 json_each 展开成 EXISTS
 * （JSON 数组支持 GIN 式逐元素匹配，无需把行取回内存再嗅探）。
 * 唯一的例外是**标签的来源**：三来源回退链最终落到 problem_keypoints.name，
 * 它是派生值，只能对 COALESCE 后的 tags 做 json_each —— 所以本函数要求调用方
 * 已 WITH problemKeypointsCte 并 LEFT JOIN，否则 COALESCE 里的 pk 无法绑定。
 */
function buildProblemFilterSql(f: ProblemFilters): { where: string; params: Array<string | number> } {
  let where = '';
  const params: Array<string | number> = [];
  if (!f.includeBank) {
    where += ' AND EXISTS (SELECT 1 FROM submissions s2 WHERE s2.problem_id = p.id AND s2.user_id = ?)';
    params.push(DEFAULT_USER_ID);
  }
  if (f.platform !== undefined) {
    where += ' AND p.platform = ?';
    params.push(f.platform);
  }
  if (f.q !== undefined) {
    // 关键词按字面量匹配：不转义的话用户输入 % 或 _ 会变成通配符（'1_2' 能命中 '112'）
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where += ` AND (p.title LIKE ? ESCAPE '\\' OR p.problem_key LIKE ? ESCAPE '\\')`;
    params.push(like, like);
  }
  // 难度：JS 分支分支成闭区间；未知难度的题在设置区间后不显示（与原客户端行为一致）
  if (f.diffMin !== undefined || f.diffMax !== undefined) {
    where += ' AND p.difficulty IS NOT NULL';
    if (f.diffMin !== undefined) {
      where += ' AND p.difficulty >= ?';
      params.push(f.diffMin);
    }
    if (f.diffMax !== undefined) {
      where += ' AND p.difficulty <= ?';
      params.push(f.diffMax);
    }
  }
  // 标签：所选标签「逻辑或」——任一别名命中即保留
  if (f.tagAliases.length > 0) {
    where +=
      ' AND EXISTS (SELECT 1 FROM json_each(' + knowledgeTagsExpr() +
      ') je WHERE je.value IN (' + f.tagAliases.map(() => '?').join(', ') + '))';
    params.push(...f.tagAliases);
  }
  return { where, params };
}

/** 状态过滤：需在 COUNT/SUM 聚合之后判定 */
function statusHavingSql(status: StatusFilter): string {
  if (status === 'ac') return ' HAVING ac_count > 0';
  if (status === 'tried') return ' HAVING attempts > 0 AND ac_count = 0';
  if (status === 'none') return ' HAVING attempts = 0';
  return '';
}

/** 解析查询串为强类型过滤条件；非法值直接忽略（与原实现的宽松行为一致） */
function parseFilters(query: Record<string, unknown>): ProblemFilters {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: ProblemFilters = {
    tagAliases: [],
    includeBank: query.bank === '1',
    status: 'all',
    unknownOnly: false,
  };
  const platform = str(query.platform);
  if (platform !== undefined) out.platform = platform;
  const q = str(query.q);
  if (q !== undefined && q.trim() !== '') out.q = q;

  // 难度：优先显式区间 diffMin/diffMax；其次兼容 bucket 名（difficulty=<1200 / 未知 等）
  let diffMin = num(query.diffMin);
  let diffMax = num(query.diffMax);
  let unknownOnly = false;
  const bucket = str(query.difficulty);
  if (bucket !== undefined) {
    if (bucket === '未知') {
      unknownOnly = true;
    } else {
      const range = DIFFICULTY_BUCKETS[bucket];
      if (range !== undefined) {
        // '<1200' 桶的下界取 0（difficulty 恒非负），使区间可下推为闭区间
        if (range.min !== null) diffMin = range.min;
        else diffMin = 0;
        if (range.max !== null) diffMax = range.max;
        else diffMax = undefined;
      }
    }
  }
  out.unknownOnly = unknownOnly;
  if (!unknownOnly) {
    if (diffMin !== undefined) out.diffMin = diffMin;
    if (diffMax !== undefined) out.diffMax = diffMax;
  }

  // 标签：单个 tag 参数或 tag 数组；展开同义别名后 OR 组合
  const raw = query.tag;
  const list: string[] = [];
  if (typeof raw === 'string' && raw !== '') list.push(raw);
  else if (Array.isArray(raw)) for (const t of raw) if (typeof t === 'string' && t !== '') list.push(t);
  const aliases = new Set<string>();
  for (const t of list) for (const name of expandTag(t)) aliases.add(name);
  out.tagAliases = [...aliases];

  const status = query.status;
  if (typeof status === 'string' && STATUS_FILTERS.has(status)) out.status = status as StatusFilter;
  return out;
}

/**
 * 题库拉取（POST /bank）与难度回填（POST /backfill-difficulty）都经此 fetch 打上游。
 * 默认注入全局按域名节流层（net/hostThrottle.ts）：这两条路径请求量最大
 * （逐题回填可上千次），必须与提交同步共享同一份节奏桶，否则会同时打同一站点。
 */
export function problemsRoutes(db: Db, fetchFn: typeof fetch = throttledFetch): Router {
  const r = Router();

  /** 共享的 SELECT/GROUP BY 骨架：标注侧先聚合成 pk 派生表，再 LEFT JOIN（消逐行子查询） */
  const coreFrom = `
      FROM problems p
      LEFT JOIN submissions s ON s.problem_id = p.id AND s.user_id = ?
      ${knowledgeTagsJoinSql()}
      WHERE 1 = 1
  `;
  const coreSelect = `
      SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
             p.native_difficulty, p.difficulty_scale,
             ${knowledgeTagsCoalesceSql()},
             COUNT(s.id) AS attempts,
             COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count,
             MAX(CASE WHEN s.verdict = 'AC' THEN s.submitted_at END) AS last_ac_at,
             (SELECT ri.id FROM review_items ri
               WHERE ri.problem_id = p.id AND ri.user_id = ${DEFAULT_USER_ID}) AS review_item_id
  `;
  /** 分页查询与计数查询共用的 FROM/WHERE（含未知难度分支），保证两者口径完全一致 */
  const filteredFrom = (f: ProblemFilters): { from: string; params: Array<string | number> } => {
    const { where, params } = buildProblemFilterSql(f);
    return {
      from: coreFrom + where + (f.unknownOnly ? ' AND p.difficulty IS NULL' : ''),
      params,
    };
  };

  /**
   * GET /api/problems?platform=&difficulty=&tag=&q=&bank=1
   * 兼容路径：不传 page/pageSize 时返回**数组**（掌握度地图等既有调用方依赖此形态）。
   * 题库页请改用 /api/problems/page（分页 + 总数），否则 1.9 万行会一次性传回。
   */
  r.get('/', (req, res) => {
    const { platform } = req.query;
    if (typeof platform === 'string' && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const { from, params } = filteredFrom(filters);
    const sql =
      `WITH ${problemKeypointsCte(db)} ` +
      coreSelect +
      from +
      ' GROUP BY p.id' +
      statusHavingSql(filters.status) +
      ' ORDER BY p.difficulty IS NULL, p.difficulty DESC, p.id DESC';
    const rows = db.prepare(sql).all(DEFAULT_USER_ID, ...params) as unknown as ProblemRow[];
    res.json(rows.map(toApiProblem));
  });

  /**
   * GET /api/problems/page?page=1&pageSize=50&...同上的过滤参数
   * 服务端分页：总数与当前页分两次查询（COUNT 走同一过滤条件但不取标注 JSON）。
   * 响应：{ items, total, page, pageSize, hasMore }
   */
  r.get('/page', (req, res) => {
    const { platform } = req.query;
    if (typeof platform === 'string' && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const pageSize = clampInt(req.query.pageSize, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const page = clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const offset = (page - 1) * pageSize;
    const { from, params } = filteredFrom(filters);

    const listSql =
      `WITH ${problemKeypointsCte(db)} ` +
      coreSelect +
      from +
      ' GROUP BY p.id' +
      statusHavingSql(filters.status) +
      ' ORDER BY p.difficulty IS NULL, p.difficulty DESC, p.id DESC LIMIT ? OFFSET ?';
    const items = db
      .prepare(listSql)
      .all(DEFAULT_USER_ID, ...params, pageSize, offset) as unknown as ProblemRow[];

    // COUNT 不取标注 JSON（标签过滤已下推到 WHERE），但必须保留 attempts/ac_count 两个
    // 聚合别名 —— statusHavingSql 的 HAVING 引用的正是它们，内层 SELECT 少了别名即报
    // "no such column: ac_count"
    const countSql =
      `WITH ${problemKeypointsCte(db)} ` +
      `SELECT COUNT(*) AS c FROM (SELECT p.id,` +
      ' COUNT(s.id) AS attempts,' +
      " COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count" +
      from +
      ' GROUP BY p.id' +
      statusHavingSql(filters.status) +
      ')';
    const total = (db.prepare(countSql).get(DEFAULT_USER_ID, ...params) as { c: number }).c;

    res.json({
      items: items.map(toApiProblem),
      total,
      page,
      pageSize,
      hasMore: offset + items.length < total,
    });
  });

  /**
   * GET /api/problems/facets?...同上的过滤参数
   * 侧边栏徽标数据：难度分桶 / 平台分布 / 标签计数。
   * 全部由 SQL 聚合得出，不再要求前端持有全量行。
   */
  r.get('/facets', (req, res) => {
    const { platform } = req.query;
    if (typeof platform === 'string' && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const filters = parseFilters(req.query as Record<string, unknown>);
    const { from, params } = filteredFrom(filters);
    // 分面统计不带状态页签（页签是列表视图的局部条件），故不套用 statusHavingSql
    const sql =
      `WITH ${problemKeypointsCte(db)} ` +
      `SELECT p.id, p.platform AS platform, p.difficulty AS difficulty, ${knowledgeTagsCoalesceSql()} ` +
      from +
      ' GROUP BY p.id';
    const rows = db.prepare(sql).all(DEFAULT_USER_ID, ...params) as unknown as Array<{
      id: number;
      platform: PlatformId;
      difficulty: number | null;
      tags: string;
    }>;

    const difficulty: Record<string, number> = {};
    for (const key of Object.keys(DIFFICULTY_BUCKETS)) difficulty[key] = 0;
    const platformCounts: Record<string, number> = {};
    for (const p of PLATFORMS) platformCounts[p.id] = 0;
    const tagCounts = new Map<string, number>();
    for (const row of rows) {
      difficulty[bucketName(row.difficulty)] += 1;
      platformCounts[row.platform] = (platformCounts[row.platform] ?? 0) + 1;
      // 与客户端侧边栏同口径：先滤噪声标签，再归并到规范名，同题内去重后计数
      const tags = new Set(filterNoiseTags(safeTags(row.tags)).map((t) => canonicalTag(t)));
      for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    res.json({
      total: rows.length,
      difficulty,
      platforms: PLATFORMS.map((p) => ({ id: p.id, name: p.name, count: platformCounts[p.id] ?? 0 })),
      tags: [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    });
  });

  // POST /api/problems/bank
  // body: { platform: 'luogu' | 'nowcoder' | 'codeforces' | 'leetcode' | 'atcoder' | 'daimayuan' | 'jisuanke',
  //         max?, luoguMinDifficulty?, luoguTypes?, atcoderTags? }
  // 拉取公开题库入库（匿名可访问），扩充待选题目池（不产生提交记录）。
  // codeforces / atcoder 为单次 API 调用（全量），通常仅在刷新内置快照后的新题时使用。
  // luoguTypes：洛谷题库类型（'P' 普通题 / 'CF'、'AT' 镜像题 / 'B' 入门与面试 / 'SP'、'UVA'），
  //   默认 ['P']；镜像题用来批量补齐 CF/AtCoder 题面上的中文标签。
  // atcoderTags：用洛谷 AT 镜像题给 AtCoder 题补算法标签（覆盖有限，命中计数随响应回传）。
  r.post('/bank', asyncHandler(async (req, res) => {
    const { platform, max, luoguMinDifficulty, luoguTypes, atcoderTags } = req.body ?? {};
    // QOJ 没有公开题库页（站点在 Cloudflare 挑战之后，且平台数据模型里没有难度字段）：
    // 明确拒绝而不是落到默认分支去拉别的平台 —— 否则前端会以为「QOJ 题库已入库」。
    if (platform === 'qoj') {
      return res.status(400).json({
        error: 'qoj 无公开题库页（站点在 Cloudflare 挑战之后，且平台无难度字段），不支持拉取题库',
      });
    }
    if (
      platform !== 'luogu' && platform !== 'nowcoder' &&
      platform !== 'codeforces' && platform !== 'leetcode' &&
      platform !== 'atcoder' && platform !== 'daimayuan' &&
      platform !== 'jisuanke'
    ) {
      return res.status(400).json({ error: 'platform 需为 luogu / nowcoder / codeforces / leetcode / atcoder / daimayuan / jisuanke' });
    }
    // luoguTypes 校验：非法类型直接拒绝，不静默回退默认 ['P']
    // （静默回退会让「我要 CF 镜像题」变成一次普通题拉取，调用方无从察觉）
    let types: LuoguProblemType[] | undefined;
    if (luoguTypes !== undefined) {
      if (
        !Array.isArray(luoguTypes) ||
        luoguTypes.some((t) => !LUOGU_PROBLEM_TYPES.has(t as LuoguProblemType))
      ) {
        return res.status(400).json({
          error: `luoguTypes 需为 'P' | 'B' | 'CF' | 'AT' | 'SP' | 'UVA' 构成的数组`,
        });
      }
      const picked = [...new Set(luoguTypes as LuoguProblemType[])];
      if (picked.length > 0) types = picked; // 空数组 = 未指定类型 → 交由拉取器用默认 ['P']
    }
    if (atcoderTags !== undefined && typeof atcoderTags !== 'boolean') {
      return res.status(400).json({ error: 'atcoderTags 需为布尔值' });
    }
    const maxCap = platform === 'codeforces' ? 20000 : platform === 'atcoder' ? 10000 : 5000;
    const maxN =
      typeof max === 'number' && Number.isFinite(max)
        ? Math.min(maxCap, Math.max(50, Math.floor(max)))
        : platform === 'codeforces'
          ? 20000
          : platform === 'atcoder'
            ? 5000
            : 2000;
    const minDiff =
      typeof luoguMinDifficulty === 'number' && Number.isFinite(luoguMinDifficulty)
        ? luoguMinDifficulty
        : undefined;
    try {
      const fetcher =
        platform === 'luogu'
          ? fetchLuoguBank
          : platform === 'nowcoder'
            ? fetchNowcoderBank
            : platform === 'leetcode'
              ? fetchLeetcodeBank
              : platform === 'atcoder'
                ? fetchAtcoderBank
            : platform === 'daimayuan'
              ? fetchDaimayuanBank
              : platform === 'jisuanke'
                ? fetchJisuankeBank
                : fetchCodeforcesBank;
      const result = await fetcher(fetchFn, {
        max: maxN,
        ...(minDiff !== undefined ? { luoguMinDifficulty: minDiff } : {}),
        ...(types !== undefined ? { luoguTypes: types } : {}),
        ...(atcoderTags === true ? { atcoderTagsFromLuogu: true } : {}),
      });
      const imported = upsertBankProblems(db, result.problems);
      res.json({
        ok: true,
        platform,
        total: result.total,
        fetched: result.problems.length,
        inserted: imported[0]?.inserted ?? 0,
        updated: imported[0]?.updated ?? 0,
        // 标签桥计数只在真的开了桥时下发（未开时不产出这些键，避免前端把 undefined 当 0 展示）
        ...(result.tagScanned === undefined
          ? {}
          : {
              tagScanned: result.tagScanned,
              tagMatched: result.tagMatched,
              tagWithTags: result.tagWithTags,
              tagSkipped: result.tagSkipped,
            }),
      });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }));

  // GET /api/problems/duplicates → 「平台 + 标题 + 归一化题号完全相同」的重复题分组预览
  // 供「合并与过滤」确认弹窗展示将要删除的组（与 clean-tags 的去重共用 findDuplicateGroups 的
  // 保留策略：每组保留有提交记录且 id 最老的行）。
  r.get('/duplicates', (_req, res) => {
    res.json(findDuplicateGroups(db));
  });

  // POST /api/problems/clean-tags
  // 物理清洗库内所有题目的标签（历史数据修复操作）：
  // - 归并：英文别名 → 规范名（dp → 动态规划、binary search → 二分查找），并去重
  // - 过滤：噪声标签（年份/赛事/地区/题型事务等非算法维度）
  // - 去重（issue #27 讨论）：「平台 + 标题 + 归一化题号完全相同」的重复题每组保留 1 条
  //   （优先保留有提交记录的行——用户刷题记录锚在上面，再取 id 最老的），
  //   其余删除并把提交/卡点/计划任务并入保留行；复习条目同题同用户唯一，
  //   保留行已有则丢弃重复行的；知识点标注随行删除（JSONL 补墓碑防复活）；
  //   被删题号记入 deleted_problems 墓碑，防题库重拉复活（见 schema.sql 该表注释）。
  //   只按「平台 + 标题」判重会误删跨轮次撞名的不同题（实测 403 组 / 621 道），故加题号归一化。
  // 注：新写入路径已「写入即净化」（见 import/problemWritePolicy.ts purifyTags），
  // 新入库的题再跑本接口结果不变（幂等）；保留它只为修复引入净化前遗留的历史数据。
  r.post('/clean-tags', asyncHandler(async (_req, res) => {
    const rows = db.prepare('SELECT id, tags FROM problems').all() as Array<{ id: number; tags: string }>;
    const update = db.prepare('UPDATE problems SET tags = ? WHERE id = ?');
    let problemsCleaned = 0;
    let tagsRemoved = 0;
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const raw = safeTags(row.tags);
        const next = [...new Set(filterNoiseTags(raw).map((t) => canonicalTag(t)))];
        if (JSON.stringify(next) !== JSON.stringify(raw)) {
          tagsRemoved += raw.length - next.length;
          update.run(JSON.stringify(next), row.id);
          problemsCleaned += 1;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // 标签清洗后跑去重：每组「平台 + 标题 + 归一化题号完全相同」只留一条，引用并入保留行
    const duplicateGroups = findDuplicateGroups(db);
    let duplicatesRemoved = 0;
    const tombstones: Array<{ platform: string; problemKey: string }> = [];
    const markDeleted = db.prepare(
      `INSERT OR REPLACE INTO deleted_problems
         (platform, problem_key, normalized_key, title, difficulty, url, tags,
          difficulty_source, native_difficulty, difficulty_scale)
       VALUES (?, ?, LOWER(REPLACE(?, ' ', '')), ?, ?, ?, ?, ?, ?, ?)`,
    );
    const problemById = db.prepare(
      `SELECT platform, problem_key, title, difficulty, url, tags,
              difficulty_source, native_difficulty, difficulty_scale
         FROM problems WHERE id = ?`,
    );
    db.exec('BEGIN');
    try {
      for (const g of duplicateGroups) {
        for (const dup of g.remove) {
          db.prepare('UPDATE submissions SET problem_id = ? WHERE problem_id = ?').run(g.keep.id, dup.id);
          db.prepare('UPDATE submission_intents SET problem_id = ? WHERE problem_id = ?').run(g.keep.id, dup.id);
          db.prepare('UPDATE plan_tasks SET problem_id = ? WHERE problem_id = ?').run(g.keep.id, dup.id);
          // 复习条目 (user_id, problem_id) 唯一：保留行已有同一用户的复习条目时丢弃重复行的
          db.prepare(
            `UPDATE review_items SET problem_id = ? WHERE problem_id = ?
               AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.user_id = review_items.user_id AND r.problem_id = ?)`,
          ).run(g.keep.id, dup.id, g.keep.id);
          db.prepare('DELETE FROM review_items WHERE problem_id = ?').run(dup.id);
          db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?').run(g.platform, dup.problemKey);
          db.prepare('DELETE FROM knowledge_queue WHERE platform = ? AND problem_key = ?').run(g.platform, dup.problemKey);
          const dupRow = problemById.get(dup.id) as NonNullable<ReturnType<typeof problemById.get>>;
          db.prepare('DELETE FROM problems WHERE id = ?').run(dup.id);
          // 重复行多来自题库（如带空格的脏题号），不记墓碑则下次拉题库/播种原样复活；
          // 墓碑带快照，回收站可原样找回
          markDeleted.run(
            g.platform,
            dup.problemKey,
            dup.problemKey,
            dupRow.title,
            dupRow.difficulty,
            dupRow.url,
            dupRow.tags,
            dupRow.difficulty_source,
            dupRow.native_difficulty,
            dupRow.difficulty_scale,
          );
          tombstones.push({ platform: g.platform, problemKey: dup.problemKey });
          duplicatesRemoved += 1;
        }
      }
      // JSONL 墓碑在事务 COMMIT 前追加（与 DELETE /:id 同款时序），防止重启重放复活被删行的标注
      const dataDir = effectiveDataDir();
      if (dataDir && tombstones.length > 0) {
        appendAnnotations(
          dataDir,
          tombstones.flatMap((t) => [
            tombstoneLine(t.platform, t.problemKey, 'rule'),
            tombstoneLine(t.platform, t.problemKey, 'tag'),
            tombstoneLine(t.platform, t.problemKey, 'ai'),
            tombstoneLine(t.platform, t.problemKey, 'manual'),
          ]),
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ok: true, total: rows.length, problemsCleaned, tagsRemoved, duplicatesRemoved });
  }));

  // POST /api/problems/backfill-difficulty
  // 对库内未知难度/未知原生难度/无标签的题逐题查询公开接口回填（匿名可访问）：
  // - 牛客顺带修复标题污染/空标签（题库搜索接口返回分离的标题与算法标签）
  // - 全平台覆盖（整表型平台 CF/AtCoder/力扣/计蒜客 一次拉表后在内存里查，QOJ 无数据来源）
  // - CF 未知难度题为 gym/官方 Unrated 比赛，官方无 rating，不参与回填
  // 耗时与待补题数成正比（洛谷 ~0.3s/题、牛客 ~0.45s/题），故每平台单次运行题数有上限
  // （PLATFORM_LIMITS.maxPerRun）：超出的题数用 capped 如实回传，下次点击继续
  // 响应：{ ok, results: [{ platform, scanned, filled, nativeFilled, repaired, missing, failed, capped, details }], unknownLeft }
  //   nativeFilled = 该平台 native_difficulty 由 NULL 被补上的题数（与 filled 相互独立：
  //   难度已有值但原生值缺失时只增 nativeFilled —— 双标度要能各自如实上报）
  //   scanned = 本次实际处理的题数（已扣除 capped）；capped = 本次因上限未处理的题数
  r.post('/backfill-difficulty', asyncHandler(async (_req, res) => {
    try {
      const results = await backfillDifficulties(db, fetchFn);
      const unknownLeft = (
        db.prepare('SELECT COUNT(*) AS c FROM problems WHERE difficulty IS NULL').get() as { c: number }
      ).c;
      res.json({ ok: true, results, unknownLeft });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }));

  /** 合法的卡点性质（与 client 的选项一一对应）。editorial = 看题解/视频讲解后才做出（能力值模型据此降权） */
  const INTENT_OUTCOMES = new Set(['cant_start', 'editorial', 'wrong_approach', 'implementation', 'slight_bug']);

  // POST /api/problems/:platform/:key/intent
  // body: { outcome: 'cant_start'|'editorial'|'wrong_approach'|'implementation'|'slight_bug', code?: string }
  // 记录用户自述的卡点。code 可省略（= 非知识点摩擦）。
  r.post('/:platform/:key/intent', (req, res) => {
    const { platform, key } = req.params;
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    const outcome = req.body?.outcome;
    if (typeof outcome !== 'string' || !INTENT_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: 'outcome 需为 cant_start / editorial / wrong_approach / implementation / slight_bug' });
    }
    const rawCode = req.body?.code;
    if (rawCode !== undefined && rawCode !== null && rawCode !== '') {
      if (typeof rawCode !== 'string' || !isValidCode(rawCode)) {
        return res.status(400).json({ error: `code 非法: ${String(rawCode)}` });
      }
    }
    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null;

    const problem = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, key) as { id: number } | undefined;
    if (!problem) return res.status(404).json({ error: '题目不存在：请先同步或导入该题' });

    const info = db
      .prepare('INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (?, ?, ?, ?)')
      .run(DEFAULT_USER_ID, problem.id, code, outcome);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  // GET /api/problems/:platform/:key/intents → 该题的卡点记录（时间倒序）
  r.get('/:platform/:key/intents', (req, res) => {
    const { platform, key } = req.params;
    const rows = db
      .prepare(
        `SELECT i.code, i.outcome, i.created_at AS createdAt
           FROM submission_intents i JOIN problems p ON p.id = i.problem_id
          WHERE i.user_id = ? AND p.platform = ? AND p.problem_key = ?
          ORDER BY i.created_at DESC, i.id DESC`,
      )
      .all(DEFAULT_USER_ID, platform, key);
    res.json({ items: rows });
  });

  // DELETE /api/problems/:id → 删除题目（issue #27：题库重复题目没有删除入口）。
  // UNIQUE(platform, problem_key) 挡住同库重复行，但跨平台镜像（洛谷 AT ↔ AtCoder 原题）
  // 与误导入仍会产生用户想清掉的行 —— 行留着会持续污染难度分布、标签分面与待选题池。
  // 题目行是提交/复习/卡点/知识点标注的锚，删除必须连带清理（外键已开启，漏一处即报错）；
  // 训练计划任务保留（标题/链接冗余在任务行上），只解除题目引用。
  // 知识点标注的源真相在 JSONL，删除前必须各来源补一行墓碑，防止下次启动重放时复活。
  // 题目行本身还记一道 deleted_problems 墓碑：题库拉取与提交同步都走 (platform, problem_key)
  // upsert，不记墓碑则下次同步连提交一起重建（清理永远不生效），语义见 schema.sql 该表注释。
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id 非法' });
    const problem = db
      .prepare(
        `SELECT id, platform, problem_key, title, difficulty, url, tags,
                difficulty_source, native_difficulty, difficulty_scale
           FROM problems WHERE id = ?`,
      )
      .get(id) as
      | {
          id: number;
          platform: string;
          problem_key: string;
          title: string;
          difficulty: number | null;
          url: string | null;
          tags: string;
          difficulty_source: string | null;
          native_difficulty: string | null;
          difficulty_scale: string | null;
        }
      | undefined;
    if (!problem) return res.status(404).json({ error: '题目不存在（可能已被删除）' });

    const deletedSubmissions = (
      db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE problem_id = ?').get(id) as { c: number }
    ).c;
    const deletedReviewItems = (
      db.prepare('SELECT COUNT(*) AS c FROM review_items WHERE problem_id = ?').get(id) as { c: number }
    ).c;

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM submission_intents WHERE problem_id = ?').run(id);
      db.prepare('DELETE FROM submissions WHERE problem_id = ?').run(id);
      db.prepare('DELETE FROM review_items WHERE problem_id = ?').run(id);
      db.prepare('UPDATE plan_tasks SET problem_id = NULL WHERE problem_id = ?').run(id);
      db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?').run(
        problem.platform,
        problem.problem_key,
      );
      // 历史遗留表无读取方，但主键同为 (platform, problem_key)，一并清掉避免残留
      db.prepare('DELETE FROM knowledge_queue WHERE platform = ? AND problem_key = ?').run(
        problem.platform,
        problem.problem_key,
      );
      db.prepare('DELETE FROM problems WHERE id = ?').run(id);
      // 快照随墓碑一起落库：回收站恢复题目行靠它原样重建（提交/复习/卡点仍不可恢复）
      db.prepare(
        `INSERT OR REPLACE INTO deleted_problems
           (platform, problem_key, normalized_key, title, difficulty, url, tags,
            difficulty_source, native_difficulty, difficulty_scale)
         VALUES (?, ?, LOWER(REPLACE(?, ' ', '')), ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        problem.platform,
        problem.problem_key,
        problem.problem_key,
        problem.title,
        problem.difficulty,
        problem.url,
        problem.tags,
        problem.difficulty_source,
        problem.native_difficulty,
        problem.difficulty_scale,
      );
      // JSONL 墓碑在事务 COMMIT 前追加（与 setManualKeypoints 同款时序）：
      // 崩溃时 JSONL 多出的墓碑行在下次启动重放自愈，不会留下半删状态
      const dataDir = effectiveDataDir();
      if (dataDir) {
        appendAnnotations(dataDir, [
          tombstoneLine(problem.platform, problem.problem_key, 'rule'),
          tombstoneLine(problem.platform, problem.problem_key, 'tag'),
          tombstoneLine(problem.platform, problem.problem_key, 'ai'),
          tombstoneLine(problem.platform, problem.problem_key, 'manual'),
        ]);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ ok: true, deletedSubmissions, deletedReviewItems });
  });

  // GET /api/problems/deleted → 回收站：被删除题目的墓碑清单（带删除时刻快照）
  r.get('/deleted', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT platform, problem_key, title, difficulty, deleted_at
           FROM deleted_problems ORDER BY deleted_at DESC, ROWID DESC`,
      )
      .all();
    res.json(rows);
  });

  // POST /api/problems/deleted/restore  body: { platform, problemKey } → 误删恢复（issue #27 补充）。
  // 只重建题目行本身（墓碑快照原样落回，含难度/标签；无快照的旧墓碑退化为「题号即标题」），
  // 并清掉墓碑恢复同步/题库对该题号的正常收录。提交、复习、卡点与人工知识点标注
  // 在删除时已不可逆清除（JSONL 墓碑防重放复活），这里如实不找回，只重跑 L1 规则/tag 标注。
  r.post('/deleted/restore', (req, res) => {
    const { platform, problemKey } = req.body ?? {};
    if (typeof platform !== 'string' || typeof problemKey !== 'string' || !problemKey.trim()) {
      return res.status(400).json({ error: 'platform 与 problemKey 必填' });
    }
    const tomb = db
      .prepare('SELECT * FROM deleted_problems WHERE platform = ? AND problem_key = ?')
      .get(platform, problemKey) as ProblemSnapshot | undefined;
    if (!tomb) return res.status(404).json({ error: '回收站中没有该题（可能已恢复）' });

    const existing = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, problemKey) as { id: number } | undefined;
    if (existing) {
      // 手动导入等路径已重建过题目：只清墓碑，不碰现有行（它携带更近期的数据）
      db.prepare('DELETE FROM deleted_problems WHERE platform = ? AND problem_key = ?').run(platform, problemKey);
      return res.json({ ok: true, recreated: false });
    }
    // 等价类查重（与 tombstones.ts 同口径：同平台、题号只差空格/大小写）：恢复去重墓碑时
    // 保留行还在，若照墓碑原样重建，会把用户清理过的重复题再造成两行（恢复→重复→再清理死循环）
    const sibling = db
      .prepare(
        `SELECT problem_key FROM problems
          WHERE platform = ? AND LOWER(REPLACE(problem_key, ' ', '')) = LOWER(REPLACE(?, ' ', ''))`,
      )
      .get(platform, problemKey) as { problem_key: string } | undefined;
    if (sibling) {
      db.prepare('DELETE FROM deleted_problems WHERE platform = ? AND problem_key = ?').run(platform, problemKey);
      return res.json({ ok: true, recreated: false, equivalentOf: sibling.problem_key });
    }
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO problems
           (platform, problem_key, title, difficulty, url, tags,
            difficulty_source, native_difficulty, difficulty_scale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        platform,
        problemKey,
        tomb.title ?? problemKey,
        tomb.difficulty ?? null,
        tomb.url ?? null,
        tomb.tags ?? '[]',
        tomb.difficulty_source ?? null,
        tomb.native_difficulty ?? null,
        tomb.difficulty_scale ?? null,
      );
      db.prepare('DELETE FROM deleted_problems WHERE platform = ? AND problem_key = ?').run(platform, problemKey);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    try {
      annotateProblemsL1(db, [
        { platform, problemKey, title: tomb.title ?? problemKey, tags: tomb.tags ?? '[]' },
      ]);
    } catch (e) {
      console.error(`[knowledge] 恢复题目后 L1 标注失败（不影响恢复）: ${(e as Error).message}`);
    }
    res.json({ ok: true, recreated: true });
  });

  return r;
}

/** 难度值 → 分桶名（与客户端 DIFF_BUCKETS 一致） */
function bucketName(difficulty: number | null): string {
  if (difficulty === null) return '未知';
  if (difficulty < 1200) return '<1200';
  if (difficulty < 1400) return '1200-1399';
  if (difficulty < 1600) return '1400-1599';
  if (difficulty < 1900) return '1600-1899';
  if (difficulty < 2200) return '1900-2199';
  return '2200+';
}

/** 「平台 + 标题 + 归一化题号完全相同」的重复题分组（issue #27：合并与过滤顺带去重）。
 * 归一化题号 = 去空格、忽略大小写：'1234A' / '1234a' / ' 1234A' 视为同一题号。
 * 只有三者都相同才算重复——题库里存在大量跨轮次撞名的**不同题**（CF 11D 与 558E 都叫
 * “A Simple Task”），仅按「平台 + 标题」判重会一次误删几百道真实题目（实测 403 组）。
 * 保留策略：优先保留有提交记录的行（用户刷题记录锚在上面），再取 id 最老的；
 * GET /duplicates 预览与 clean-tags 的去重执行共用本函数，保证口径一致。 */
interface DuplicateGroup {
  platform: string;
  title: string;
  keep: { id: number; problemKey: string; attempts: number };
  remove: Array<{ id: number; problemKey: string; attempts: number }>;
}

const NORMALIZED_KEY_SQL = "LOWER(REPLACE(problem_key, ' ', ''))";

function findDuplicateGroups(db: Db): DuplicateGroup[] {
  const groups = db
    .prepare(
      `SELECT platform, title, ${NORMALIZED_KEY_SQL} AS normalizedKey
       FROM problems
       GROUP BY platform, title, ${NORMALIZED_KEY_SQL}
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ platform: string; title: string; normalizedKey: string }>;
  const rowsOf = db.prepare(
    `SELECT p.id, p.problem_key AS problemKey,
            (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id) AS attempts
       FROM problems p
      WHERE p.platform = ? AND p.title = ? AND ${NORMALIZED_KEY_SQL} = ?
      ORDER BY attempts DESC, p.id ASC`,
  );
  const out: DuplicateGroup[] = [];
  for (const g of groups) {
    const rows = rowsOf.all(g.platform, g.title, g.normalizedKey) as Array<{
      id: number;
      problemKey: string;
      attempts: number;
    }>;
    const keep = rows[0];
    if (!keep || rows.length < 2) continue;
    out.push({
      platform: g.platform,
      title: g.title,
      keep: { id: keep.id, problemKey: keep.problemKey, attempts: keep.attempts },
      remove: rows.slice(1).map((r) => ({ id: r.id, problemKey: r.problemKey, attempts: r.attempts })),
    });
  }
  return out;
}

/**
 * 行 → API 形态：tags 反序列化、派生 status，并把原生难度三件套转成 camelCase 下发。
 * `difficultyLabel` 由 `nativeDifficultyLabel(platform, native_difficulty)` 派生（映射表只在
 * shared/src/difficulty.ts 一份，路由层不做任何本地换算）；原生难度未知 → label 也是 null
 * （**未知一律 null，不猜**：绝不退回用 CF rating 反推一个「档位名」）。
 */
function toApiProblem(r: ProblemRow): Omit<ProblemRow, 'tags' | 'native_difficulty' | 'difficulty_scale' | 'review_item_id'> & {
  tags: string[];
  nativeDifficulty: string | null;
  difficultyScale: string | null;
  difficultyLabel: string | null;
  status: 'ac' | 'tried' | 'none';
  reviewItemId: number | null;
} {
  const { native_difficulty, difficulty_scale, review_item_id, ...rest } = r;
  return {
    ...rest,
    reviewItemId: review_item_id ?? null,
    tags: safeTags(r.tags),
    nativeDifficulty: native_difficulty,
    difficultyScale: difficulty_scale,
    difficultyLabel:
      native_difficulty === null ? null : nativeDifficultyLabel(r.platform, native_difficulty),
    status: r.ac_count > 0 ? 'ac' : r.attempts > 0 ? 'tried' : 'none',
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

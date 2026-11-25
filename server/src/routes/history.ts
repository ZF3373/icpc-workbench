import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { safeTags } from '../analysis/stats.ts';
import { intentFactor } from '../today/ability.ts';
import { submissionUrlOf } from '../adapters/submissionUrl.ts';
import {
  CONTEST_PHASES,
  contestScopeSql,
  resolveContestScope,
  type ContestPhase,
} from '../history/contestScope.ts';

/**
 * 写题历史（issue #19）：数据全部来自 submissions ⋈ problems（平台同步 / CSV 导入写入），
 * 本路由只做查询聚合，不新增表。两种视图：
 * - problem：按题聚合（在哪个平台写过哪些题、各几次），默认视图
 * - submission：逐条提交流水
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type View = 'problem' | 'submission';
type ResultFilter = 'all' | 'ac' | 'failed';

const VIEWS: ReadonlySet<string> = new Set<View>(['problem', 'submission']);
const RESULT_FILTERS: ReadonlySet<string> = new Set<ResultFilter>(['all', 'ac', 'failed']);

interface HistoryFilters {
  platform?: PlatformId;
  result: ResultFilter;
  /** 时间窗下界（含），规范化后的 ISO 时刻 */
  from?: string;
  /** 时间窗上界（不含），规范化后的 ISO 时刻 */
  to?: string;
  q?: string;
  /** 按比赛筛选（issue #70）：contestKey 形如 codeforces:1877 */
  contestKey?: string;
  /** 该场比赛的参赛阶段；缺省 all */
  phase: ContestPhase;
  /** 只看某账号的提交（同一场比赛既有正式参赛又有 VP 时用来区分） */
  account?: string;
}

interface ProblemRow {
  id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string;
  attempts: number;
  ac_count: number;
  last_submitted_at: string;
  /** 已在复习队列时为 review_items.id，否则 null */
  review_item_id: number | null;
}

interface SubmissionRow {
  id: number;
  problem_id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  verdict: string;
  language: string | null;
  submitted_at: string;
  url: string | null;
  tags: string;
  /** 该题全部提交里的 AC 次数（操作列据此决定是否显示「标记 AC」） */
  ac_count: number;
  review_item_id: number | null;
  /** 提交详情页（issue #69）；库内为 NULL 的老行由 toSubmissionItem 现算补齐 */
  external_id: string | null;
  submission_url: string | null;
  /** 提交语境（issue #70：赛时/赛后筛选的结果里标出这条属于哪种） */
  context: string | null;
  /** 提交归属账号（多账号下「查看某次参赛的提交」用） */
  account: string;
}

const toProblemItem = (r: ProblemRow) => ({
  problemId: r.id,
  platform: r.platform,
  problemKey: r.problem_key,
  title: r.title,
  difficulty: r.difficulty,
  url: r.url,
  tags: safeTags(r.tags),
  attempts: r.attempts,
  acCount: r.ac_count,
  lastSubmittedAt: r.last_submitted_at,
  reviewItemId: r.review_item_id,
  /** 卡点聚合（attachIntentStats 填充）：「卡在哪」行内角标与 Popover 记录列表共用 */
  intentCount: 0,
  worstIntent: null as string | null,
});

const toSubmissionItem = (r: SubmissionRow) => ({
  id: r.id,
  problemId: r.problem_id,
  platform: r.platform,
  problemKey: r.problem_key,
  title: r.title,
  verdict: r.verdict,
  language: r.language,
  submittedAt: r.submitted_at,
  /** 题目页地址（保持旧字段语义，前端标题仍指向原题） */
  url: r.url,
  /**
   * 提交详情页地址（issue #69）：库内列优先（同步时由适配器算好），
   * 老行为 NULL 时按 (platform, external_id) 现算 —— 历史记录不必等下一次同步才能点开。
   * 算不出来（该平台路由未知 / 手动导入）就是 null，前端据此不渲染入口。
   */
  submissionUrl: r.submission_url ?? (r.external_id ? submissionUrlOf(r.platform, r.external_id) : null),
  externalId: r.external_id,
  context: r.context,
  account: r.account,
  tags: safeTags(r.tags),
  acCount: r.ac_count,
  reviewItemId: r.review_item_id,
  intentCount: 0,
  worstIntent: null as string | null,
});

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * 时间界 → 规范 ISO 时刻（一律经 Date 往返，顺带否掉 2026-13-45 这类过正则但不存在的日期）。
 * 收两种写法：完整 ISO 时刻（前端按用户本地日界下发）与 YYYY-MM-DD（按 UTC 日零点）。
 * submitted_at 全库都是 toISOString() 的定长格式，字典序即时间序，故可直接字符串比较。
 */
function parseInstant(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!DATE_RE.test(raw) && !INSTANT_RE.test(raw)) return undefined;
  const iso = DATE_RE.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  // toISOString 恒为 3 位毫秒：把 6 位微秒精度也归一到同一字典序口径
  return new Date(ms).toISOString();
}

/** 上界：日期写法取「次日零点」以实现闭区间当天；时刻写法原样（前端已取本地日末） */
function parseExclusiveTo(raw: unknown): string | undefined {
  const inst = parseInstant(raw);
  if (inst === undefined) return undefined;
  return typeof raw === 'string' && DATE_RE.test(raw)
    ? new Date(Date.parse(inst) + 86_400_000).toISOString()
    : inst;
}

/** 转义 LIKE 通配符，关键词按字面量匹配 */
function likeParam(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function parseFilters(query: Record<string, unknown>): HistoryFilters {
  const out: HistoryFilters = { result: 'all', phase: 'all' };
  if (typeof query.platform === 'string' && PLATFORMS.some((p) => p.id === query.platform)) {
    out.platform = query.platform as PlatformId;
  }
  if (typeof query.result === 'string' && RESULT_FILTERS.has(query.result)) {
    out.result = query.result as ResultFilter;
  }
  const from = parseInstant(query.from);
  const to = parseExclusiveTo(query.to);
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  if (typeof query.q === 'string' && query.q.trim() !== '') out.q = query.q.trim();
  // issue #70：按比赛 + 参赛阶段筛选。contestKey 形态校验交给 resolveContestScope
  // （它同时负责查出该场的时间窗与平台），非法/解析不到时按「不筛选」处理而不是 400 ——
  // 前端从旧链接带过来一个已清理的比赛时，退化成全部提交比报错更有用。
  if (typeof query.contestKey === 'string' && query.contestKey.trim() !== '') {
    out.contestKey = query.contestKey.trim();
  }
  if (typeof query.phase === 'string' && CONTEST_PHASES.has(query.phase)) {
    out.phase = query.phase as ContestPhase;
  }
  if (typeof query.account === 'string' && query.account.trim() !== '') out.account = query.account.trim();
  return out;
}

/**
 * submissions ⋈ problems 的共享 WHERE 骨架。
 * result 只在这里下发给 submission 视图（逐条流水按行判定）；problem 视图改走 HAVING，
 * 否则「提交/AC」计数会被结果过滤切片，5 发才 A 的题会显示成 1/1。
 */
function filterSql(
  db: Db,
  f: HistoryFilters,
  view: View,
): { where: string; params: Array<string | number>; scopeNote: string | null } {
  let where = ' WHERE s.user_id = ?';
  const params: Array<string | number> = [DEFAULT_USER_ID];
  let scopeNote: string | null = null;
  if (f.account !== undefined) {
    where += ' AND s.account = ?';
    params.push(f.account);
  }
  if (f.contestKey !== undefined) {
    const scope = resolveContestScope(db, f.contestKey);
    // 解析不到 = 这场比赛的数据已被清理（换账号/删库）：明确回空而不是静默忽略筛选，
    // 否则用户会以为「这场一条提交都没有」和「筛选没生效」是同一件事。
    if (!scope) {
      where += ' AND 1 = 0';
      scopeNote = `未找到比赛 ${f.contestKey} 的记录（可能已更换账号或数据被清理），请先在赛事中心刷新参赛记录。`;
    } else {
      const scoped = contestScopeSql(scope, f.phase);
      where += scoped.sql;
      params.push(...scoped.params);
      scopeNote = scoped.note;
    }
  }
  if (f.platform !== undefined) {
    where += ' AND s.platform = ?';
    params.push(f.platform);
  }
  if (view === 'submission') {
    if (f.result === 'ac') where += " AND s.verdict = 'AC'";
    if (f.result === 'failed') where += " AND s.verdict != 'AC'";
  }
  if (f.from !== undefined) {
    where += ' AND s.submitted_at >= ?';
    params.push(f.from);
  }
  if (f.to !== undefined) {
    where += ' AND s.submitted_at < ?';
    params.push(f.to);
  }
  if (f.q !== undefined) {
    where += " AND (p.title LIKE ? ESCAPE '\\' OR p.problem_key LIKE ? ESCAPE '\\')";
    const like = likeParam(f.q);
    params.push(like, like);
  }
  return { where, params, scopeNote };
}

/** problem 视图的结果过滤：在聚合之后按「该题在窗口内是否 AC 过」判定 */
function resultHavingSql(result: ResultFilter): string {
  if (result === 'ac') return ' HAVING ac_count > 0';
  if (result === 'failed') return ' HAVING ac_count = 0';
  return '';
}

/**
 * 给历史行附加卡点聚合（intentCount / worstIntent），口径与题目管理页行角标一致：
 * 计数 + intentFactor 最小者（弱项口径）。声明表很小，按用户分组一次取回、JS 侧定最差，
 * 权重真相在 intentFactor（今日推荐/复习排序共用同一份），SQL 里不另写映射。
 * 平局（cant_start/editorial/upsolved 同为 0.45）按 outcome 字母序取先到者，与题目管理页一致。
 */
function attachIntentStats(
  db: Db,
  items: Array<{ problemId: number; intentCount?: number; worstIntent?: string | null }>,
): void {
  for (const it of items) {
    it.intentCount = 0;
    it.worstIntent = null;
  }
  if (items.length === 0) return;
  const groups = db
    .prepare(
      `SELECT problem_id, outcome, COUNT(*) AS cnt
         FROM submission_intents
        WHERE user_id = ?
        GROUP BY problem_id, outcome
        ORDER BY problem_id, outcome`,
    )
    .all(DEFAULT_USER_ID) as Array<{ problem_id: number; outcome: string; cnt: number }>;
  if (groups.length === 0) return;
  const byProblem = new Map<number, Array<{ outcome: string; cnt: number }>>();
  for (const g of groups) {
    const list = byProblem.get(g.problem_id);
    if (list) list.push({ outcome: g.outcome, cnt: g.cnt });
    else byProblem.set(g.problem_id, [{ outcome: g.outcome, cnt: g.cnt }]);
  }
  for (const it of items) {
    const list = byProblem.get(it.problemId);
    if (!list) continue;
    let worst: string | null = null;
    for (const g of list) {
      it.intentCount = (it.intentCount ?? 0) + g.cnt;
      if (worst === null || intentFactor(g.outcome) < intentFactor(worst)) worst = g.outcome;
    }
    it.worstIntent = worst;
  }
}

/**
 * 按题聚合的子查询。列表、总数、平台聚合三处共用同一份 SQL，
 * 保证「共 N 题」与标签上的题数/提交数在任何过滤组合下口径一致。
 * p.title 等列函数依赖于 GROUP BY 的 p.id，SQLite 允许直接取。
 */
function problemGroupSql(where: string, having: string): string {
  return `SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags,
    COUNT(s.id) AS attempts,
    COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count,
    MAX(s.submitted_at) AS last_submitted_at,
    (SELECT ri.id FROM review_items ri
      WHERE ri.problem_id = p.id AND ri.user_id = ${DEFAULT_USER_ID}) AS review_item_id
    FROM submissions s JOIN problems p ON p.id = s.problem_id${where}
    GROUP BY p.id${having}`;
}

export function historyRoutes(db: Db): Router {
  const r = Router();

  /**
   * GET /api/history/submissions?view=problem|submission&platform=&result=all|ac|failed
   *                    &from=&to=&q=&page=1&pageSize=50
   * from/to 接受完整 ISO 时刻（推荐，前端按本地日界下发）或 YYYY-MM-DD（按 UTC 日）。
   */
  r.get('/submissions', (req, res) => {
    const viewRaw = req.query.view;
    const view = typeof viewRaw === 'string' && VIEWS.has(viewRaw) ? (viewRaw as View) : 'problem';
    const f = parseFilters(req.query as Record<string, unknown>);
    const pageSize = clampInt(req.query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = clampInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const offset = (page - 1) * pageSize;
    const { where, params, scopeNote } = filterSql(db, f, view);

    let items: unknown[];
    let total: number;
    let platformAgg: Array<{ platform: PlatformId; submissions: number; problems: number }>;

    if (view === 'problem') {
      const group = problemGroupSql(where, resultHavingSql(f.result));
      items = (db
        .prepare(`SELECT * FROM (${group}) ORDER BY last_submitted_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset) as unknown as ProblemRow[]).map(toProblemItem);
      total = (db.prepare(`SELECT COUNT(*) AS c FROM (${group})`).get(...params) as unknown as { c: number }).c;
      platformAgg = db
        .prepare(`SELECT platform, SUM(attempts) AS submissions, COUNT(*) AS problems
    FROM (${group}) GROUP BY platform ORDER BY submissions DESC, platform`)
        .all(...params) as unknown as Array<{ platform: PlatformId; submissions: number; problems: number }>;
    } else {
      const base = `FROM submissions s JOIN problems p ON p.id = s.problem_id${where}`;
      items = (db
        .prepare(
          `SELECT s.id, p.id AS problem_id, s.platform, p.problem_key, p.title, s.verdict, s.language, s.submitted_at, p.url, p.tags,
    s.external_id, s.submission_url, s.context, s.account,
    (SELECT COUNT(*) FROM submissions s3
      WHERE s3.problem_id = p.id AND s3.user_id = ${DEFAULT_USER_ID} AND s3.verdict = 'AC') AS ac_count,
    (SELECT ri.id FROM review_items ri
      WHERE ri.problem_id = p.id AND ri.user_id = ${DEFAULT_USER_ID}) AS review_item_id
    ${base} ORDER BY s.submitted_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset) as unknown as SubmissionRow[]).map(toSubmissionItem);
      total = (db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params) as unknown as { c: number }).c;
      platformAgg = db
        .prepare(`SELECT s.platform AS platform, COUNT(*) AS submissions, COUNT(DISTINCT s.problem_id) AS problems
    ${base} GROUP BY s.platform ORDER BY submissions DESC, platform`)
        .all(...params) as unknown as Array<{ platform: PlatformId; submissions: number; problems: number }>;
    }

    // 两种视图的行都带 problemId：统一附上卡点聚合（「卡在哪」入口的行内角标）
    attachIntentStats(db, items as Array<{ problemId: number; intentCount?: number; worstIntent?: string | null }>);

    res.json({
      view,
      items,
      total,
      page,
      pageSize,
      hasMore: offset + items.length < total,
      /**
       * 比赛筛选的说明（issue #70）：无法归属某场比赛时解释原因，
       * 让「这场没有提交」与「筛不出来」在界面上是两件可区分的事。
       */
      ...(scopeNote !== null ? { scopeNote } : {}),
      platforms: platformAgg.map((p) => ({
        platform: p.platform,
        platformName: PLATFORMS.find((m) => m.id === p.platform)?.name ?? p.platform,
        submissions: p.submissions,
        problems: p.problems,
      })),
    });
  });

  return r;
}

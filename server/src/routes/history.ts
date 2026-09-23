import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

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
}

interface ProblemRow {
  id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  attempts: number;
  ac_count: number;
  last_submitted_at: string;
  /** 已在复习队列时为 review_items.id，否则 null */
  review_item_id: number | null;
}

interface SubmissionRow {
  id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  verdict: string;
  language: string | null;
  submitted_at: string;
  url: string | null;
  review_item_id: number | null;
}

const toProblemItem = (r: ProblemRow) => ({
  problemId: r.id,
  platform: r.platform,
  problemKey: r.problem_key,
  title: r.title,
  difficulty: r.difficulty,
  url: r.url,
  attempts: r.attempts,
  acCount: r.ac_count,
  lastSubmittedAt: r.last_submitted_at,
  reviewItemId: r.review_item_id,
});

const toSubmissionItem = (r: SubmissionRow) => ({
  id: r.id,
  platform: r.platform,
  problemKey: r.problem_key,
  title: r.title,
  verdict: r.verdict,
  language: r.language,
  submittedAt: r.submitted_at,
  url: r.url,
  reviewItemId: r.review_item_id,
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
  const out: HistoryFilters = { result: 'all' };
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
  return out;
}

/**
 * submissions ⋈ problems 的共享 WHERE 骨架。
 * result 只在这里下发给 submission 视图（逐条流水按行判定）；problem 视图改走 HAVING，
 * 否则「提交/AC」计数会被结果过滤切片，5 发才 A 的题会显示成 1/1。
 */
function filterSql(f: HistoryFilters, view: View): { where: string; params: Array<string | number> } {
  let where = ' WHERE s.user_id = ?';
  const params: Array<string | number> = [DEFAULT_USER_ID];
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
  return { where, params };
}

/** problem 视图的结果过滤：在聚合之后按「该题在窗口内是否 AC 过」判定 */
function resultHavingSql(result: ResultFilter): string {
  if (result === 'ac') return ' HAVING ac_count > 0';
  if (result === 'failed') return ' HAVING ac_count = 0';
  return '';
}

/**
 * 按题聚合的子查询。列表、总数、平台聚合三处共用同一份 SQL，
 * 保证「共 N 题」与标签上的题数/提交数在任何过滤组合下口径一致。
 * p.title 等列函数依赖于 GROUP BY 的 p.id，SQLite 允许直接取。
 */
function problemGroupSql(where: string, having: string): string {
  return `SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
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
    const { where, params } = filterSql(f, view);

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
          `SELECT s.id, s.platform, p.problem_key, p.title, s.verdict, s.language, s.submitted_at, p.url,
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

    res.json({
      view,
      items,
      total,
      page,
      pageSize,
      hasMore: offset + items.length < total,
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

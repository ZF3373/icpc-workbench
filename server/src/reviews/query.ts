/**
 * 复习条目的「按日期取数」唯一入口。
 *
 * 复习数据有三个消费方（复习库页 / 今日训练 / 日历板块），它们对「某天该复习什么」
 * 必须是同一口径，否则会出现「今日训练说 3 道、日历说 2 道」这种互相打脸的现象。
 * 因此把投影 SQL 与到期语义收敛到这里，路由只负责传参和序列化。
 *
 * 到期语义（与复习库页既有口径一致）：
 * - 查询日 = 今天：next_due_on <= 今天（**含逾期**）——逾期没做的题今天就该做，
 *   只取 next_due_on == 今天 会让逾期项在界面上彻底消失，复习库越用越不可信。
 * - 查询日 ≠ 今天：next_due_on == 该日（历史/未来某天「当时应做」的量）。
 *   过去的日子不再补挂今天的逾期项，否则翻看历史会把今天的债摊到每一天。
 */
import type { Db } from '../db/index.ts';
import { localToday } from '../dates.ts';
import { safeTags } from '../analysis/stats.ts';
import { intervalDaysForStage, dateAfterDays } from './schedule.ts';
import { knowledgeTagsSql } from '../knowledge/store.ts';
import type { PlatformId, ReviewCalendarDay, ReviewItem } from '../../../shared/src/index.ts';

interface RawReviewRow {
  id: number;
  platform: string;
  problem_key: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string;
  stage: number;
  note: string | null;
  added_at: string;
  last_reviewed_at: string | null;
  next_due_on: string;
  review_count: number;
  lapse_count: number;
}

/** 复习条目投影：联表 problems 取题目元信息 + 复习日志聚合出复习/失手次数 */
export const REVIEW_SELECT_SQL = (db: Db): string => `
  SELECT ri.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
         ${knowledgeTagsSql(db)},
         ri.stage, ri.note, ri.added_at, ri.last_reviewed_at, ri.next_due_on,
         (SELECT COUNT(*) FROM review_events re WHERE re.review_item_id = ri.id) AS review_count,
         (SELECT COALESCE(SUM(CASE WHEN re.feedback = 'hard' THEN 1 ELSE 0 END), 0)
            FROM review_events re WHERE re.review_item_id = ri.id) AS lapse_count
    FROM review_items ri
    JOIN problems p ON p.id = ri.problem_id
`;

/** 排序：到期日升序，其次难度升序（无难度沉底）——先做最该做的，再挑简单的热身 */
const ORDER_BY = ' ORDER BY ri.next_due_on, p.difficulty IS NULL, p.difficulty';

export function toReviewItem(r: RawReviewRow): ReviewItem {
  return {
    id: r.id,
    platform: r.platform as PlatformId,
    problemKey: r.problem_key,
    title: r.title,
    difficulty: r.difficulty,
    url: r.url,
    tags: safeTags(r.tags),
    stage: r.stage,
    intervalDays: intervalDaysForStage(r.stage),
    reviewCount: r.review_count,
    lapseCount: r.lapse_count,
    note: r.note,
    nextDueOn: r.next_due_on,
    lastReviewedAt: r.last_reviewed_at,
    addedAt: r.added_at,
  };
}

/** 全队列（复习库页「全部队列」用），可按是否只看到期过滤 */
export function listReviewItems(
  db: Db,
  userId: number,
  opts: { dueOnly?: boolean; today?: string } = {},
): ReviewItem[] {
  const today = opts.today ?? localToday();
  let sql = `${REVIEW_SELECT_SQL(db)} WHERE ri.user_id = ?`;
  const params: Array<string | number> = [userId];
  if (opts.dueOnly) {
    sql += ' AND ri.next_due_on <= ?';
    params.push(today);
  }
  const rows = db.prepare(sql + ORDER_BY).all(...params) as unknown as RawReviewRow[];
  return rows.map(toReviewItem);
}

/**
 * 指定日期「该复习」的条目。
 * 今天含逾期（见模块头注释）；其它日期只取当天到期的。
 */
export function listReviewItemsOn(db: Db, userId: number, date: string, today = localToday()): ReviewItem[] {
  const sql =
    date === today
      ? `${REVIEW_SELECT_SQL(db)} WHERE ri.user_id = ? AND ri.next_due_on <= ?`
      : `${REVIEW_SELECT_SQL(db)} WHERE ri.user_id = ? AND ri.next_due_on = ?`;
  const rows = db.prepare(sql + ORDER_BY).all(userId, date) as unknown as RawReviewRow[];
  return rows.map(toReviewItem);
}

/** 今天及以前到期的全部条目（今日训练用；等于 listReviewItemsOn(today)） */
export function listDueReviewItems(db: Db, userId: number, today = localToday()): ReviewItem[] {
  return listReviewItemsOn(db, userId, today, today);
}

/**
 * 月历角标数据：该月每天「到期数」与今天的「逾期数」。
 *
 * 只回有到期项的日子（其余日子没有复习，界面按缺失处理即可，不必铺满整月）。
 *
 * 两条规则合起来保证「每个待办条目在月视图里只出现一次」：
 * - 严格早于今天的到期日不单独出行：那些条目全部是逾期的（review_items 里
 *   next_due_on < 今天 就等价于「欠着没做」），统一挂在今天的 overdue 上。
 *   否则同一道题会在它原本的日期和今天各出现一次，而且过去那格会被渲染成
 *   一个普通的「到期」标记，看起来像那天有正常安排——事实是那天漏了。
 * - 今天的 overdue 单独一列，不并进今天的 due：界面要能区分「今天新到期的」
 *   和「早就该做一直拖着的」。
 */
export function reviewCalendar(
  db: Db,
  userId: number,
  month: string,
  today = localToday(),
): ReviewCalendarDay[] {
  const rows = db
    .prepare(
      `SELECT next_due_on AS date, COUNT(*) AS due
         FROM review_items
        WHERE user_id = ? AND next_due_on LIKE ? AND next_due_on >= ?
        GROUP BY next_due_on
        ORDER BY next_due_on`,
    )
    .all(userId, `${month}%`, today) as unknown as Array<{ date: string; due: number }>;

  const days: ReviewCalendarDay[] = rows.map((r) => ({ date: r.date, due: r.due, overdue: 0 }));

  // 逾期项挂在今天那一格；今天不在本月时（翻看其它月份）不挂——逾期是「此刻」的状态，
  // 不该出现在用户正在浏览的历史/未来月份里
  if (today.startsWith(month)) {
    const overdue = (
      db
        .prepare('SELECT COUNT(*) AS c FROM review_items WHERE user_id = ? AND next_due_on < ?')
        .get(userId, today) as { c: number }
    ).c;
    if (overdue > 0) {
      const existing = days.find((d) => d.date === today);
      if (existing) existing.overdue = overdue;
      else {
        // 今天只有逾期、没有当天到期的条目：补一行，否则角标整格消失
        days.push({ date: today, due: 0, overdue });
        days.sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  }
  return days;
}

/** 复习负载分布（逾期 / 今日 / 未来 7 天），供 /api/reviews/due-count 与提示词共用 */
export interface ReviewLoad {
  total: number;
  overdue: number;
  dueToday: number;
  next7: number;
}

export function reviewLoad(db: Db, userId: number, today = localToday()): ReviewLoad {
  const weekEnd = dateAfterDays(today, 7);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN next_due_on < ? THEN 1 ELSE 0 END), 0) AS overdue,
              COALESCE(SUM(CASE WHEN next_due_on = ? THEN 1 ELSE 0 END), 0) AS dueToday,
              COALESCE(SUM(CASE WHEN next_due_on > ? AND next_due_on <= ? THEN 1 ELSE 0 END), 0) AS next7
         FROM review_items WHERE user_id = ?`,
    )
    .get(today, today, today, weekEnd, userId) as unknown as ReviewLoad;
  return row;
}

/** 未来 N 天内到期的条目（含逾期），按到期日升序——AI 排期与提示词用 */
export function listUpcomingReviewItems(
  db: Db,
  userId: number,
  opts: { from?: string; days?: number; limit?: number } = {},
): ReviewItem[] {
  const from = opts.from ?? localToday();
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 40;
  const to = dateAfterDays(from, days);
  const rows = db
    .prepare(
      `${REVIEW_SELECT_SQL(db)}
        WHERE ri.user_id = ? AND ri.next_due_on <= ?${ORDER_BY} LIMIT ?`,
    )
    .all(userId, to, limit) as unknown as RawReviewRow[];
  return rows.map(toReviewItem);
}

/** 窗口内到期条目总数（listUpcomingReviewItems 可能被 limit 截断，提示词需要说明「共 N 条」） */
export function countUpcomingReviewItems(
  db: Db,
  userId: number,
  opts: { from?: string; days?: number } = {},
): number {
  const from = opts.from ?? localToday();
  const to = dateAfterDays(from, opts.days ?? 30);
  return (
    db
      .prepare('SELECT COUNT(*) AS c FROM review_items WHERE user_id = ? AND next_due_on <= ?')
      .get(userId, to) as { c: number }
  ).c;
}

import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { safeTags } from '../analysis/stats.ts';
import { dateAfterDays, intervalDaysForStage, jitterDaysFor, scheduleNext } from '../reviews/schedule.ts';
import { collectRetentionSignals, retentionFactor } from '../reviews/retention.ts';
import { knowledgeTagsSql } from '../knowledge/store.ts';
import { localToday } from '../dates.ts';
import type { ReviewItem } from '../../../shared/src/index.ts';

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

function toReviewItem(r: RawReviewRow): ReviewItem {
  return {
    id: r.id,
    platform: r.platform as ReviewItem['platform'],
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

const selectSql = (db: Db): string => `
  SELECT ri.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
         ${knowledgeTagsSql(db)},
         ri.stage, ri.note, ri.added_at, ri.last_reviewed_at, ri.next_due_on,
         (SELECT COUNT(*) FROM review_events re WHERE re.review_item_id = ri.id) AS review_count,
         (SELECT COALESCE(SUM(CASE WHEN re.feedback = 'hard' THEN 1 ELSE 0 END), 0)
            FROM review_events re WHERE re.review_item_id = ri.id) AS lapse_count
    FROM review_items ri
    JOIN problems p ON p.id = ri.problem_id
   WHERE ri.user_id = ?
`;

export function reviewsRoutes(db: Db): Router {
  const r = Router();
  const todayStr = localToday;

  // POST /api/reviews  body: { platform, problemKey } → 加入复习队列（已存在则幂等返回现有排期）
  r.post('/', (req, res) => {
    const { platform, problemKey } = req.body ?? {};
    if (typeof platform !== 'string' || typeof problemKey !== 'string' || !problemKey.trim()) {
      return res.status(400).json({ error: 'platform 与 problemKey 必填' });
    }
    const problem = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, problemKey.trim()) as { id: number } | undefined;
    if (!problem) return res.status(404).json({ error: `题库中不存在 ${platform}/${problemKey}，请先同步或导入` });
    // 已在队列里就别动它的排期：旧实现靠 INSERT OR IGNORE 静默跳过，重复点「加入复习」
    // 会把已经练到 60 天档的条目拽不回（那是对的），但界面也无从告知用户当前到期日
    const existing = db
      .prepare('SELECT next_due_on FROM review_items WHERE user_id = ? AND problem_id = ?')
      .get(DEFAULT_USER_ID, problem.id) as { next_due_on: string } | undefined;
    if (existing) {
      return res.json({ ok: true, alreadyInQueue: true, nextDueOn: existing.next_due_on });
    }
    // 新条目按题目 id 错峰 0–3 天到期：批量加入时不再同日堆满（见 schedule.ts）
    const nextDueOn = dateAfterDays(todayStr(), jitterDaysFor(problem.id));
    db.prepare('INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, ?)').run(
      DEFAULT_USER_ID,
      problem.id,
      nextDueOn,
    );
    res.json({ ok: true, alreadyInQueue: false, nextDueOn });
  });

  // GET /api/reviews?due=1 → 复习队列（due=1 只看到期与逾期）
  r.get('/', (req, res) => {
    let sql = selectSql(db);
    const params: Array<string | number> = [DEFAULT_USER_ID];
    if (req.query.due === '1') {
      sql += ' AND ri.next_due_on <= ?';
      params.push(todayStr());
    }
    sql += ' ORDER BY ri.next_due_on, p.difficulty IS NULL, p.difficulty';
    const rows = db.prepare(sql).all(...params) as unknown as RawReviewRow[];
    res.json(rows.map(toReviewItem));
  });

  // GET /api/reviews/due-count → 到期数（今日训练 / 挂件用）+ 负载分布（界面据此提示排队量）
  r.get('/due-count', (_req, res) => {
    const today = todayStr();
    const weekEnd = dateAfterDays(today, 7);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN next_due_on < ? THEN 1 ELSE 0 END), 0) AS overdue,
                COALESCE(SUM(CASE WHEN next_due_on = ? THEN 1 ELSE 0 END), 0) AS dueToday,
                COALESCE(SUM(CASE WHEN next_due_on > ? AND next_due_on <= ? THEN 1 ELSE 0 END), 0) AS next7
           FROM review_items WHERE user_id = ?`,
      )
      .get(today, today, today, weekEnd, DEFAULT_USER_ID) as {
      total: number;
      overdue: number;
      dueToday: number;
      next7: number;
    };
    res.json({
      // count 保持原口径（逾期 + 今日 = 现在就该做的量），新增字段只做透出
      count: row.overdue + row.dueToday,
      overdue: row.overdue,
      dueToday: row.dueToday,
      next7: row.next7,
      total: row.total,
    });
  });

  // POST /api/reviews/:id/feedback  body: { feedback: 'hard'|'ok'|'easy' } → 复习反馈并排期
  r.post('/:id/feedback', (req, res) => {
    const id = Number(req.params.id);
    const feedback = req.body?.feedback;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    if (feedback !== 'hard' && feedback !== 'ok' && feedback !== 'easy') {
      return res.status(400).json({ error: "feedback 需为 'hard' | 'ok' | 'easy'" });
    }
    const item = db
      .prepare(
        `SELECT ri.id, ri.stage, ri.next_due_on, ri.problem_id, p.platform, p.problem_key
           FROM review_items ri JOIN problems p ON p.id = ri.problem_id
          WHERE ri.id = ? AND ri.user_id = ?`,
      )
      .get(id, DEFAULT_USER_ID) as
      | { id: number; stage: number; next_due_on: string; problem_id: number; platform: string; problem_key: string }
      | undefined;
    if (!item) return res.status(404).json({ error: '复习条目不存在' });

    const reviewedAt = new Date().toISOString();
    const signals = collectRetentionSignals(db, DEFAULT_USER_ID, {
      id: item.id,
      problemId: item.problem_id,
      platform: item.platform,
      problemKey: item.problem_key,
    });
    const factor = retentionFactor(signals);
    const next = scheduleNext(item.stage, feedback, todayStr(), factor);
    db.prepare(
      'UPDATE review_items SET stage = ?, next_due_on = ?, last_reviewed_at = ? WHERE id = ?',
    ).run(next.stage, next.nextDueOn, reviewedAt, id);
    // 留痕：档位会被下一次覆盖，「忘过几次 / 当时逾期几天 / 实际排了几天」只能靠日志回答
    db.prepare(
      `INSERT INTO review_events
         (user_id, review_item_id, problem_id, reviewed_at, feedback, stage_before, stage_after, due_on, interval_days, factor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_USER_ID,
      item.id,
      item.problem_id,
      reviewedAt,
      feedback,
      item.stage,
      next.stage,
      item.next_due_on,
      next.intervalDays,
      factor,
    );
    res.json({ ok: true, ...next, factor });
  });

  // PATCH /api/reviews/:id  body: { note } → 笔记
  r.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    const note = req.body?.note;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    if (typeof note !== 'string') return res.status(400).json({ error: 'note 需为字符串' });
    const result = db
      .prepare('UPDATE review_items SET note = ? WHERE id = ? AND user_id = ?')
      .run(note.trim() === '' ? null : note, id, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: '复习条目不存在' });
    res.json({ ok: true });
  });

  // DELETE /api/reviews/:id → 移出队列（连带清掉它的复习日志：外键开着，留孤儿行会让删除直接失败）
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM review_events WHERE review_item_id = ? AND user_id = ?').run(id, DEFAULT_USER_ID);
    db.prepare('DELETE FROM review_items WHERE id = ? AND user_id = ?').run(id, DEFAULT_USER_ID);
    res.json({ ok: true });
  });

  return r;
}

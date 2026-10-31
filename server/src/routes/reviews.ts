import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { dateAfterDays, firstReviewDelayDays, scheduleNext } from '../reviews/schedule.ts';
import { collectRetentionSignals, retentionFactor } from '../reviews/retention.ts';
import {
  listReviewItems,
  listReviewItemsOn,
  reviewCalendar,
  reviewLoad,
} from '../reviews/query.ts';
import { localToday } from '../dates.ts';
import { problemIdentity } from '../problems/identity.ts';
import { reviewPlanTasks } from '../reviews/planTasks.ts';
import { reviewHistory } from '../reviews/history.ts';
import { addReviewFromUrl } from '../reviews/fromUrl.ts';

export function reviewsRoutes(db: Db): Router {
  const r = Router();
  const todayStr = localToday;

  r.post('/from-url', (req, res) => {
    try {
      res.json(addReviewFromUrl(db, req.body?.url, req.body?.title));
    } catch (error) {
      console.error('[reviews/from-url]', error);
      res.status(400).json({ error: error instanceof Error && !/sqlite|SQL|constraint|column|table/i.test(error.message)
        ? error.message : '添加失败，请稍后重试' });
    }
  });

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
    // 新条目按题目 id 错峰排到加入后 3–6 天首刷：刚 AC 的题不必次日重做，
    // 批量加入时也不会同日堆满（见 schedule.ts）
    const nextDueOn = dateAfterDays(todayStr(), firstReviewDelayDays(problem.id));
    db.prepare('INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, ?)').run(
      DEFAULT_USER_ID,
      problem.id,
      nextDueOn,
    );
    res.json({ ok: true, alreadyInQueue: false, nextDueOn });
  });

  // GET /api/reviews?due=1 → 复习队列（due=1 只看到期与逾期）
  // GET /api/reviews?date=YYYY-MM-DD → 指定日期该复习的条目（日历板块用；该日=今天时含逾期）
  r.get('/', (req, res) => {
    const date = req.query.date;
    if (date !== undefined) {
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date 格式需为 YYYY-MM-DD' });
      }
      return res.json(listReviewItemsOn(db, DEFAULT_USER_ID, date, todayStr()));
    }
    res.json(listReviewItems(db, DEFAULT_USER_ID, { dueOnly: req.query.due === '1', today: todayStr() }));
  });

  // GET /api/reviews/calendar?month=YYYY-MM → 月历角标 [{ date, due, overdue }]
  // 只回有到期项的日子；overdue 只挂在今天那一格（见 reviews/query.ts 的注释）。
  // 必须注册在 /:id 类路由之前（本路由是 GET，:id 路由均为写方法，当前不冲突，仍按惯例前置）。
  r.get('/calendar', (req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month 格式需为 YYYY-MM' });
    }
    res.json(reviewCalendar(db, DEFAULT_USER_ID, month, todayStr()));
  });

  // GET /api/reviews/due-count → 到期数（今日训练 / 挂件用）+ 负载分布（界面据此提示排队量）
  r.get('/due-count', (_req, res) => {
    const row = reviewLoad(db, DEFAULT_USER_ID, todayStr());
    res.json({
      // count 保持原口径（逾期 + 今日 = 现在就该做的量），新增字段只做透出
      count: row.overdue + row.dueToday,
      overdue: row.overdue,
      dueToday: row.dueToday,
      next7: row.next7,
      total: row.total,
    });
  });

  // GET /api/reviews/:id/history → 当前用户同题（含镜像）的分页复习记录
  r.get('/:id/history', (req, res) => {
    const id = Number(req.params.id);
    const validPage = (value: unknown, max: number) => value === undefined ||
      (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'id 非法' });
    if (!validPage(req.query.page, 1_000_000) || !validPage(req.query.pageSize, 100)) {
      return res.status(400).json({ error: 'page 需为 1–1000000 的整数，pageSize 需为 1–100 的整数' });
    }
    const item = db.prepare(`SELECT p.platform, p.problem_key FROM review_items ri
      JOIN problems p ON p.id = ri.problem_id WHERE ri.id = ? AND ri.user_id = ?`)
      .get(id, DEFAULT_USER_ID) as { platform: string; problem_key: string } | undefined;
    if (!item) return res.status(404).json({ error: '复习条目不存在' });
    res.json(reviewHistory(db, DEFAULT_USER_ID,
      problemIdentity({ platform: item.platform, problemKey: item.problem_key }),
      Number(req.query.page ?? 1), Number(req.query.pageSize ?? 20)));
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
    const date = todayStr();
    const next = scheduleNext(item.stage, feedback, date, factor);
    let eventId: number;
    db.exec('BEGIN');
    try {
      db.prepare(
        'UPDATE review_items SET stage = ?, next_due_on = ?, last_reviewed_at = ? WHERE id = ?',
      ).run(next.stage, next.nextDueOn, reviewedAt, id);
      // 留痕：档位会被下一次覆盖，「忘过几次 / 当时逾期几天 / 实际排了几天」只能靠日志回答。
      const event = db.prepare(
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
      eventId = Number(event.lastInsertRowid);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const planTasks = reviewPlanTasks(db, DEFAULT_USER_ID, problemIdentity({ platform: item.platform, problemKey: item.problem_key }), date);
    res.json({ ok: true, ...next, factor, eventId, planTasks });
  });

  // 反馈已保存后单独确认任务；取消弹窗不会撤销复习，也不会擅自增加打卡。
  r.post('/:id/complete-tasks', (req, res) => {
    const id = Number(req.params.id);
    const { eventId, taskIds } = req.body ?? {};
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(eventId) || eventId <= 0 ||
        !Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 1000 ||
        taskIds.some((taskId: unknown) => !Number.isSafeInteger(taskId) || Number(taskId) <= 0)) {
      return res.status(400).json({ error: '需要有效的复习记录和任务 ID 数组（1–1000 项）' });
    }
    const event = db.prepare(`SELECT re.reviewed_at, p.platform, p.problem_key
      FROM review_events re JOIN problems p ON p.id = re.problem_id
      WHERE re.id = ? AND re.review_item_id = ? AND re.user_id = ?`)
      .get(eventId, id, DEFAULT_USER_ID) as { reviewed_at: string; platform: string; problem_key: string } | undefined;
    if (!event) return res.status(404).json({ error: '复习记录不存在' });
    const date = todayStr();
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    const at = Date.parse(event.reviewed_at);
    if (!Number.isFinite(at) || at < from.getTime() || at >= to.getTime()) {
      return res.status(409).json({ error: '仅能用今天的复习记录确认今天的任务，请刷新后重试' });
    }
    const allowed = new Set(reviewPlanTasks(db, DEFAULT_USER_ID, problemIdentity({ platform: event.platform, problemKey: event.problem_key }), date, true).map(t => t.id));
    if (taskIds.some((taskId: number) => !allowed.has(taskId))) {
      return res.status(400).json({ error: '所选任务不是今天该题的复习任务，请刷新后重试' });
    }
    const write = db.prepare('INSERT OR IGNORE INTO checkins(user_id,task_id,task_date) VALUES(?,?,?)');
    let checked = 0;
    db.exec('BEGIN');
    try {
      for (const taskId of new Set<number>(taskIds)) checked += Number(write.run(DEFAULT_USER_ID, taskId, date).changes);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ checked });
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
    // 与列表/计划等兄弟端点同口径：非法 id 400、不存在 404，而不是一律回 ok:true
    // （原实现不校验也不看 changes，前端无从判断「是否真的删掉了」）
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    db.prepare('DELETE FROM review_events WHERE review_item_id = ? AND user_id = ?').run(id, DEFAULT_USER_ID);
    const result = db.prepare('DELETE FROM review_items WHERE id = ? AND user_id = ?').run(id, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: '复习条目不存在' });
    res.json({ ok: true });
  });

  return r;
}

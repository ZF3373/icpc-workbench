import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { safeTags } from '../analysis/stats.ts';
import { intervalDaysForStage, scheduleNext } from '../reviews/schedule.ts';
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
    note: r.note,
    nextDueOn: r.next_due_on,
    lastReviewedAt: r.last_reviewed_at,
    addedAt: r.added_at,
  };
}

const SELECT_SQL = `
  SELECT ri.id, p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags,
         ri.stage, ri.note, ri.added_at, ri.last_reviewed_at, ri.next_due_on
    FROM review_items ri
    JOIN problems p ON p.id = ri.problem_id
   WHERE ri.user_id = ?
`;

export function reviewsRoutes(db: Db): Router {
  const r = Router();
  const todayStr = () => new Date().toISOString().slice(0, 10);

  // POST /api/reviews  body: { platform, problemKey } → 加入复习队列（已存在则幂等返回）
  r.post('/', (req, res) => {
    const { platform, problemKey } = req.body ?? {};
    if (typeof platform !== 'string' || typeof problemKey !== 'string' || !problemKey.trim()) {
      return res.status(400).json({ error: 'platform 与 problemKey 必填' });
    }
    const problem = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, problemKey.trim()) as { id: number } | undefined;
    if (!problem) return res.status(404).json({ error: `题库中不存在 ${platform}/${problemKey}，请先同步或导入` });
    db.prepare(
      `INSERT OR IGNORE INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, ?)`,
    ).run(DEFAULT_USER_ID, problem.id, todayStr());
    res.json({ ok: true });
  });

  // GET /api/reviews?due=1 → 复习队列（due=1 只看到期与逾期）
  r.get('/', (req, res) => {
    let sql = SELECT_SQL;
    const params: Array<string | number> = [DEFAULT_USER_ID];
    if (req.query.due === '1') {
      sql += ' AND ri.next_due_on <= ?';
      params.push(todayStr());
    }
    sql += ' ORDER BY ri.next_due_on, p.difficulty IS NULL, p.difficulty';
    const rows = db.prepare(sql).all(...params) as unknown as RawReviewRow[];
    res.json(rows.map(toReviewItem));
  });

  // GET /api/reviews/due-count → 到期数（今日训练 / 挂件用）
  r.get('/due-count', (_req, res) => {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM review_items WHERE user_id = ? AND next_due_on <= ?')
      .get(DEFAULT_USER_ID, todayStr()) as { c: number };
    res.json({ count: row.c });
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
      .prepare('SELECT id, stage FROM review_items WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as { id: number; stage: number } | undefined;
    if (!item) return res.status(404).json({ error: '复习条目不存在' });
    const next = scheduleNext(item.stage, feedback, todayStr());
    db.prepare(
      'UPDATE review_items SET stage = ?, next_due_on = ?, last_reviewed_at = ? WHERE id = ?',
    ).run(next.stage, next.nextDueOn, new Date().toISOString(), id);
    res.json({ ok: true, ...next });
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

  // DELETE /api/reviews/:id → 移出队列
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM review_items WHERE id = ? AND user_id = ?').run(id, DEFAULT_USER_ID);
    res.json({ ok: true });
  });

  return r;
}

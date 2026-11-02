import { Router, type Response } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { localToday } from '../dates.ts';
import { listTodayTasks } from '../plans/todayTasks.ts';
import { checkinWithNote, NoteInputError, parseNoteInput, type NoteInput } from '../notes/problemNotes.ts';

export interface StreakInfo {
  current: number;
  longest: number;
  totalDays: number;
}

function toDate(str: string): number {
  return Number(new Date(`${str}T00:00:00Z`).getTime() / 86_400_000) | 0;
}

/** 由已打卡日期集合（YYYY-MM-DD 升序去重）计算连续打卡：current 从今天（或昨天）往前数，longest 为历史最长。 */
export function computeStreak(dates: string[], todayStr: string): StreakInfo {
  const days = [...new Set(dates)].map(toDate).sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0, totalDays: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    run = days[i] - days[i - 1] === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const today = toDate(todayStr);
  const set = new Set(days);
  let cursor = set.has(today) ? today : today - 1; // 今天尚未打卡不打断连续（以昨天为终点）
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor -= 1;
  }
  return { current, longest, totalDays: days.length };
}

/** 解析打卡必带的笔记；不合法时已回 400，返回 null */
function readNote(raw: unknown, res: Response): NoteInput | null {
  try {
    return parseNoteInput(raw);
  } catch (e) {
    if (!(e instanceof NoteInputError)) throw e;
    res.status(400).json({ error: `打卡需要先写笔记：${e.message}` });
    return null;
  }
}

export function checkinsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/checkins/streak → 连续打卡统计（桌面挂件亦可用）
  r.get('/streak', (_req, res) => {
    const rows = db
      .prepare('SELECT DISTINCT task_date FROM checkins WHERE user_id = ? ORDER BY task_date')
      .all(DEFAULT_USER_ID) as Array<{ task_date: string }>;
    const todayStr = localToday();
    res.json(computeStreak(rows.map((r2) => r2.task_date), todayStr));
  });

  // GET /api/checkins?month=YYYY-MM → 月视图 [{ date, total, checked }]
  r.get('/', (req, res) => {
    const month = String(req.query.month ?? '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month 格式需为 YYYY-MM' });
    }
    const rows = db
      .prepare(
        `SELECT task_date AS date, COUNT(*) AS total,
                COALESCE(SUM((SELECT 1 FROM checkins c WHERE c.task_id = t.id)), 0) AS checked
           FROM plan_tasks t
          WHERE t.task_date LIKE ?
          GROUP BY t.task_date`,
      )
      .all(`${month}%`) as unknown as Array<{ date: string; total: number; checked: number }>;
    res.json(rows);
  });

  // GET /api/checkins/date/:date → 当天任务（含打卡状态与跳转链接）
  r.get('/date/:date', (req, res) => {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date 格式需为 YYYY-MM-DD' });
    }
    const tasks = db
      .prepare(
        `SELECT t.id, t.task_date, t.title, t.kind, t.url, t.note,
                p.platform, p.problem_key, p.title AS problem_title, p.url AS problem_url,
                (SELECT 1 FROM checkins c WHERE c.task_id = t.id) AS checked
           FROM plan_tasks t
           LEFT JOIN problems p ON t.problem_id = p.id
          WHERE t.task_date = ?
          ORDER BY t.id`,
      )
      .all(date);
    res.json(tasks);
  });

  // POST /api/checkins/auto-today  body: { taskIds?, note? }
  // 预览不写入；确认时重新核对当日 AC、任务类型和归属，并给每项任务写入 note。旧 AC 不代替本次训练。
  r.post('/auto-today', (req, res) => {
    const ids = req.body?.taskIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => !Number.isInteger(id) || id <= 0))) {
      return res.status(400).json({ error: 'taskIds 需为任务 ID 数组（最多 1000 项）' });
    }
    const tasks = listTodayTasks(db, DEFAULT_USER_ID, localToday())
      .filter((t) => t.kind === 'practice' && !t.checked && t.solvedToday);
    if (ids === undefined) return res.json({ taskIds: tasks.map((t) => t.id), tasks });
    const note = readNote(req.body?.note, res);
    if (!note) return;
    const selected = new Set<number>(ids);
    let checked = 0;
    db.exec('BEGIN');
    try {
      for (const t of tasks) if (selected.has(t.id) && checkinWithNote(db, DEFAULT_USER_ID, t, note)) checked += 1;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ checked });
  });

  // POST /api/checkins  body: { taskId, note: { content, labels? } } → 写入笔记并打卡（同一事务）
  r.post('/', (req, res) => {
    const taskId = Number(req.body?.taskId);
    if (!Number.isInteger(taskId)) {
      return res.status(400).json({ error: 'taskId 必填' });
    }
    const note = readNote(req.body?.note, res);
    if (!note) return;
    const task = db.prepare('SELECT id, task_date FROM plan_tasks WHERE id = ?').get(taskId) as
      | { id: number; task_date: string }
      | undefined;
    if (!task) return res.status(404).json({ error: '任务不存在' });
    db.exec('BEGIN');
    let done: boolean;
    try {
      done = checkinWithNote(db, DEFAULT_USER_ID, task, note);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (!done) return res.status(409).json({ error: '该任务已打卡；需要补充内容请「再写一条」' });
    res.json({ ok: true });
  });

  // 打卡完成后不可取消：显式回 405，让旧版挂件/外部调用方拿到原因而不是路由 404
  r.delete('/:taskId', (_req, res) => {
    res.status(405).json({ error: '打卡完成后不可取消；可以编辑笔记或再写一条' });
  });

  return r;
}

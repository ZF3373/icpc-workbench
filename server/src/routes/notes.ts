import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import {
  insertTaskNote,
  NoteInputError,
  parseNoteBody,
  parseNoteInput,
  parseNoteLabels,
  readNoteBlocks,
} from '../notes/problemNotes.ts';

interface NoteRow {
  id: number;
  problem_id: number | null;
  task_id: number | null;
  labels: string;
  content: string;
  blocks: string | null;
  created_at: string;
  updated_at: string;
  task_title: string | null;
  task_date: string | null;
  plan_title: string | null;
}

/** datetime('now') 产出无时区的 UTC 文本，转成 ISO 后前端才能按本地时区显示 */
const utcToIso = (s: string): string => `${s.replace(' ', 'T')}Z`;

function toApiNote(r: NoteRow) {
  let labels: string[] = [];
  try {
    const parsed = JSON.parse(r.labels) as unknown;
    if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === 'string');
  } catch {
    /* 标注损坏不该让正文也读不出来 */
  }
  return {
    id: r.id,
    problemId: r.problem_id,
    taskId: r.task_id,
    labels,
    content: r.content,
    blocks: readNoteBlocks(r.blocks, r.content),
    createdAt: utcToIso(r.created_at),
    updatedAt: utcToIso(r.updated_at),
    taskTitle: r.task_title,
    taskDate: r.task_date,
    planTitle: r.plan_title,
  };
}

const NOTE_SELECT = `
  SELECT n.id, COALESCE(n.problem_id, t.problem_id) AS problem_id, n.task_id, n.labels, n.content, n.blocks,
         n.created_at, n.updated_at, t.title AS task_title, t.task_date, pl.title AS plan_title
    FROM problem_notes n
    LEFT JOIN plan_tasks t ON t.id = n.task_id
    LEFT JOIN plans pl ON pl.id = t.plan_id
`;

const positiveId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function notesRoutes(db: Db): Router {
  const r = Router();

  const readNote = (id: number): NoteRow | undefined =>
    db.prepare(`${NOTE_SELECT} WHERE n.id = ? AND n.user_id = ?`).get(id, DEFAULT_USER_ID) as NoteRow | undefined;

  // GET /api/notes?problemId= | ?taskId= → 笔记列表（新的在前）
  // 按题查询取 COALESCE：任务写笔记时可能还没关联到题目，之后才被计划修改关联上
  r.get('/', (req, res) => {
    const problemId = positiveId(req.query.problemId);
    const taskId = positiveId(req.query.taskId);
    if ((problemId === null) === (taskId === null)) {
      return res.status(400).json({ error: '需要且只能指定 problemId 或 taskId 之一' });
    }
    const where = problemId !== null ? 'COALESCE(n.problem_id, t.problem_id) = ?' : 'n.task_id = ?';
    const rows = db
      .prepare(`${NOTE_SELECT} WHERE n.user_id = ? AND ${where} ORDER BY n.id DESC`)
      .all(DEFAULT_USER_ID, problemId ?? taskId) as unknown as NoteRow[];
    res.json({ items: rows.map(toApiNote) });
  });

  // POST /api/notes  body: { problemId | taskId, blocks | content, labels? } → 新增一条笔记（不改变打卡状态）
  r.post('/', (req, res) => {
    const body = (req.body ?? {}) as { problemId?: unknown; taskId?: unknown };
    const problemId = positiveId(body.problemId);
    const taskId = positiveId(body.taskId);
    if ((problemId === null) === (taskId === null)) {
      return res.status(400).json({ error: '需要且只能指定 problemId 或 taskId 之一' });
    }
    let id: number;
    if (taskId !== null) {
      if (!db.prepare('SELECT 1 AS hit FROM plan_tasks WHERE id = ?').get(taskId)) {
        return res.status(404).json({ error: '任务不存在' });
      }
      id = insertTaskNote(db, DEFAULT_USER_ID, taskId, parseNoteInput(req.body));
    } else {
      if (!db.prepare('SELECT 1 AS hit FROM problems WHERE id = ?').get(problemId)) {
        return res.status(404).json({ error: '题目不存在' });
      }
      const note = parseNoteInput(req.body);
      id = Number(
        db
          .prepare('INSERT INTO problem_notes (user_id, problem_id, labels, content, blocks) VALUES (?, ?, ?, ?, ?)')
          .run(DEFAULT_USER_ID, problemId, JSON.stringify(note.labels), note.content, JSON.stringify(note.blocks)).lastInsertRowid,
      );
    }
    res.json(toApiNote(readNote(id)!));
  });

  // PATCH /api/notes/:id  body: { blocks? | content?, labels? }
  r.patch('/:id', (req, res) => {
    const id = positiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id 非法' });
    const body = (req.body ?? {}) as { blocks?: unknown; content?: unknown; labels?: unknown };
    const hasBody = body.blocks !== undefined || body.content !== undefined;
    if (!hasBody && body.labels === undefined) {
      return res.status(400).json({ error: '没有可更新字段（blocks/content/labels）' });
    }
    const parsed = hasBody ? parseNoteBody(body) : null;
    const labels = body.labels === undefined ? null : JSON.stringify(parseNoteLabels(body.labels));
    const result = db
      .prepare(
        `UPDATE problem_notes
            SET content = COALESCE(?, content), blocks = COALESCE(?, blocks),
                labels = COALESCE(?, labels), updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`,
      )
      .run(parsed?.content ?? null, parsed ? JSON.stringify(parsed.blocks) : null, labels, id, DEFAULT_USER_ID);
    if (Number(result.changes) === 0) return res.status(404).json({ error: '笔记不存在' });
    res.json(toApiNote(readNote(id)!));
  });

  // DELETE /api/notes/:id → 已打卡任务至少保留一条笔记（打卡不可取消，删光就成了无笔记的打卡）
  r.delete('/:id', (req, res) => {
    const id = positiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id 非法' });
    const note = db
      .prepare('SELECT task_id FROM problem_notes WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as { task_id: number | null } | undefined;
    if (!note) return res.status(404).json({ error: '笔记不存在' });
    if (note.task_id !== null) {
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM problem_notes WHERE task_id = ?')
        .get(note.task_id) as { n: number };
      const checked = db.prepare('SELECT 1 AS hit FROM checkins WHERE task_id = ?').get(note.task_id);
      if (checked && n <= 1) {
        return res.status(409).json({ error: '这是该打卡任务的最后一条笔记，不能删除；可以改写内容' });
      }
    }
    db.prepare('DELETE FROM problem_notes WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  r.use(((err, _req, res, next) => {
    if (err instanceof NoteInputError) return res.status(400).json({ error: err.message });
    next(err);
  }) as import('express').ErrorRequestHandler);

  return r;
}

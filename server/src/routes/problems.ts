import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { bucketForDifficulty, safeTags } from '../analysis/stats.ts';

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
  last_ac_at: string | null;
}

export function problemsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/problems?platform=&difficulty=&tag=&q=
  r.get('/', (req, res) => {
    const { platform, difficulty, tag, q } = req.query;
    if (platform && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    let sql = `
      SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags,
             COUNT(s.id) AS attempts,
             COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac_count,
             MAX(CASE WHEN s.verdict = 'AC' THEN s.submitted_at END) AS last_ac_at
        FROM problems p
        LEFT JOIN submissions s ON s.problem_id = p.id AND s.user_id = ?
       WHERE 1 = 1
    `;
    const params: Array<string | number> = [DEFAULT_USER_ID];
    if (typeof platform === 'string') {
      sql += ' AND p.platform = ?';
      params.push(platform);
    }
    if (typeof q === 'string' && q.trim() !== '') {
      sql += ' AND (p.title LIKE ? OR p.problem_key LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ' GROUP BY p.id ORDER BY p.difficulty IS NULL, p.difficulty DESC LIMIT 300';
    let rows = db.prepare(sql).all(...params) as unknown as ProblemRow[];
    if (typeof difficulty === 'string') {
      rows = rows.filter((r) => bucketForDifficulty(r.difficulty) === difficulty);
    }
    if (typeof tag === 'string' && tag !== '') {
      rows = rows.filter((r) => safeTags(r.tags).includes(tag));
    }
    res.json(
      rows.map((r) => ({
        ...r,
        tags: safeTags(r.tags),
        status: r.ac_count > 0 ? 'ac' : r.attempts > 0 ? 'tried' : 'none',
      })),
    );
  });

  return r;
}

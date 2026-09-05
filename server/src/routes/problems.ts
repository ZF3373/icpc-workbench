import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { bucketForDifficulty, safeTags } from '../analysis/stats.ts';
import { backfillDifficulties } from '../analysis/difficultyBackfill.ts';
import { fetchLuoguBank, fetchNowcoderBank } from '../adapters/problemBank.ts';
import { upsertBankProblems } from '../import/bankService.ts';

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

export function problemsRoutes(db: Db, fetchFn: typeof fetch = fetch): Router {
  const r = Router();

  // GET /api/problems?platform=&difficulty=&tag=&q=&bank=1
  // bank 缺省：只显示「做过」（有提交记录）的题；bank=1 时包含题库拉取的未做题
  r.get('/', (req, res) => {
    const { platform, difficulty, tag, q, bank } = req.query;
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
    if (bank !== '1') {
      sql += ' AND EXISTS (SELECT 1 FROM submissions s2 WHERE s2.problem_id = p.id AND s2.user_id = ?)';
      params.push(DEFAULT_USER_ID);
    }
    if (typeof platform === 'string') {
      sql += ' AND p.platform = ?';
      params.push(platform);
    }
    if (typeof q === 'string' && q.trim() !== '') {
      sql += ' AND (p.title LIKE ? OR p.problem_key LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ' GROUP BY p.id ORDER BY p.difficulty IS NULL, p.difficulty DESC';
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

  // POST /api/problems/bank  body: { platform: 'luogu' | 'nowcoder', max?, luoguMinDifficulty? }
  // 拉取公开题库入库（匿名可访问），扩充待选题目池（不产生提交记录）
  r.post('/bank', asyncHandler(async (req, res) => {
    const { platform, max, luoguMinDifficulty } = req.body ?? {};
    if (platform !== 'luogu' && platform !== 'nowcoder') {
      return res.status(400).json({ error: 'platform 需为 luogu 或 nowcoder' });
    }
    const maxN =
      typeof max === 'number' && Number.isFinite(max)
        ? Math.min(5000, Math.max(50, Math.floor(max)))
        : 2000;
    const minDiff =
      typeof luoguMinDifficulty === 'number' && Number.isFinite(luoguMinDifficulty)
        ? luoguMinDifficulty
        : undefined;
    try {
      const fetcher = platform === 'luogu' ? fetchLuoguBank : fetchNowcoderBank;
      const result = await fetcher(fetchFn, { max: maxN, ...(minDiff !== undefined ? { luoguMinDifficulty: minDiff } : {}) });
      const imported = upsertBankProblems(db, result.problems);
      res.json({
        ok: true,
        platform,
        total: result.total,
        fetched: result.problems.length,
        inserted: imported[0]?.inserted ?? 0,
        updated: imported[0]?.updated ?? 0,
      });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  }));

  // POST /api/problems/backfill-difficulty
  // 对库内未知难度的洛谷/牛客题逐题查询公开接口回填（匿名可访问）：
  // - 牛客顺带修复标题污染/空标签（题库搜索接口返回分离的标题与算法标签）
  // - CF 未知难度题为 gym/官方 Unrated 比赛，官方无 rating，不参与回填
  // 耗时与待补题数成正比（牛客 ~0.5s/题），大库时前端需提示等待
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

  return r;
}

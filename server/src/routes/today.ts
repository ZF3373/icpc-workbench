import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { safeTags } from '../analysis/stats.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { bandRanges, estimateLevel, pickBand, type CandidateProblem } from '../today/select.ts';
import type { TodayBandKey, TodayProblem } from '../../../shared/src/index.ts';

/** 每档默认题量：巩固 2 / 同段 3 / 挑战 1（cf-compass 同段承担主训练量） */
const DEFAULT_COUNTS: Record<TodayBandKey, number> = {
  consolidation: 2,
  core: 3,
  challenge: 1,
};

const BAND_KEYS: TodayBandKey[] = ['consolidation', 'core', 'challenge'];

export function todayRoutes(db: Db): Router {
  const r = Router();

  // GET /api/today?consolidation=&core=&challenge=&rotate=&windowDays=
  // 三档题单：题库未 AC 题 → 按能力值分档 → 弱项标签优先
  r.get('/', (req, res) => {
    const todayStr = new Date().toISOString().slice(0, 10);

    // 1) 能力值：近 N 天 AC 难度中位数（N 默认 60），回退全部 AC，再回退 1200
    const windowDays = Math.min(365, Math.max(7, Number(req.query.windowDays) || 60));
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const recentAc = db
      .prepare(
        `SELECT p.difficulty FROM submissions s JOIN problems p ON p.id = s.problem_id
          WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL AND s.submitted_at >= ?
          ORDER BY s.submitted_at DESC`,
      )
      .all(DEFAULT_USER_ID, since) as Array<{ difficulty: number | null }>;
    const recentDifficulties = recentAc.map((x) => x.difficulty as number);
    let level: number;
    if (recentDifficulties.length >= 5) {
      level = estimateLevel(recentDifficulties);
    } else {
      const allAc = db
        .prepare(
          `SELECT p.difficulty FROM submissions s JOIN problems p ON p.id = s.problem_id
            WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL`,
        )
        .all(DEFAULT_USER_ID) as Array<{ difficulty: number | null }>;
      level = estimateLevel(allAc.map((x) => x.difficulty as number));
    }

    // 2) 候选题：题库中有难度、未 AC 的题（提交记录里 AC 过的排除）
    const candidates = db
      .prepare(
        `SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags
           FROM problems p
          WHERE p.difficulty IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM submissions s
               WHERE s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC'
            )`,
      )
      .all(DEFAULT_USER_ID) as unknown as Array<Omit<CandidateProblem, 'tags'> & { tags: string }>;
    const pool: CandidateProblem[] = candidates.map((c) => ({ ...c, tags: safeTags(c.tags) }));

    // 3) 弱项标签（gap > 0 才算弱）
    const weakness = computeWeakness(db, DEFAULT_USER_ID, { minAttempts: 5, topN: 15 });
    const weakTags = weakness.items.filter((i) => i.gap > 0).map((i) => i.tag);

    // 4) 逐档选题（跨档去重 + rotate 换一批）
    const ranges = bandRanges(level);
    const rotate = Math.max(0, Math.min(500, Number(req.query.rotate) || 0));
    const exclude = new Set<number>();
    const bands = BAND_KEYS.map((key) => {
      const q = Number(req.query[key]);
      const count = Number.isInteger(q) && q >= 0 && q <= 6 ? q : DEFAULT_COUNTS[key];
      const picked = pickBand(pool, ranges[key], count, weakTags, exclude, rotate);
      for (const p of picked.problems) exclude.add(p.id);
      return { key, label: ranges[key].label, description: ranges[key].description, range: [ranges[key].min, ranges[key].max] as [number | null, number | null], problems: picked.problems, pool: picked.pool };
    });

    // 5) 到期复习数 + 今日计划进度
    const dueReviews = (
      db
        .prepare('SELECT COUNT(*) AS c FROM review_items WHERE user_id = ? AND next_due_on <= ?')
        .get(DEFAULT_USER_ID, todayStr) as { c: number }
    ).c;
    const planProgressRow = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM((SELECT 1 FROM checkins c WHERE c.task_id = t.id)), 0) AS checked
           FROM plan_tasks t WHERE t.task_date = ?`,
      )
      .get(todayStr) as { total: number; checked: number };

    res.json({
      date: todayStr,
      level,
      bands,
      dueReviews,
      planProgress: planProgressRow.total > 0 ? { total: planProgressRow.total, checked: planProgressRow.checked } : null,
    });
  });

  return r;
}

/** 供测试与后续挂件复用的类型收窄（不参与运行时） */
export type { TodayProblem };

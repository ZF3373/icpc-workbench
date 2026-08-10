import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { computeOverall } from '../analysis/stats.ts';
import { computeTrend } from '../analysis/trend.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

export function statsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/stats?from=&to=&platform=
  r.get('/', (req, res) => {
    const { from, to, platform } = req.query;
    if (platform && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    res.json(
      computeOverall(db, DEFAULT_USER_ID, {
        from: str(from),
        to: str(to),
        platform: platform as PlatformId | undefined,
      }),
    );
  });

  // GET /api/stats/weakness?minAttempts=&topN=
  r.get('/weakness', (req, res) => {
    const minAttempts = num(req.query.minAttempts, 5, 1, 1000);
    const topN = num(req.query.topN, 10, 1, 100);
    res.json(computeWeakness(db, DEFAULT_USER_ID, { minAttempts, topN }));
  });

  // GET /api/stats/trend?weeks=
  r.get('/trend', (req, res) => {
    const weeks = num(req.query.weeks, 12, 1, 52);
    res.json(computeTrend(db, DEFAULT_USER_ID, weeks));
  });

  return r;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

import { Router } from 'express';
import type { ManualSubmissionRow, PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { insertNormalized } from '../import/importService.ts';
import { parseCsvRows, parseManualRow } from '../import/rows.ts';

export function importRoutes(db: Db): Router {
  const r = Router();

  r.post('/manual', (req, res) => {
    const { platform, rows } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows 必须是数组' });
    }
    try {
      const subs = rows.map((row, i) =>
        parseManualRow(platform as PlatformId, row as ManualSubmissionRow, i),
      );
      res.json(insertNormalized(db, DEFAULT_USER_ID, subs));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  r.post('/csv', (req, res) => {
    const { platform, csv } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    if (typeof csv !== 'string') {
      return res.status(400).json({ error: 'csv 必须是字符串' });
    }
    try {
      const subs = parseCsvRows(platform as PlatformId, csv);
      res.json(insertNormalized(db, DEFAULT_USER_ID, subs));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return r;
}

function isPlatform(p: unknown): p is PlatformId {
  return typeof p === 'string' && PLATFORMS.some((x) => x.id === p);
}

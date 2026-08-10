import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { syncPlatform } from '../adapters/sync.ts';

export function syncRoutes(db: Db): Router {
  const r = Router();

  // POST /api/sync/:platform  body: { handle }
  r.post('/:platform', async (req, res) => {
    const { platform } = req.params;
    const { handle } = req.body ?? {};
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    if (typeof handle !== 'string' || handle.trim() === '') {
      return res.status(400).json({ error: 'handle 必填' });
    }
    const result = await syncPlatform(db, platform as PlatformId, handle.trim());
    // 平台无公开 API 等受限情况返回 200 + errors 引导（非致命）
    res.json(result);
  });

  return r;
}

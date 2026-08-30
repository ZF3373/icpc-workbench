import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { syncPlatform } from '../adapters/sync.ts';

export function syncRoutes(db: Db): Router {
  const r = Router();

  // POST /api/sync/all → 一键同步所有已绑定的启用账号（顺序执行，避免同时打多个平台接口）。
  // 每个平台沿用自身增量策略：AtCoder from_second / 牛客 since 截断 / CF·洛谷 已知提交号提前终止。
  // 未绑定账号的平台直接跳过；单平台失败不影响其余平台。
  r.post('/all', async (_req, res) => {
    const accounts = db
      .prepare(
        'SELECT platform, handle FROM platform_accounts WHERE user_id = ? AND enabled = 1 ORDER BY platform',
      )
      .all(DEFAULT_USER_ID) as Array<{ platform: PlatformId; handle: string }>;
    const results = [];
    for (const acc of accounts) {
      const started = Date.now();
      const result = await syncPlatform(db, acc.platform, acc.handle);
      results.push({ ...result, durationMs: Date.now() - started });
    }
    res.json({ results });
  });

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

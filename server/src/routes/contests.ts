import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { fetchAllContests, selectContests } from '../contests/index.ts';

export function contestsRoutes(fetchFn: typeof fetch = fetch): Router {
  const r = Router();

  // GET /api/contests?type=upcoming|finished&platform=&limit=
  // 聚合 Codeforces / AtCoder / 洛谷 / 牛客 公开赛事（各源独立缓存 30 分钟，单源失败降级跳过）
  r.get('/', asyncHandler(async (req, res) => {
    const type = req.query.type === 'finished' ? 'finished' : 'upcoming';
    const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
    if (platform && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    try {
      const { contests, failures } = await fetchAllContests(fetchFn);
      res.json({
        contests: selectContests(contests, {
          type,
          ...(platform !== undefined ? { platform: platform as PlatformId } : {}),
          limit: Number(req.query.limit) || 40,
        }),
        failures,
      });
    } catch (e) {
      res.status(502).json({ error: `赛事拉取失败：${(e as Error).message}` });
    }
  }));

  return r;
}

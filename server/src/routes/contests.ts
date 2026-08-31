import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { fetchAllContests, parseCfGroupCodes, selectContests } from '../contests/index.ts';
import type { Db } from '../db/index.ts';

export function contestsRoutes(db: Db, fetchFn: typeof fetch = fetch): Router {
  const r = Router();

  // GET /api/contests?type=upcoming|finished&platform=&limit=
  // 聚合 Codeforces / AtCoder / 洛谷 / 牛客 公开赛事 + 已配置的 CF 小组赛
  // （各源独立缓存 30 分钟，单源失败降级跳过）
  r.get('/', async (req, res) => {
    const type = req.query.type === 'finished' ? 'finished' : 'upcoming';
    const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
    if (platform && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    const groupRow = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('contests.cfGroups') as { value: string } | undefined;
    const readSetting = (key: string): string | undefined =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
        ?.value;
    const apiKey = readSetting('codeforces.apiKey');
    const secret = readSetting('codeforces.secret');
    try {
      const { contests, failures } = await fetchAllContests(fetchFn, {
        cfGroupCodes: parseCfGroupCodes(groupRow?.value),
        ...(apiKey && secret ? { cfApiAuth: { apiKey, secret } } : {}),
      });
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
  });

  return r;
}

import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { fetchAllContests, selectContests } from '../contests/index.ts';
import { deriveParticipatedContests } from '../contests/participated.ts';
import {
  kickBackgroundRefresh,
  loadParticipationSources,
  readParticipationSnapshot,
} from '../contests/participationSources.ts';
import type { Db } from '../db/index.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

/** 拉一次赛事日历（各源 60min 缓存；全挂时降级为 undefined，不阻断） */
async function loadCalendar(fetchFn: typeof fetch) {
  try {
    return (await fetchAllContests(fetchFn)).contests;
  } catch {
    return undefined;
  }
}

export function contestsRoutes(db: Db, fetchFn: typeof fetch = throttledFetch): Router {
  const r = Router();

  // GET /api/contests?type=upcoming|running|finished&platform=&limit=
  // 聚合 Codeforces / AtCoder / 洛谷 / 牛客 公开赛事（各源独立缓存 60 分钟，单源失败降级跳过）
  r.get('/', asyncHandler(async (req, res) => {
    // running 必须独立可见：开赛后约 2 小时内比赛既不在 upcoming 也没到 finished，
    // 缺这个档会让「进行中」的比赛从赛事中心两个页签同时消失（恰是最想看它的时候）
    const type = req.query.type === 'finished' ? 'finished' : req.query.type === 'running' ? 'running' : 'upcoming';
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

  // GET /api/contests/participated
  // 赛后复盘「我参加的」：本地提交推导 + 平台参赛记录（落库持久化，增量拉取）。
  // 读库秒出；参赛记录超过 30 分钟未更新的平台触发后台增量刷新（不影响本次响应，
  // 下次打开/刷新可见）。「刷新」按钮请走 POST /participated/refresh 强制同步拉取。
  r.get('/participated', asyncHandler(async (_req, res) => {
    const calendar = await loadCalendar(fetchFn);
    const snapshot = readParticipationSnapshot(db);
    const hasStored = Object.keys(snapshot.byPlatform).length > 0;
    if (!hasStored && snapshot.stalePlatforms.length > 0) {
      // 首次使用（库内还没有任何参赛记录）：同步初始化（带单次上限），避免首次打开是空列表
      const sources = await loadParticipationSources(db, calendar);
      res.json({
        contests: deriveParticipatedContests(db, { calendar, sources: sources.byPlatform }),
        sourceFailures: sources.failures,
        refreshing: [],
      });
      return;
    }
    let refreshing: PlatformId[] = [];
    if (snapshot.stalePlatforms.length > 0 && kickBackgroundRefresh(db, calendar)) {
      refreshing = snapshot.stalePlatforms;
    }
    res.json({
      contests: deriveParticipatedContests(db, { calendar, sources: snapshot.byPlatform }),
      sourceFailures: snapshot.failures,
      refreshing,
    });
  }));

  // POST /api/contests/participated/refresh
  // 强制同步拉取参赛记录（无视 30 分钟间隔；增量游标生效——backlog 已完成的平台
  // 通常只拉第 1 页，被单次上限截断的平台继续向后补全），返回刷新后的完整列表。
  r.post('/participated/refresh', asyncHandler(async (_req, res) => {
    const calendar = await loadCalendar(fetchFn);
    const sources = await loadParticipationSources(db, calendar, { force: true });
    res.json({
      contests: deriveParticipatedContests(db, { calendar, sources: sources.byPlatform }),
      sourceFailures: sources.failures,
      refreshing: [],
    });
  }));

  return r;
}

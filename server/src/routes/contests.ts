import { Router } from 'express';
import type { ContestAnalysisResponse, ParticipatedContest, PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { fetchAllContests, browseContests } from '../contests/index.ts';
import { calendarCache } from '../contests/calendarCache.ts';
import { deriveParticipatedContests } from '../contests/participated.ts';
import { contestRatingStatus, deriveContestAnalysis } from '../contests/contestAnalysis.ts';
import { refreshContestProblemSets } from '../contests/problemSetRefresh.ts';
import {
  kickBackgroundRefresh,
  loadParticipationSources,
  readParticipationSnapshot,
} from '../contests/participationSources.ts';
import type { Db } from '../db/index.ts';
import { throttledFetch } from '../net/hostThrottle.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

const MAX_ANALYSIS_TAG_LENGTH = 40;
type AnalysisTagIdentity = { contestKey: string; platform: PlatformId; problemKey: string; tag: string };

export function contestsRoutes(db: Db, fetchFn: typeof fetch = throttledFetch): Router {
  const r = Router();

  const addRatingStatus = (contests: ParticipatedContest[]) => contests.map(contest => ({
    ...contest,
    ratingStatus: contestRatingStatus(contest),
  }));

  const currentContestAnalysis = async (): Promise<ContestAnalysisResponse> => {
    const calendar = await calendarCache.load(db);
    const snapshot = readParticipationSnapshot(db);
    const contests = deriveParticipatedContests(db, { calendar, sources: snapshot.byPlatform });
    return { contests: deriveContestAnalysis(db, contests, { calendar, sources: snapshot.byPlatform }) };
  };

  const parseTagIdentity = (body: unknown): AnalysisTagIdentity | null => {
    if (!body || typeof body !== 'object') return null;
    const value = body as Record<string, unknown>;
    if (typeof value.contestKey !== 'string' || !/^[a-z]+:[\w.-]+$/.test(value.contestKey)) return null;
    if (typeof value.platform !== 'string' || !PLATFORMS.some(platform => platform.id === value.platform)) return null;
    if (typeof value.problemKey !== 'string' || !value.problemKey.trim() || value.problemKey.length > 200) return null;
    if (typeof value.tag !== 'string') return null;
    const tag = value.tag.trim();
    if (!tag || Array.from(tag).length > MAX_ANALYSIS_TAG_LENGTH) return null;
    return { contestKey: value.contestKey, platform: value.platform as PlatformId, problemKey: value.problemKey.trim(), tag };
  };

  const hasAnalysisProblem = (response: ContestAnalysisResponse, item: AnalysisTagIdentity) =>
    response.contests.some(contest => contest.contest.key === item.contestKey
      && contest.problems.some(problem => problem.platform === item.platform && problem.problemKey === item.problemKey));

  const readProblemTags = (item: AnalysisTagIdentity): string[] =>
    (db.prepare(`SELECT tag FROM contest_analysis_tags
      WHERE user_id = ? AND contest_key = ? AND platform = ? AND problem_key = ? ORDER BY tag COLLATE NOCASE`)
      .all(DEFAULT_USER_ID, item.contestKey, item.platform, item.problemKey) as Array<{ tag: string }>).map(row => row.tag);

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
      const { contests, failures } = await fetchAllContests(fetchFn, req.query.refresh === '1');
      res.json({
        ...browseContests(contests, {
          type,
          ...(platform !== undefined ? { platform: platform as PlatformId } : {}),
          limit: Number(req.query.limit) || 40,
          offset: Number(req.query.offset) || 0,
          query: typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : undefined,
          category: typeof req.query.category === 'string' ? req.query.category : undefined,
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
    // 日历走持久化缓存（SWR）：参赛记录落库了，日历也要落库 —— 否则重启后
    // 第一次请求要先等 5 个平台源的网络拉取，「读库秒出」名不副实。
    // 过期时立即用库内旧值并后台重拉（归因的是历史比赛，分钟级陈旧无影响）。
    const calendar = await calendarCache.load(db);
    const snapshot = readParticipationSnapshot(db);
    const hasStored = Object.keys(snapshot.byPlatform).length > 0;
    if (!hasStored && snapshot.stalePlatforms.length > 0) {
      // 首次使用（库内还没有任何参赛记录）：同步初始化（带单次上限），避免首次打开是空列表。
      // 先等日历后台重拉落幕再同步：同一时刻并发打洛谷会把 joinedContests 挤兑超时
      await calendarCache.settled();
      const sources = await loadParticipationSources(db, calendar, { fetchFn });
      const contests = deriveParticipatedContests(db, { calendar, sources: sources.byPlatform });
      res.json({
        contests: addRatingStatus(contests),
        sourceFailures: sources.failures,
        refreshing: refreshContestProblemSets(db, contests, fetchFn).platforms,
      });
      return;
    }
    let refreshing: PlatformId[] = [];
    if (snapshot.stalePlatforms.length > 0) {
      // kick 返回 false = 已有一轮后台刷新在跑：这批过期平台同样正在被刷新，
      // 必须照实回报——返回 refreshing=[] 会让前端撤掉「正在后台更新」提示，
      // 用户既看不到提示也不会自动拿到新数据（kick 内部有去重，不会叠加第二 burst）
      // after=settled()：参赛刷新排到日历后台重拉之后，洛谷桶内不再自己挤自己
      kickBackgroundRefresh(db, calendar, fetchFn, calendarCache.settled());
      refreshing = snapshot.stalePlatforms;
    }
    const contests = deriveParticipatedContests(db, { calendar, sources: snapshot.byPlatform });
    const problemSets = refreshContestProblemSets(db, contests, fetchFn);
    res.json({
      contests: addRatingStatus(contests),
      sourceFailures: snapshot.failures,
      refreshing: [...new Set([...refreshing, ...problemSets.platforms])],
    });
  }));

  // POST /api/contests/participated/refresh
  // 强制同步拉取参赛记录（无视 30 分钟间隔；增量游标生效——backlog 已完成的平台
  // 通常只拉第 1 页，被单次上限截断的平台继续向后补全），返回刷新后的完整列表。
  // 用户点「刷新」往往刚看到失败横幅：此刻日历后台重拉可能还在飞，先等它落幕，
  // 否则 joinedContests 又被挤兑超时，刷新按钮点了等于白点
  r.post('/participated/refresh', asyncHandler(async (_req, res) => {
    const calendar = await calendarCache.load(db);
    await calendarCache.settled();
    const sources = await loadParticipationSources(db, calendar, { force: true, fetchFn });
    const contests = deriveParticipatedContests(db, { calendar, sources: sources.byPlatform });
    res.json({
      contests: addRatingStatus(contests),
      sourceFailures: sources.failures,
      refreshing: refreshContestProblemSets(db, contests, fetchFn).platforms,
    });
  }));

  // GET /api/contests/analysis: isolated projection over reliably attributed submissions.
  r.get('/analysis', asyncHandler(async (_req, res) => {
    res.json(await currentContestAnalysis());
  }));

  // PUT /api/contests/analysis/tags: save a user-owned tag for one contest problem.
  r.put('/analysis/tags', asyncHandler(async (req, res) => {
    const item = parseTagIdentity(req.body);
    if (!item) return res.status(400).json({ error: `标签信息无效，标签长度需为 1-${MAX_ANALYSIS_TAG_LENGTH} 个字符。` });
    const analysis = await currentContestAnalysis();
    if (!hasAnalysisProblem(analysis, item)) return res.status(404).json({ error: '这道题不属于可可靠归属的参赛题单。' });
    db.prepare(`INSERT INTO contest_analysis_tags (user_id, contest_key, platform, problem_key, tag)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, contest_key, platform, problem_key, tag) DO NOTHING`)
      .run(DEFAULT_USER_ID, item.contestKey, item.platform, item.problemKey, item.tag);
    res.json({ tags: readProblemTags(item) });
  }));

  // DELETE /api/contests/analysis/tags: remove only the selected contest-scoped tag.
  r.delete('/analysis/tags', asyncHandler(async (req, res) => {
    const item = parseTagIdentity(req.body);
    if (!item) return res.status(400).json({ error: `标签信息无效，标签长度需为 1-${MAX_ANALYSIS_TAG_LENGTH} 个字符。` });
    db.prepare(`DELETE FROM contest_analysis_tags
      WHERE user_id = ? AND contest_key = ? AND platform = ? AND problem_key = ? AND tag = ?`)
      .run(DEFAULT_USER_ID, item.contestKey, item.platform, item.problemKey, item.tag);
    res.json({ tags: readProblemTags(item) });
  }));

  return r;
}

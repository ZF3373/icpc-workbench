import type { ParticipatedContest, PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { fetchContestProblemSet } from './participationSources.ts';
import { readContestProblemSet } from './problemSetCache.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

const PER_PLATFORM_BATCH = 6;
const RETRY_MS = 5 * 60_000;
interface Refresh {
  platforms: PlatformId[];
  settled: Promise<void>;
}
interface State {
  running?: Refresh;
  retryAt: Map<string, number>;
}
const states = new WeakMap<Db, State>();

/** 列表读取不等网络；每平台串行、有界补齐。后续轮询接着补，失败场次退避不阻塞其他场。 */
export function refreshContestProblemSets(
  db: Db,
  contests: ParticipatedContest[],
  fetchFn: typeof fetch = throttledFetch,
): Refresh {
  let state = states.get(db);
  if (!state) { state = { retryAt: new Map() }; states.set(db, state); }
  if (state.running) return state.running;
  const batches = new Map<PlatformId, ParticipatedContest[]>();
  const seen = new Set<string>();
  for (const contest of contests) {
    if (contest.platform !== 'codeforces' && contest.platform !== 'atcoder') continue;
    // AtCoder 旧题单可能被前缀过滤截断，即使已有题数也需补一次新版官方题单。
    if (contest.platform === 'codeforces' && (contest.totalProblemCount ?? contest.source?.problemCount ?? 0) > 0) continue;
    if (contest.endTimeIso && Date.parse(contest.endTimeIso) > Date.now()) continue;
    if (seen.has(contest.key) || (state.retryAt.get(contest.key) ?? 0) > Date.now()) continue;
    const cached = readContestProblemSet(db, contest.platform, contest.contestId);
    if (cached !== null) continue;
    seen.add(contest.key);
    const batch = batches.get(contest.platform) ?? [];
    if (batch.length >= PER_PLATFORM_BATCH) continue;
    batch.push(contest);
    batches.set(contest.platform, batch);
  }
  if (batches.size === 0) return { platforms: [], settled: Promise.resolve() };
  const current = state;
  const settled = Promise.resolve().then(async () => {
    await Promise.all([...batches.values()].map(async batch => {
      for (const contest of batch) {
        try {
          const result = await fetchContestProblemSet(db, contest.platform, contest.contestId, fetchFn);
          if (result.status === 'unavailable') current.retryAt.set(contest.key, Date.now() + RETRY_MS);
          else current.retryAt.delete(contest.key);
        } catch {
          current.retryAt.set(contest.key, Date.now() + RETRY_MS);
        }
      }
    }));
  }).finally(() => { current.running = undefined; });
  current.running = { platforms: [...batches.keys()], settled };
  return current.running;
}

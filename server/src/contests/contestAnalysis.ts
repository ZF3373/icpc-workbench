import type {
  ContestAnalysisContest,
  ContestAnalysisProblem,
  ContestRatingStatus,
  ContestInfo,
  ParticipatedContest,
} from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { resolveAllContestGroups } from './participated.ts';
import type { ParticipationSources } from './participationSources.ts';
import { readContestProblemSet } from './problemSetCache.ts';

const RELIABLE_EVIDENCE = new Set(['contest', 'virtual', 'joined-list', 'key-pattern', 'calendar-window']);

/** Null means the source has not confirmed either a rating change or its absence. */
export function contestRatingStatus(contest: ParticipatedContest): ContestRatingStatus {
  const change = contest.source?.ratingChange;
  if (change != null) return 'rated';
  // Codeforces explicitly marks a virtual run; it cannot change the user's rating.
  if (contest.platform === 'codeforces' && contest.evidence === 'virtual') return 'unrated';
  return 'pending';
}

function windowOf(contest: ParticipatedContest): { start: number; end: number } | null {
  if (contest.timeIsApproximate || !contest.startTimeIso || !contest.endTimeIso) return null;
  const start = Date.parse(contest.startTimeIso);
  const end = Date.parse(contest.endTimeIso);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function tagKey(contestKey: string, platform: string, problemKey: string): string {
  return JSON.stringify([contestKey, platform, problemKey]);
}

/**
 * Project only confidently attributed contests into the separate analysis view.
 * Codeforces context is authoritative for virtual runs and practice/upsolve rows;
 * other platforms require a complete, non-approximate contest window.
 */
export function deriveContestAnalysis(
  db: Db,
  contests: ParticipatedContest[],
  opts?: { calendar?: ContestInfo[]; sources?: ParticipationSources['byPlatform'] },
): ContestAnalysisContest[] {
  const storedTags = db.prepare(
    'SELECT contest_key AS contestKey, platform, problem_key AS problemKey, tag FROM contest_analysis_tags WHERE user_id = ?',
  ).all(DEFAULT_USER_ID) as Array<{ contestKey: string; platform: string; problemKey: string; tag: string }>;
  const tagsByProblem = new Map<string, string[]>();
  for (const row of storedTags) {
    const key = tagKey(row.contestKey, row.platform, row.problemKey);
    const tags = tagsByProblem.get(key);
    if (tags) tags.push(row.tag);
    else tagsByProblem.set(key, [row.tag]);
  }

  const out: ContestAnalysisContest[] = [];
  const reviewsByKey = new Map(resolveAllContestGroups(db, opts).map(review => [review.contest.key, review]));
  for (const contest of contests) {
    if (!RELIABLE_EVIDENCE.has(contest.evidence)) continue;
    const review = reviewsByKey.get(contest.key);
    if (!review) continue;
    const window = windowOf(contest);
    const hasExplicitCfContext = contest.platform === 'codeforces'
      && review.submissions.some(row => row.context === 'contest' || row.context === 'virtual');
    if (!window && !hasExplicitCfContext) continue;

    const refs = readContestProblemSet(db, contest.platform, contest.contestId);
    const allowedKeys = refs ? new Set(refs.map(ref => ref.id)) : null;
    const problems = new Map<string, Omit<ContestAnalysisProblem, 'tags'>>();
    const ensureProblem = (problemKey: string, title?: string | null, url?: string | null) => {
      if (allowedKeys && !allowedKeys.has(problemKey)) return null;
      let problem = problems.get(problemKey);
      if (!problem) {
        problem = {
          contestKey: contest.key,
          platform: contest.platform,
          problemKey,
          title: title?.trim() || problemKey,
          url: url ?? null,
          attemptCount: 0,
          postContestAttemptCount: 0,
          contestAccepted: false,
          postContestAccepted: false,
        };
        problems.set(problemKey, problem);
      } else {
        if (problem.title === problemKey && title?.trim()) problem.title = title.trim();
        if (!problem.url && url) problem.url = url;
      }
      return problem;
    };

    // The persisted set lists every problem, including problems not yet opened by the user.
    for (const ref of refs ?? review.unsubmittedProblems) ensureProblem(ref.id, ref.title);

    for (const row of review.submissions) {
      const problem = ensureProblem(row.problemKey, row.title, row.url);
      if (!problem) continue;
      const submittedAt = Date.parse(row.submittedAt);
      if (!Number.isFinite(submittedAt)) continue;

      let inContest = false;
      let afterContest = false;
      if (contest.platform === 'codeforces') {
        if (row.context === 'contest' || row.context === 'virtual') {
          inContest = true;
        } else if (row.context === 'practice') {
          afterContest = true;
        } else if (window) {
          // 老行兜底（context 为空）：CF 适配器曾读错 participantType 位置（2026-10 修复，
          // 见 adapters/codeforces.ts contextOf），历史行 context 全空——在语境回填完成前，
          // 有可信时间窗的场次退回与其他平台相同的时间窗判定，避免「已同步比赛在分析页
          // 全部显示未尝试」。时间窗口径与 buildContestIndex 的 calendar-window 证据一致。
          inContest = submittedAt >= window.start && submittedAt < window.end;
          afterContest = submittedAt >= window.end;
        }
      } else if (window) {
        inContest = submittedAt >= window.start && submittedAt < window.end;
        afterContest = submittedAt >= window.end;
      }

      if (inContest) {
        problem.attemptCount += 1;
        if (row.verdict === 'AC') problem.contestAccepted = true;
      } else if (afterContest) {
        problem.postContestAttemptCount += 1;
        if (row.verdict === 'AC') problem.postContestAccepted = true;
      }
    }

    const result = [...problems.values()]
      .sort((a, b) => a.problemKey.localeCompare(b.problemKey, undefined, { numeric: true }))
      .map(problem => ({ ...problem, tags: tagsByProblem.get(tagKey(contest.key, contest.platform, problem.problemKey)) ?? [] }));
    out.push({
      contest: { ...contest, ratingStatus: contestRatingStatus(contest) },
      ratingStatus: contestRatingStatus(contest),
      untaggedStuckCount: result.filter(problem => problem.attemptCount > 0 && !problem.contestAccepted && problem.tags.length === 0).length,
      problems: result,
    });
  }
  return out;
}

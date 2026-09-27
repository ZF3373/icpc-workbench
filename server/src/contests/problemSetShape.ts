import type { PlatformId } from '../../../shared/src/index.ts';

/**
 * 参赛记录里「题目集」的**归属校验**（纯函数，无 IO）。
 *
 * 背景（真实数据事故，2026-09-26）：`enrichProblems` 在同步每条平台参赛记录时
 * 无条件调用**牛客**题目集接口，于是数字型 contestId 的 Codeforces 场次
 * （2266 / 2244 / 2241 / 2231 / 2227 / 2218）把「牛客同号比赛」的题目集
 * 当成了自己的题目集写进库：CF 2241（Div.3）存进了 20 道牛客「小乐乐」系列题。
 * 后果不止显示「20 题」——「赛时未提交的题」会列出并不存在于该场的题，
 * 题面预取也会去抓这些题的题面，且集合被判定为"富题目集"后永不重拉（无法自愈）。
 *
 * 这里用一个便宜的、按平台键格式的校验兜住这一类串台：
 * - codeforces：题目 key = `${contestId}${index}`（如 2241A / 2241C1）
 * - atcoder：题目 key = `${contestId}_${suffix}`（如 abc454_a）
 * 其它平台（牛客/代码源/计蒜客/力扣/QOJ 等）的 id 没有可校验的前缀约定，
 * 一律视为合法——**宁可放过，也不误删**（它们的题目集本来就来自各自平台的接口）。
 */

/** 该平台题目 key 应有的前缀；无约定返回 null（= 不做校验） */
export function problemIdPrefix(platform: PlatformId, contestId: string): string | null {
  switch (platform) {
    case 'codeforces':
      return contestId;
    case 'atcoder':
      return `${contestId}_`;
    default:
      return null;
  }
}

/**
 * CF gym 判据：contestId 为纯数字且 ≥ 100000。
 * 与 CF API 的限制配套：只有 gym 允许 contest.standings 携带 from/count
 * （非 gym 带参数会被拒：HTTP 400）。
 */
export function isCfGymContestId(contestId: string): boolean {
  return /^\d+$/.test(contestId) && Number(contestId) >= 100000;
}

/**
 * 存储的题目集是否**确实属于**这场比赛（按 key 前缀判定）。
 * 空集视为不合法（调用方另行用三态区分「确认无题」）。
 */
export function problemSetMatchesContest(
  platform: PlatformId,
  contestId: string,
  refs: Array<{ id: string }> | null | undefined,
): boolean {
  if (!refs || refs.length === 0) return false;
  const prefix = problemIdPrefix(platform, contestId);
  if (prefix === null) return true; // 无约定 → 不校验
  return refs.every((r) => typeof r.id === 'string' && r.id.startsWith(prefix));
}

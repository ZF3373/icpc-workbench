import type { PlatformId } from '../../../shared/src/index.ts';

/**
 * VJudge OJ 字面量 → 应用内平台的映射。
 *
 * VJudge 的 `/status/data` 与 `/problem/{OJ}-{ID}` 用的是**它自己的** OJ 名称，
 * 与我们的 PlatformId 并不一一对应，且大小写混排（实测线上返回 `CodeForces`、
 * `Gym`、`SGU`、`CodeChef`、`HYSBZ` …）。键一律按小写比较。
 *
 * 只有**能映射回本应用已接入平台**的 OJ 才有意义：映射不了的（SPOJ / POJ / SGU …）
 * 说明这个平台的提交在我们这里没有对应题库，同步时只能跳过，否则会凭空造出一批
 * 永远补不上难度、也没有题面来源的「幽灵题目」。
 */
const OJ_PLATFORMS: Record<string, PlatformId> = {
  codeforces: 'codeforces',
  cf: 'codeforces',
  gym: 'codeforces', // Gym 题号即 CF 的 104821A 形态，与 CF 共用题库
  atcoder: 'atcoder',
  luogu: 'luogu',
  洛谷: 'luogu',
  nowcoder: 'nowcoder',
  牛客: 'nowcoder',
  qoj: 'qoj',
  leetcode: 'leetcode',
  力扣: 'leetcode',
  daimayuan: 'daimayuan',
  代码源: 'daimayuan',
  jisuanke: 'jisuanke',
  计蒜客: 'jisuanke',
  dashoj: 'dashoj',
};

/** VJudge OJ 字面量是否映射到本应用已接入的平台 */
export function vjudgeOjPlatform(oj: string | undefined | null): PlatformId | null {
  if (!oj) return null;
  return OJ_PLATFORMS[oj.trim().toLowerCase()] ?? null;
}

/**
 * 原 OJ 题号归一：与各平台适配器 / parseProblemList 保持同一口径，
 * 否则「VJudge 同步来的 AC」与「通过链接添加的复习项」会算成两道题（identity 不同）。
 * - Codeforces / Gym / 洛谷：大写（1234A / 104821A / P1001），洛谷远程题号 AT_ 保持小写
 * - AtCoder：小写（abc300_a）
 * - 其余：原样
 */
export function normalizeOjProblemKey(platform: PlatformId, rawId: string): string {
  const id = rawId.trim();
  switch (platform) {
    case 'codeforces':
      return id.toUpperCase();
    case 'luogu':
      return /^AT_/i.test(id) ? id.toLowerCase() : id.toUpperCase();
    case 'atcoder':
      return id.toLowerCase();
    default:
      return id;
  }
}

/**
 * 原 OJ 的题目页地址。VJudge 同步来的记录一律指回**原站**：
 * 存 VJudge 的转发链接会让「同一道题」在两个平台下各有一个 URL，
 * 而且 VJudge 的链接在部分 OJ 上还会 404（需要登录 VJudge 才转发）。
 */
export function ojProblemUrl(platform: PlatformId, problemKey: string): string | null {
  const key = encodeURIComponent(problemKey);
  switch (platform) {
    case 'codeforces': {
      // 104821A（gym）与 1234A（contest）分流，与 adapters/codeforces.ts 的 problemUrlFor 同口径
      const m = /^(\d+)([A-Za-z0-9]+)$/.exec(problemKey);
      if (!m) return `https://codeforces.com/problemset/problem/${key}`;
      const contestId = Number(m[1]);
      return contestId >= 100000
        ? `https://codeforces.com/gym/${m[1]}/problem/${m[2]}`
        : `https://codeforces.com/contest/${m[1]}/problem/${m[2]}`;
    }
    case 'atcoder':
      return `https://atcoder.jp/tasks/${key}`;
    case 'luogu':
      return `https://www.luogu.com.cn/problem/${key}`;
    case 'nowcoder':
      // 在线编程（社区）题用 practice: 前缀存 uuid，与牛客适配器同口径
      return problemKey.startsWith('practice:')
        ? `https://www.nowcoder.com/practice/${encodeURIComponent(problemKey.slice(9))}`
        : `https://ac.nowcoder.com/acm/problem/${key}`;
    case 'leetcode':
      return `https://leetcode.cn/problems/${key}/`;
    case 'qoj':
      return `https://qoj.ac/problem/${key}`;
    case 'daimayuan':
      return `https://bs.daimayuan.top/p/${key}`;
    case 'dashoj':
      return `https://oj.dashoj.com/problem/${key}`;
    case 'jisuanke': {
      // 比赛题键为 `{contestId}-{index}`，题库题为 T1001，与适配器同口径
      const m = /^(\d+)-(.+)$/.exec(problemKey);
      return m
        ? `https://www.jisuanke.com/contest/${m[1]}/problem/${m[2]}`
        : `https://www.jisuanke.com/problem/${key}`;
    }
    default:
      return null;
  }
}

/**
 * 一条 VJudge 记录 → 原 OJ 身份。映射不了返回 null（调用方跳过该行）。
 *
 * 为什么必须映射回原 OJ（而不是保留 `vjudge` 身份）：同步侧若落 `vjudge/洛谷-P1001`、
 * URL 导入侧落 `luogu/P1001`，同一个题在库里就是两行 —— 通过 VJudge 同步来的 AC
 * 在「通过链接添加」的同名复习条目上永远不显示，统计里也各算一次。
 */
export function vjudgeIdentity(
  oj: string | undefined | null,
  rawId: string | undefined | null,
): { platform: PlatformId; problemKey: string; url: string } | null {
  const platform = vjudgeOjPlatform(oj);
  if (!platform || !rawId) return null;
  const problemKey = normalizeOjProblemKey(platform, rawId);
  if (!problemKey) return null;
  const url = ojProblemUrl(platform, problemKey);
  if (!url) return null;
  return { platform, problemKey, url };
}

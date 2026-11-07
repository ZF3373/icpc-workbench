import type { PlatformId } from '../../../shared/src/index.ts';

/**
 * VJudge OJ 登记表：**"这个 OJ 本应用有没有"** 的唯一真源。
 *
 * VJudge 的 `/status/data` 与 `/problem/{OJ}-{题号}` 用的是**它自己的** OJ 名称，
 * 与我们的 PlatformId 不一一对应，且大小写混排（线上实测：`CodeForces`、`AtCoder`、
 * `洛谷`、`牛客`、`QOJ`、`计蒜客`、`代码源`，以及大量本应用没有的 `SPOJ` / `HDU` / `Toph` …）。
 *
 * 两类 OJ 的去重口径不同（这是本模块存在的理由）：
 * - **本应用已接入**（`platform` 有值）→ 映射回原 OJ 身份。保留 VJudge 身份会让同一道题
 *   在库里变成两行（同步落 `vjudge/洛谷-P1001`、URL 导入落 `luogu/P1001`），同步来的 AC
 *   在复习条目上永远不显示、统计里各算一次。
 * - **本应用没有**（`platform` 缺省）→ 用 VJudge 数据，落 `vjudge/{规范 OJ 字面量}-{题号}`。
 *   旧实现直接丢弃这些记录（注释理由是「避免幽灵题目」），代价是用户相当一部分 AC 永远
 *   进不了库（实测一次 status 采样里 HDU / SPOJ / Toph / CSES / EOlymp / UVA / CodeChef /
 *   LibreOJ / OpenJ_NOI 全被丢掉）。VJudge 是这些 OJ 唯一可用的数据源，丢弃不等于没有。
 *
 * 别名（`aliases`）承担**去重**：同一个 OJ 在 VJudge 上可能有多个字面量
 * （`LibreOJ` / `LOJ`；`UniversalOJ` / `UOJ`；`Aizu` / `AOJ`），按字面量原样落键会让
 * 同一道题在库里变成两三行。规范字面量取 VJudge 官方 OJ 列表里的写法，链接才对得上。
 *
 * 但**只登记有把握的同义**：`HYSBZ` / `黑暗爆炸` / `BZOJ` 在 VJudge 官方列表里是三个
 * 独立 OJ（分别指向 lydsy.com / darkbzoj.cc / new.bzoj.org），题号大概率同源却无法确认 ——
 * 猜错的代价是把两道不同的题静默算成一道，故各记各的（见下方登记表注释）。
 */
export interface VjudgeOjEntry {
  /** VJudge 上的规范字面量：落库键与链接都用它 */
  canonical: string;
  /** 本应用已接入的平台；缺省 = 本应用没有该题库，用 VJudge 数据 */
  platform?: PlatformId;
  /** 同一 OJ 的其他写法（大小写不敏感） */
  aliases?: readonly string[];
}

/**
 * 登记表。`canonical` 与 `aliases` 一律按小写比较（VJudge 实际大小写混排，
 * 实测同一个 OJ 在不同记录里都出现过 `CodeForces` / `codeforces`）。
 *
 * 本应用已接入的 7 个 OJ 在 VJudge 上真实出现的字面量：CodeForces / AtCoder / 洛谷 /
 * 牛客 / 计蒜客 / 代码源 / QOJ。`Gym` 是 VJudge 并不下发的简写（Gym 题在 status 里
 * 仍标 `CodeForces`，题号形态是 `104821A`），但用户从别处复制的链接里会出现，故留作别名。
 * `LeetCode` / `DashOJ` 同样不在 VJudge 的 OJ 列表里，保留映射只为让用户手写的链接
 * 也能落到本应用自己的平台（比落 vjudge 身份更可用）。
 */
const VJUDGE_OJS: readonly VjudgeOjEntry[] = [
  // ---------- 本应用已接入 ----------
  { canonical: 'CodeForces', platform: 'codeforces', aliases: ['codeforces', 'cf', 'gym'] },
  { canonical: 'AtCoder', platform: 'atcoder' },
  { canonical: '洛谷', platform: 'luogu', aliases: ['luogu'] },
  { canonical: '牛客', platform: 'nowcoder', aliases: ['nowcoder'] },
  { canonical: '计蒜客', platform: 'jisuanke', aliases: ['jisuanke', 'nanti'] },
  { canonical: '代码源', platform: 'daimayuan', aliases: ['daimayuan'] },
  { canonical: 'QOJ', platform: 'qoj', aliases: ['qoj.ac'] },
  // VJudge 列表里没有这两个，保留映射是为了让手写链接落到本应用自己的平台
  { canonical: 'LeetCode', platform: 'leetcode', aliases: ['leetcode', '力扣'] },
  { canonical: 'DashOJ', platform: 'dashoj', aliases: ['dashoj'] },

  // ---------- 本应用没有：用 VJudge 数据（canonical 取自 VJudge 官方 OJ 列表） ----------
  { canonical: 'POJ' },
  { canonical: 'ZOJ' },
  { canonical: 'UVALive', aliases: ['uvalive'] },
  { canonical: 'SGU' },
  { canonical: 'URAL', aliases: ['timus'] },
  { canonical: 'HUST' },
  { canonical: 'SPOJ' },
  { canonical: 'HDU' },
  // BZOJ 一系三个字面量在 VJudge 上是**三个独立 OJ**（官方列表里 HYSBZ / 黑暗爆炸 / BZOJ
  // 各占一项，指向 lydsy.com / darkbzoj.cc / new.bzoj.org）。三者题号大概率同源，但
  // 「大概率」不足以合并：题号一旦分叉，合并就是把两道不同的题算成一道，且是静默的。
  // 因此这里各记各的（只做大小写归并），宁可漏合并也不猜。
  { canonical: 'HYSBZ' },
  { canonical: '黑暗爆炸' },
  { canonical: 'BZOJ' },
  { canonical: 'UVA' },
  { canonical: 'Z-Trening' },
  // AOJ = Aizu Online Judge（VJudge 链接指向 judge.u-aizu.ac.jp）
  { canonical: 'Aizu', aliases: ['aoj'] },
  { canonical: 'LightOJ' },
  { canonical: 'UESTC' },
  { canonical: 'NBUT' },
  { canonical: 'FZU' },
  { canonical: 'CSU' },
  { canonical: 'SCU' },
  { canonical: 'ACdream' },
  { canonical: 'CodeChef' },
  { canonical: 'OpenJudge' },
  { canonical: 'Kattis' },
  { canonical: 'HihoCoder' },
  { canonical: 'HIT' },
  { canonical: 'HRBUST' },
  { canonical: 'EIJudge' },
  { canonical: 'HackerRank' },
  { canonical: '51Nod' },
  { canonical: 'TopCoder' },
  { canonical: 'EOlymp', aliases: ['e-olymp', 'eolymp'] },
  { canonical: 'LibreOJ', aliases: ['loj'] },
  { canonical: 'UniversalOJ', aliases: ['uoj'] },
  { canonical: 'CSG' },
  { canonical: 'DMOJ' },
  { canonical: 'Toph' },
  { canonical: 'Baekjoon', aliases: ['boj', 'acmicpc'] },
  { canonical: 'CSES' },
  { canonical: 'USACO' },
  { canonical: 'oj.uz' },
  { canonical: 'Yosupo' },
  { canonical: 'yukicoder' },
  { canonical: 'VNOJ' },
  { canonical: 'TLX' },
  { canonical: 'Kilonova' },
  { canonical: 'Szkopuł', aliases: ['szkopul'] },
  { canonical: 'CSAcademy' },
  { canonical: 'KRSU' },
  { canonical: 'ACMP' },
  // OpenJ_NOI 的题号本身带连字符（CH0106-02），必须走登记表匹配而不是按 '-' 切分
  { canonical: 'OpenJ_NOI' },
];

/** 小写字面量 → 登记项（canonical + aliases 都进表） */
const BY_LITERAL = new Map<string, VjudgeOjEntry>();
for (const entry of VJUDGE_OJS) {
  BY_LITERAL.set(entry.canonical.toLowerCase(), entry);
  for (const alias of entry.aliases ?? []) BY_LITERAL.set(alias.toLowerCase(), entry);
}

/**
 * 已知字面量按长度**降序**排列，用于「最长的已知前缀」匹配。
 *
 * 顺序即正确性：`UVALive-1234` 必须先命中 `uvalive` 再轮到 `uva`，
 * `Z-Trening-1000` / `OpenJ_NOI-CH0106-02` 里的连字符与下划线都只能靠整词前缀识别。
 */
const PREFIXES: ReadonlyArray<readonly [literal: string, entry: VjudgeOjEntry]> = [...BY_LITERAL.entries()]
  .sort((a, b) => b[0].length - a[0].length);

/** VJudge OJ 字面量 → 本应用已接入的平台；本应用没有该题库时返回 null */
export function vjudgeOjPlatform(oj: string | undefined | null): PlatformId | null {
  if (!oj) return null;
  return BY_LITERAL.get(oj.trim().toLowerCase())?.platform ?? null;
}

/**
 * VJudge OJ 字面量 → 规范字面量（别名归并）。
 * 登记表里没有的 OJ 返回 null（调用方按原样保留，不做猜测性改写）。
 */
export function canonicalVjudgeOj(oj: string | undefined | null): string | null {
  if (!oj) return null;
  return BY_LITERAL.get(oj.trim().toLowerCase())?.canonical ?? null;
}

/**
 * 拆解 VJudge 题目标识 `{OJ}-{题号}`（URL 路径段与历史库内键共用一份口径）。
 *
 * 不能简单按第一个 `-` 切分：
 * - OJ 字面量本身可能带连字符（`Z-Trening-1000`）；
 * - 题号也可能带连字符（`Toph-make-it-big`、`OpenJ_NOI-CH0106-02`）。
 * 因此先按**已知 OJ 字面量做最长前缀匹配**（覆盖所有真实 OJ），匹配不到才退化为
 * 「第一个 `-` 之前是 OJ」——未知 OJ 保留原样，宁可不合并也不猜错身份。
 */
export function splitVjudgeProblemSlug(
  slug: string | undefined | null,
): { oj: string; id: string } | null {
  const raw = String(slug ?? '').trim();
  if (raw === '') return null;
  const lower = raw.toLowerCase();
  for (const [literal, entry] of PREFIXES) {
    if (!lower.startsWith(`${literal}-`)) continue;
    const id = raw.slice(literal.length + 1).trim();
    return id === '' ? null : { oj: entry.canonical, id };
  }
  const dash = raw.indexOf('-');
  if (dash <= 0) return null;
  const id = raw.slice(dash + 1).trim();
  if (id === '') return null;
  return { oj: raw.slice(0, dash), id };
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
 * VJudge 转发链接：`vjudge.net/problem/{OJ}-{题号}`。
 * 只有**本应用没有的 OJ** 才用它当题目地址（有对应平台时一律指回原站，见 ojProblemUrl）。
 *
 * 与 adapters/vjudge.ts 的 problemUrl、parseProblemList 的链接还原共用，
 * 保证「同步落库的 url」「URL 导入落库的 url」「计划任务跳转」三处一致。
 */
export function vjudgeProblemUrl(problemKey: string): string {
  return `https://vjudge.net/problem/${encodeURIComponent(problemKey)}`;
}

/**
 * 一条 VJudge 记录 → 题目身份。**不再返回 null 丢弃记录**（只有 oj / 题号缺失才返回 null）：
 * - 本应用已接入的 OJ → 原 OJ 身份 + 原站链接（去重：与「通过链接添加」落到同一行）
 * - 本应用没有的 OJ → `vjudge/{规范 OJ}-{题号}` + VJudge 链接（用 VJudge 数据，不丢提交）
 *
 * 为什么必须映射回原 OJ（而不是全部保留 `vjudge` 身份）：同步侧若落 `vjudge/洛谷-P1001`、
 * URL 导入侧落 `luogu/P1001`，同一个题在库里就是两行 —— 通过 VJudge 同步来的 AC
 * 在「通过链接添加」的同名复习条目上永远不显示，统计里也各算一次。
 */
export function vjudgeIdentity(
  oj: string | undefined | null,
  rawId: string | undefined | null,
): { platform: PlatformId; problemKey: string; url: string } | null {
  const rawOj = String(oj ?? '').trim();
  const rawProblemId = String(rawId ?? '').trim();
  if (rawOj === '' || rawProblemId === '') return null;

  const platform = vjudgeOjPlatform(rawOj);
  if (platform) {
    const problemKey = normalizeOjProblemKey(platform, rawProblemId);
    const url = problemKey === '' ? null : ojProblemUrl(platform, problemKey);
    // 已接入平台但构造不出原站链接（理论上不会发生）：退回 vjudge 身份，不丢记录
    if (problemKey !== '' && url !== null) return { platform, problemKey, url };
  }

  // 别名归并到规范字面量：同一道题不能因为 VJudge 换了 OJ 写法就在库里多出一行
  const canonical = canonicalVjudgeOj(rawOj) ?? rawOj;
  const problemKey = `${canonical}-${rawProblemId}`;
  return { platform: 'vjudge', problemKey, url: vjudgeProblemUrl(problemKey) };
}

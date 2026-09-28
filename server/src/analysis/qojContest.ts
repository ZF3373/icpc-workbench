/**
 * QOJ 比赛页解析（题号字母 ↔ 题目 id 映射 + 比赛名称）。
 *
 * 为什么需要这一环：QOJ 题目难度只能由 ICPC/CCPC 公开榜单推导，而榜单是按**题号字母**
 * （A/B/C…）给统计的，所以「库内题号 → 该场比赛 → 题号字母」这一步必须先解决。
 * 本项目原先只用社区数据集 `xcpcrating` 的 `problem-catalog.json` 做这一步 —— 但那是
 * **评分数据集**，只覆盖它处理过的题（实测 1800 条 / 其中 qoj 题号 987 条）。库内实测
 * `2513-14301`（2025 ICPC 亚洲东区网络赛第一场 A 题）不在其中 → 链路第一环就断，
 * 无论榜单多全都补不上难度（旧行为：永远「公开榜单未匹配」）。
 *
 * 参考项目 OJ_Insight 的做法（`src-tauri/src/xcpc/sources/qoj.rs` 的 `parse_category`
 * /`fetch_contest_problems`）：直接读 QOJ 自己的比赛页。实测（2026-09-28，带已配置的
 * `cookie.qoj` + 浏览器 UA + HTTP/1.1）比赛页结构非常干净：
 *
 * ```html
 * <table class="table ...">
 *   <thead><tr><th style="width:5em">#</th><th>Problem</th></tr></thead>
 *   <tbody>
 *     <tr><td class="table-success">A</td><td><a href="/contest/2513/problem/14301">Who Can Win</a></td></tr>
 * ```
 *
 * 返回的是**纯解析结果**（无网络）：网络与缓存见 `analysis/icpcBoard.ts` 的 runtime。
 */
import type { PlatformId } from '../../../shared/src/index.ts';

export interface QojContestProblem {
  /** QOJ 题目 id（如 `14301`） */
  problemId: string;
  /** 场次内题号字母（如 `A`）；页面给不出时可依位置回退 A/B/C… */
  index: string;
  /** 题目名（页面链接文本） */
  title: string | null;
}

export interface QojContestPage {
  /** 比赛名称（`<title>` 去掉 QOJ 后缀；取不到为 null） */
  name: string | null;
  /** 该场比赛的题目（按页面顺序） */
  problems: QojContestProblem[];
}

/** `contestId-problemId` / 纯 `problemId` → 拆解（与 adapters/qoj.ts 的题号约定一致） */
export function qojProblemRefFromKey(problemKey: string): { contestId: string | null; problemId: string } | null {
  const key = String(problemKey).trim();
  const scoped = /^(\d+)-(\d+)$/.exec(key);
  if (scoped) return { contestId: scoped[1]!, problemId: scoped[2]! };
  return /^\d+$/.test(key) ? { contestId: null, problemId: key } : null;
}

/** 位置 → 题号字母（0→A、25→Z、26→AA，与 OJ_Insight `fallback_problem_index` 同口径） */
export function fallbackProblemIndex(position: number): string {
  let value = position + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

const strip = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 比赛页 → { 名称, 题目[] }。
 *
 * 解析要点（都来自实测页面，而不是猜测）：
 * - 题型行 = 同时含 `/contest/{id}/problem/{pid}` 链接的 `<tr>`；表头行没有这类链接，自然跳过；
 * - 题号字母取**该行的第一个 `<td>` 文本**，且必须形如 `A` / `AB` / `1`（实测为 `A`..`M`）；
 *   文本不像题号（例如某些模板把题目名放在第一格）时按**行序**回退 A/B/C… ——
 *   QOJ 的比赛页恒按题号顺序排列，位置回退与 OJ_Insight 的做法一致；
 * - 题目名取链接文本（`<a ...>Who Can Win</a>`）；
 * - 同一题号链接在一行里出现多次时按第一个计。
 */
export function parseQojContestPage(html: string): QojContestPage {
  const name = parseQojContestName(html);
  const problems: QojContestProblem[] = [];
  const seen = new Set<string>();
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const row = m[1]!;
    const link = /<a[^>]*href="([^"]*\/contest\/\d+\/problem\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const problemId = link[2]!;
    if (seen.has(problemId)) continue;
    seen.add(problemId);
    const position = problems.length;
    const firstCell = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(row)?.[1] ?? '';
    const cellText = strip(firstCell);
    const index = /^[A-Za-z]{1,2}\d{0,2}$|^\d{1,2}$/.test(cellText)
      ? cellText.toUpperCase()
      : fallbackProblemIndex(position);
    const title = strip(link[3]!);
    problems.push({ problemId, index, title: title === '' ? null : title });
  }
  return { name, problems };
}

/** `<title>` → 比赛名：去掉 QOJ 的标题后缀（` - Dashboard - Contest - QOJ.ac` 等） */
export function parseQojContestName(html: string): string | null {
  const raw = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (raw === undefined) return null;
  const name = raw
    .replace(/\s*[-–—]\s*(?:Dashboard|Problems|Contest|QOJ\.ac|QOJ)[\s\S]*$/i, '')
    .replace(/\s*[-–—]\s*QOJ\.ac\s*$/i, '')
    .trim();
  return name === '' ? null : name;
}

/** 该平台是否 QOJ（回填侧只对 QOJ 走比赛页这一步） */
export function isQojPlatform(platform: PlatformId | string): boolean {
  return platform === 'qoj';
}

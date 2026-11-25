import type { PlatformId } from '../../../shared/src/index.ts';

/**
 * 提交源码抽取（issue #69）。
 *
 * 各平台提交详情页里源码所在位置：
 * - Codeforces：pre#program-source-text（SSR，匿名可读）
 * - AtCoder：pre#submission-code（需登录看自己的提交）
 * - QOJ (UOJ)：提交页正文的 pre 里就是源码
 * - 洛谷：window._feInjection / window.__INITIAL_STATE__ 的 JSON 里带 code 字段
 * - Hydro 系（代码源 / DashOJ）：页面内嵌 JSON 里的 code 字段
 *
 * 抽取一律尽力而为：拿不到就返回 null（调用方给出可读原因）——
 * 猜出一段不是源码的 HTML 比取不到更糟。
 */

export interface ExtractedSource {
  source: string;
  language: string | null;
}

/** HTML 实体反解码（源码里的尖括号与 & 必然被转义） */
export function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 去掉 pre 内可能包裹的标签（语法高亮的 span），保留换行 */
function preToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

/**
 * 从内嵌 JSON 里抠出 code 字段。
 *
 * 不做整页 JSON.parse：页面的 script 往往还含 JS 表达式（不是纯 JSON），
 * 且体积可达数 MB。这里只找 "code": "..." 再按 JSON 字符串规则反转义，
 * 足够覆盖这两个平台的页面形态，也避免为大页面付解析成本。
 */
export function extractJsonStringField(html: string, field = 'code'): string | null {
  const re = new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 'm');
  const m = re.exec(html);
  if (!m) return null;
  const raw = m[1];
  if (raw === undefined) return null;
  try {
    return JSON.parse('"' + raw + '"') as string;
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/** 登录墙 / 挑战页特征：命中即判定拿不到源码，而不是把这段 HTML 当源码 */
const GATE_MARKERS = [
  'Sign In - AtCoder',
  'Please sign in',
  'Just a moment',
  'Enable JavaScript and cookies to continue',
  '没有查看权限',
  '登录后查看',
];

export function looksGated(html: string): boolean {
  return GATE_MARKERS.some((marker) => html.includes(marker));
}

/** 按平台抽取源码；抽取不到返回 null */
export function extractSourceFromHtml(platform: PlatformId, html: string): ExtractedSource | null {
  if (looksGated(html)) return null;

  if (platform === 'codeforces' || platform === 'atcoder' || platform === 'qoj') {
    // 三家都是 SSR：源码在唯一一个（带 id 的）pre 里
    const id = platform === 'codeforces' ? 'program-source-text' : platform === 'atcoder' ? 'submission-code' : null;
    const byId = id ? new RegExp('<pre[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</pre>', 'i').exec(html) : null;
    const body = byId?.[1] ?? (/<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html)?.[1] ?? null);
    if (body == null) return null;
    const source = preToText(body);
    return source.trim() === '' ? null : { source, language: null };
  }

  if (platform === 'luogu' || platform === 'dashoj' || platform === 'daimayuan') {
    const code = extractJsonStringField(html, 'code');
    if (code == null || code.trim() === '') return null;
    return { source: code, language: null };
  }

  return null;
}

/**
 * 各平台的最小请求间隔（毫秒）：源码是按需拉取（用户点名某次提交），
 * 但同一场复盘里可能连着点十几次，仍要有下限，避免把平台当成免费 API 刷。
 * 数值取各平台爬取礼仪的下限（AtCoder 官方要求 >= 1s）。
 */
export const SOURCE_FETCH_MIN_INTERVAL_MS: Partial<Record<PlatformId, number>> = {
  codeforces: 2000,
  atcoder: 1200,
  luogu: 1200,
  qoj: 2000,
  dashoj: 800,
  daimayuan: 800,
  vjudge: 1500,
  nowcoder: 1200,
};

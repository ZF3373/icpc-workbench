import type { PlatformId } from '../../../shared/src/index.ts';

/**
 * 题单文本解析（issue #4 题单整理）：用户从平台题单页复制的题目列表粘贴进来，
 * 逐行识别平台与题号。识别规则：
 * 1. URL 优先：洛谷 / CF / AtCoder / 代码源(Hydro) / 牛客的题目链接
 * 2. 常见题号写法：P1001（洛谷）、CF1234A / 1234A（Codeforces）、abc300_a（AtCoder）、
 *    #7 / 纯数字（代码源 Hydro 题库为纯数字 id，行内无其他平台线索时归属代码源）
 * 3. 标题 = 行内去掉题号/URL 后的剩余文本
 * 无法识别的行跳过（调用方按行号给出未识别提示）。
 */

export interface ParsedProblemLine {
  platform: PlatformId;
  problemKey: string;
  title?: string;
  url?: string;
  /** 原始行号（1 起），供导入结果反馈 */
  line: number;
}

interface UrlPattern {
  re: RegExp;
  platform: PlatformId;
  /** 从捕获组取题号；可选归一化 */
  key: (m: RegExpMatchArray) => string;
}

const URL_PATTERNS: UrlPattern[] = [
  {
    re: /luogu\.com\.cn\/problem\/([A-Za-z0-9_]+)/,
    platform: 'luogu',
    key: (m) => (/^AT_/i.test(m[1]) ? m[1].toLowerCase() : m[1].toUpperCase()), // 洛谷 AT_ 远程题号保持小写
  },
  {
    // contest 与 problemset 两种链接都要拼出规范键 1234A
    re: /codeforces\.com\/(?:contest\/(\d+)\/problem|problemset\/problem\/(\d+))\/([A-Za-z0-9]+)/,
    platform: 'codeforces',
    key: (m) => `${m[1] ?? m[2]}${m[3]}`.toUpperCase(),
  },
  { re: /atcoder\.jp\/contests\/[a-z0-9-]+\/tasks\/([a-z0-9_-]+)/, platform: 'atcoder', key: (m) => m[1].toLowerCase() },
  { re: /bs\.daimayuan\.top\/p\/(\d+)/, platform: 'daimayuan', key: (m) => m[1] },
  { re: /oj\.daimayuan\.top\/(?:problem|course\/\d+)\/(\d+)/, platform: 'daimayuan', key: (m) => m[1] },
  { re: /ac\.nowcoder\.com\/acm\/problem\/(\d+)/, platform: 'nowcoder', key: (m) => m[1] },
];

const CF_KEY_RE = /^(?:CF)?(\d{1,6}[A-Z][0-9]?)$/i;
const LUOGU_KEY_RE = /^(?:P|B|CF|AT|SP|U)\d{1,7}[A-Za-z]?$/;
/** 洛谷远程题号（AT_abc300_a / CF_1000A 等，带下划线前缀） */
const LUOGU_REMOTE_KEY_RE = /^(AT|CF|P|B|SP|U)_[A-Za-z0-9_]+$/;
const ATCODER_KEY_RE = /^(abc|arc|agc|apan[a-z]*)\d{3,4}_[a-z]\d?$/i;

/** 从一行文本识别平台题号（无 URL 时） */
function matchKeyToken(token: string): { platform: PlatformId; problemKey: string } | null {
  const cf = token.match(CF_KEY_RE);
  if (cf) return { platform: 'codeforces', problemKey: `${cf[1]}`.toUpperCase() };
  if (LUOGU_KEY_RE.test(token)) return { platform: 'luogu', problemKey: token.toUpperCase() };
  const remote = token.match(LUOGU_REMOTE_KEY_RE);
  if (remote) {
    // AT_ 前缀为洛谷对 AtCoder 远程题的写法（AT_ 保持大写，后半段小写）；其余前缀大写
    return {
      platform: 'luogu',
      problemKey: remote[1] === 'AT' ? `AT_${token.slice(3).toLowerCase()}` : token.toUpperCase(),
    };
  }
  if (ATCODER_KEY_RE.test(token)) return { platform: 'atcoder', problemKey: token.toLowerCase() };
  return null;
}

const NOISE_RE = /[|·•\-–—\[\](){}]+|\d+[.:、)]?$/g;

/** 清洗标题：去掉编号回显、行首序号、多余分隔符与空白 */
function cleanTitle(raw: string): string | undefined {
  const t = raw
    .replace(NOISE_RE, ' ')
    .replace(/^\s*\d+[.、)]\s*/, '') // 行首序号（"1. 两遍"）
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 2 ? t : undefined;
}

export function parseProblemListText(raw: string): ParsedProblemLine[] {
  const out: ParsedProblemLine[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let hit: { platform: PlatformId; problemKey: string; url?: string; rest: string } | null = null;

    for (const p of URL_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        // 还原带 scheme 的完整链接（题单粘贴时常带 https:// 前缀）
        const urlsInLine = [...line.matchAll(/https?:\/\/[^\s，,；;]+/g)].map((x) => x[0]);
        const url = urlsInLine.find((u) => u.includes(m[0])) ?? (m[0].startsWith('http') ? m[0] : `https://${m[0]}`);
        hit = { platform: p.platform, problemKey: p.key(m), url, rest: line.replace(m[0], ' ') };
        break;
      }
    }
    if (!hit) {
      // 逐 token 找题号（行首编号如 "1. P1001 两遍" 先剥掉序号）
      const tokens = line.replace(/^\d+[.、)]\s*/, '').split(/[\s,，;；\t|]+/).filter(Boolean);
      for (const token of tokens) {
        const m = matchKeyToken(token);
        if (m) {
          hit = { ...m, rest: line.replace(token, ' ') };
          break;
        }
      }
      // 行内只有一个纯数字（代码源题号习惯写法）且行较短 → 代码源
      if (!hit && tokens.length <= 3 && /^\d{1,6}$/.test(tokens[0] ?? '')) {
        hit = { platform: 'daimayuan', problemKey: tokens[0], rest: line.replace(tokens[0], ' ') };
      }
    }
    if (!hit) continue; // 未识别行跳过

    const key = `${hit.platform}:${hit.problemKey}`;
    if (seen.has(key)) continue; // 题单内去重
    seen.add(key);
    const title = cleanTitle(hit.rest);
    out.push({
      platform: hit.platform,
      problemKey: hit.problemKey,
      ...(title ? { title } : {}),
      ...(hit.url ? { url: hit.url } : {}),
      line: i + 1,
    });
  }
  return out;
}

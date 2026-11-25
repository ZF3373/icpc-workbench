import type { Db } from '../db/index.ts';
import { problemIdentity } from '../problems/identity.ts';

/**
 * 题目 / 比赛 的独立笔记（issue #71）。
 *
 * 与「复习笔记」（review_items.note）的区别在于**归属**：
 * - 复习笔记挂在复习条目上 —— 移出复习队列，笔记就跟着没了；
 * - 这里的笔记挂在**题目身份**与**比赛 key** 上，与复习队列彻底解耦：
 *   没 AC 的题、暂时不打算复习的题、整场比赛的选题/换题决策都能记，且永远找得回来。
 *
 * 「题目身份」用 problems/identity.ts 的同一份口径（洛谷 CF 镜像、AtCoder 下划线归一），
 * 否则同一道题从两个入口记笔记会落下两份。比赛 key 与赛事中心的 contest.key 一致
 * （形如 codeforces:1877），两者天然可跨实例迁移。
 */

/** 笔记正文上限：与复习笔记一致（20K 字符），避免一条 Markdown 撑爆前端编辑器 */
export const NOTE_MAX_LENGTH = 20_000;

export interface NoteRecord {
  text: string;
  updatedAt: string;
  createdAt: string;
}

const EMPTY: NoteRecord = { text: '', updatedAt: '', createdAt: '' };

/** 题目笔记的键：题目身份（platform:key，镜像归一后） */
export function problemNoteKey(platform: string, problemKey: string): string {
  return problemIdentity({ platform, problemKey });
}

/** 读一条题目笔记；没有记录时返回空正文（而不是 404 —— 「没写过」是常态，不是错误） */
export function readProblemNote(db: Db, userId: number, identity: string): NoteRecord {
  const row = db
    .prepare('SELECT text, created_at AS createdAt, updated_at AS updatedAt FROM problem_notes WHERE user_id = ? AND identity = ?')
    .get(userId, identity) as NoteRecord | undefined;
  return row ?? EMPTY;
}

/** 写一条题目笔记（空正文 = 删除该行：不留一条空记录占位，避免「有笔记」角标误报） */
export function writeProblemNote(db: Db, userId: number, identity: string, text: string): NoteRecord {
  if (text.trim() === '') {
    db.prepare('DELETE FROM problem_notes WHERE user_id = ? AND identity = ?').run(userId, identity);
    return EMPTY;
  }
  db.prepare(
    `INSERT INTO problem_notes (user_id, identity, text) VALUES (?, ?, ?)
       ON CONFLICT(user_id, identity) DO UPDATE SET text = excluded.text, updated_at = datetime('now')`,
  ).run(userId, identity, text);
  return readProblemNote(db, userId, identity);
}

export function readContestNote(db: Db, userId: number, contestKey: string): NoteRecord {
  const row = db
    .prepare('SELECT text, created_at AS createdAt, updated_at AS updatedAt FROM contest_notes WHERE user_id = ? AND contest_key = ?')
    .get(userId, contestKey) as NoteRecord | undefined;
  return row ?? EMPTY;
}

export function writeContestNote(db: Db, userId: number, contestKey: string, text: string): NoteRecord {
  if (text.trim() === '') {
    db.prepare('DELETE FROM contest_notes WHERE user_id = ? AND contest_key = ?').run(userId, contestKey);
    return EMPTY;
  }
  db.prepare(
    `INSERT INTO contest_notes (user_id, contest_key, text) VALUES (?, ?, ?)
       ON CONFLICT(user_id, contest_key) DO UPDATE SET text = excluded.text, updated_at = datetime('now')`,
  ).run(userId, contestKey, text);
  return readContestNote(db, userId, contestKey);
}

export interface ProblemNoteSummary {
  identity: string;
  /** 首行摘要（不含 Markdown 装饰）：列表页只显示一行，全文走查看卡片 */
  summary: string;
  updatedAt: string;
}

/**
 * 摘要：取首个非空行，剥掉行首 Markdown 装饰（与前端 noteView.noteSummary 同一口径）。
 *
 * 为什么服务端也要一份：MCP 的 list_problems / 题目列表接口要给出「这题有笔记」的信号，
 * 前端不该为此再拉一遍全文。两份实现的规则都很短，靠这条注释锁住口径一致；
 * 真正的格式渲染仍在客户端（Markdown），服务端只做「一行纯文本」。
 */
export function noteSummaryOf(text: string, max = 80): string {
  const raw = (text ?? '').trim();
  if (!raw) return '';
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  let line = firstLine.trim();
  line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图片]');
  line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  line = line.replace(/^\s{0,3}(#{1,6})\s+/, '');
  line = line.replace(/^\s{0,3}>\s?/, '');
  line = line.replace(/^\s{0,3}[-*+]\s+/, '');
  line = line.replace(/^\s{0,3}\d+[.)]\s+/, '');
  line = line.replace(/^\s{0,3}\[\s*x?\s*\]\s*/i, '');
  line = line.replace(/(\*\*|__|~~|==|`+)/g, '');
  line = line.replace(/\s+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}

/** 批量读题目笔记摘要（题目列表/写题历史的行角标用）：只查命中的键，不扫全表 */
export function problemNoteSummaries(db: Db, userId: number, identities: string[]): Map<string, ProblemNoteSummary> {
  const out = new Map<string, ProblemNoteSummary>();
  const unique = [...new Set(identities.filter((k) => k !== ''))];
  if (unique.length === 0) return out;
  // 分批 IN：SQLite 的变量上限（999）远大于一页 50 条，但接口也可能一次吃一屏的全量键
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT identity, text, updated_at AS updatedAt FROM problem_notes
          WHERE user_id = ? AND identity IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(userId, ...chunk) as Array<{ identity: string; text: string; updatedAt: string }>;
    for (const row of rows) {
      out.set(row.identity, { identity: row.identity, summary: noteSummaryOf(row.text), updatedAt: row.updatedAt });
    }
  }
  return out;
}

/** 比赛 key 形态校验（与 routes/contests.ts 的 parseTagIdentity 同一口径） */
export const CONTEST_KEY_RE = /^[a-z]+:[\w.-]+$/;

export function isValidContestKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && CONTEST_KEY_RE.test(value);
}

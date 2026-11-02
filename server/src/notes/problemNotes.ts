import type { Db } from '../db/index.ts';

/**
 * 题目笔记的写入口径（路由、打卡、复习联动共用）。
 *
 * 打卡的语义是「写下笔记才算完成」，因此打卡写入与笔记写入必须在同一事务里：
 * 只落一半要么是没有笔记的打卡，要么是用户以为没打上卡而重复提交。
 */
/** 单个文字/代码框的长度上限；框的数量不限，整条笔记只受请求体大小约束 */
export const MAX_NOTE_BLOCK_LENGTH = 100_000;
export const MAX_NOTE_LABELS = 5;
export const MAX_NOTE_LABEL_LENGTH = 20;

/** 笔记由任意数量、任意顺序的独立框组成 */
export type NoteBlock =
  | { type: 'markdown'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'image'; url: string; name: string; caption: string }
  | { type: 'attachment'; url: string; name: string; size: number };

export interface NoteInput {
  /** blocks 拼成的 Markdown */
  content: string;
  blocks: NoteBlock[];
  labels: string[];
}

/** 入参不合法（路由据此回 400，文案可直接展示给用户） */
export class NoteInputError extends Error {}

export function parseNoteLabels(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((l) => typeof l !== 'string')) {
    throw new NoteInputError('labels 需为字符串数组');
  }
  const labels = [...new Set((raw as string[]).map((l) => l.trim()).filter(Boolean))];
  if (labels.length > MAX_NOTE_LABELS) throw new NoteInputError(`标注最多 ${MAX_NOTE_LABELS} 个`);
  if (labels.some((l) => l.length > MAX_NOTE_LABEL_LENGTH)) {
    throw new NoteInputError(`单个标注最多 ${MAX_NOTE_LABEL_LENGTH} 字`);
  }
  return labels;
}

const IMAGE_URL = /^\/api\/uploads\/[A-Za-z0-9._-]+$/;
const ATTACHMENT_URL = /^\/api\/uploads\/files\/[a-z0-9]+-[a-f0-9]{12}\/[^/?#]+$/;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function checkLength(value: string): string {
  if (value.length > MAX_NOTE_BLOCK_LENGTH) throw new NoteInputError(`单个框最多 ${MAX_NOTE_BLOCK_LENGTH} 字`);
  return value;
}

/** 校验并规范化单个框；空框（没写内容、没传文件）返回 null，保存时直接略去 */
function parseBlock(raw: unknown): NoteBlock | null {
  const b = (raw ?? {}) as Record<string, unknown>;
  switch (b.type) {
    case 'markdown': {
      const value = checkLength(text(b.text));
      return value.trim() === '' ? null : { type: 'markdown', text: value };
    }
    case 'code': {
      const code = checkLength(text(b.code));
      if (code.trim() === '') return null;
      // 语言会写进代码围栏的信息串：只留标识符字符，防止破坏围栏结构
      const language = text(b.language).toLowerCase().replace(/[^a-z0-9+#-]/g, '').slice(0, 20);
      return { type: 'code', language, code };
    }
    case 'image': {
      const url = text(b.url);
      if (url === '') return null;
      // 只接受本站上传的文件：外部地址或 javascript: 不能借笔记进入页面
      if (!IMAGE_URL.test(url)) throw new NoteInputError('图片地址无效，请重新上传');
      return { type: 'image', url, name: text(b.name).slice(0, 200), caption: checkLength(text(b.caption)).slice(0, 500) };
    }
    case 'attachment': {
      const url = text(b.url);
      if (url === '') return null;
      if (!ATTACHMENT_URL.test(url)) throw new NoteInputError('附件地址无效，请重新上传');
      const size = Number(b.size);
      return {
        type: 'attachment',
        url,
        name: text(b.name).slice(0, 200) || '附件',
        size: Number.isFinite(size) && size > 0 ? size : 0,
      };
    }
    default:
      throw new NoteInputError('未知的笔记条目类型');
  }
}

const escapeLinkText = (s: string): string => s.replace(/[\\[\]]/g, '\\$&');

/** 把框拼成 Markdown：围栏比代码里最长的连续反引号再长一截，代码内容不会提前闭合围栏 */
export function blocksToMarkdown(blocks: readonly NoteBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'markdown':
          return b.text;
        case 'code': {
          const longest = Math.max(2, ...(b.code.match(/`+/g) ?? []).map((m) => m.length));
          const fence = '`'.repeat(longest + 1);
          return `${fence}${b.language}\n${b.code}\n${fence}`;
        }
        case 'image':
          return `![${escapeLinkText(b.caption || b.name)}](${b.url})`;
        case 'attachment':
          return `[${escapeLinkText(b.name)}](${b.url})`;
      }
    })
    .join('\n\n');
}

/** 解析笔记正文：blocks（条目结构）或 content（纯文本调用方：挂件、复习联动、MCP，视为一个 Markdown 框） */
export function parseNoteBody(body: { blocks?: unknown; content?: unknown }): { content: string; blocks: NoteBlock[] } {
  let raw: unknown[];
  if (body.blocks !== undefined) {
    if (!Array.isArray(body.blocks)) throw new NoteInputError('blocks 需为数组');
    raw = body.blocks;
  } else {
    raw = [{ type: 'markdown', text: body.content }];
  }
  const blocks = raw.map(parseBlock).filter((b): b is NoteBlock => b !== null);
  if (blocks.length === 0) throw new NoteInputError('笔记内容不能为空');
  return { content: blocksToMarkdown(blocks), blocks };
}

export function parseNoteInput(raw: unknown): NoteInput {
  const body = (raw ?? {}) as { blocks?: unknown; content?: unknown; labels?: unknown };
  return { ...parseNoteBody(body), labels: parseNoteLabels(body.labels) };
}

/** 读取已存的结构；旧笔记（blocks 为 NULL）整段视为一个 Markdown 框 */
export function readNoteBlocks(stored: string | null, content: string): NoteBlock[] {
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) return parsed as NoteBlock[];
    } catch {
      /* 结构损坏时退回 content，正文不至于读不出来 */
    }
  }
  return [{ type: 'markdown', text: content }];
}

/** 给任务写一条笔记；题目关联取任务当前的 problem_id（无题目的专题/模拟赛任务留空）。须在调用方事务内执行。 */
export function insertTaskNote(db: Db, userId: number, taskId: number, note: NoteInput): number {
  const result = db
    .prepare(
      `INSERT INTO problem_notes (user_id, problem_id, task_id, labels, content, blocks)
       VALUES (?, (SELECT problem_id FROM plan_tasks WHERE id = ?), ?, ?, ?, ?)`,
    )
    .run(userId, taskId, taskId, JSON.stringify(note.labels), note.content, JSON.stringify(note.blocks));
  return Number(result.lastInsertRowid);
}

/** 打卡并写入笔记。已打卡返回 false（不写笔记）；须在调用方事务内执行。 */
export function checkinWithNote(
  db: Db,
  userId: number,
  task: { id: number; task_date: string },
  note: NoteInput,
): boolean {
  const { changes } = db
    .prepare('INSERT OR IGNORE INTO checkins (user_id, task_id, task_date) VALUES (?, ?, ?)')
    .run(userId, task.id, task.task_date);
  if (Number(changes) === 0) return false;
  insertTaskNote(db, userId, task.id, note);
  return true;
}

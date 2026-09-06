import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from './index.ts';
import { upsertBankProblems } from '../import/bankService.ts';

/** 内置题库版本号在 settings 中的键 */
export const BUILTIN_BANK_VERSION_KEY = 'bank.builtin.version';

/**
 * 软件内置题库（server/src/data/bank-builtin.json，构建期生成）：
 * 开箱即有一批题目供训练计划/题单选题，无需先手动「拉取题库」。
 * - 常规运行：读磁盘文件
 * - SEA 单文件分发：由 sea.ts 把 JSON 作为 asset 注入（setBuiltinBankJson）
 * - 版本号记录在 settings；与文件不一致时整体 upsert 一次（幂等，
 *   保留用户已标难度），相同则跳过 → 日常启动零开销。
 */

interface BuiltinBankProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
}

interface BuiltinBankFile {
  version: string;
  problems: BuiltinBankProblem[];
}

let injectedJson: string | null = null;
let cache: { raw: string; bank: BuiltinBankFile | null } | null = null;

/** SEA 打包运行时注入；传 null 恢复磁盘读取（测试用） */
export function setBuiltinBankJson(json: string | null): void {
  injectedJson = json;
  cache = null;
}

function loadBuiltinBank(): BuiltinBankFile | null {
  const raw = injectedJson ?? readDiskFile();
  if (!raw) return null;
  if (cache?.raw === raw) return cache.bank;
  let bank: BuiltinBankFile | null = null;
  try {
    const parsed = JSON.parse(raw) as BuiltinBankFile;
    if (typeof parsed.version === 'string' && parsed.version !== '' && Array.isArray(parsed.problems)) {
      bank = parsed;
    }
  } catch {
    bank = null; // 文件损坏不阻断启动，仅视为无内置题库
  }
  cache = { raw, bank };
  return bank;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readDiskFile(): string | null {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'data', 'bank-builtin.json'), 'utf8');
  } catch {
    return null;
  }
}

/** 开机种子：内置题库版本变化时 upsert 入库并记录新版本号 */
export function seedBuiltinBank(db: Db): void {
  const bank = loadBuiltinBank();
  if (!bank || bank.problems.length === 0) return;
  const current = (
    db.prepare('SELECT value FROM settings WHERE key = ?').get(BUILTIN_BANK_VERSION_KEY) as
      | { value: string }
      | undefined
  )?.value;
  if (current === bank.version) return;
  upsertBankProblems(db, bank.problems);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(BUILTIN_BANK_VERSION_KEY, bank.version);
}

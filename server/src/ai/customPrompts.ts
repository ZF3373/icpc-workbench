import type { Db } from '../db/index.ts';
import type { AiCustomPrompt } from '../../../shared/src/index.ts';

export const CUSTOM_PROMPTS_KEY = 'ai.customPrompts';

export function readCustomPrompts(db: Db): AiCustomPrompt[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CUSTOM_PROMPTS_KEY) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as AiCustomPrompt[] : [];
}

export function appendCustomPrompts(system: string, prompts: AiCustomPrompt[]): string {
  if (!prompts.length) return system;
  return `${system}\n\n## 用户自定义追加提示词\n${prompts.map((p, i) => `### ${i + 1}. ${p.title}\n${p.content}`).join('\n\n')}`;
}

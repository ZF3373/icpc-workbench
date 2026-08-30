import { CURRICULUM, type TemplateItem } from './curriculum.ts';

/** 学习状态：未学 / 学习中 / 已掌握 */
export type TemplateStatus = 'todo' | 'learning' | 'mastered';

export const TEMPLATE_STATUSES: TemplateStatus[] = ['todo', 'learning', 'mastered'];

export function isTemplateId(id: string): boolean {
  return CURRICULUM.some((c) => c.templates.some((t) => t.id === id));
}

export function findTemplate(id: string): TemplateItem | undefined {
  for (const c of CURRICULUM) {
    const t = c.templates.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

export interface ProgressEntry {
  status: TemplateStatus;
  note: string | null;
}

/**
 * 「下一课」推荐：按课程大纲顺序（分类顺序 → 分类内顺序），
 * 优先返回第一个「学习中」的模板（学一半的优先收尾），否则返回第一个「未学」的。
 * 全部已掌握返回 null。
 */
export function nextTemplate(progress: Map<string, ProgressEntry>): TemplateItem | undefined {
  let firstTodo: TemplateItem | undefined;
  for (const cat of CURRICULUM) {
    for (const t of cat.templates) {
      const s = progress.get(t.id)?.status ?? 'todo';
      if (s === 'learning') return t;
      if (s === 'todo' && !firstTodo) firstTodo = t;
    }
  }
  return firstTodo;
}

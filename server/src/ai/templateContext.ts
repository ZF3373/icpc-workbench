import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { CURRICULUM } from '../templates/curriculum.ts';

/** 截取代码片段的前 N 行，供 AI 学习用户的代码风格（不全文注入以免撑大上下文） */
function codeSnippet(code: string, maxLines = 30): string {
  const lines = code.split('\n').slice(0, maxLines);
  if (lines.length < code.split('\n').length) lines.push('// ... (截断)');
  return lines.join('\n');
}

/**
 * 构建模板库摘要，注入 AI 助手系统提示词，让 AI 知道用户模板库中已有哪些模板。
 *
 * 内置模板来自 CURRICULUM 常量（114 条），用户写入的内容来自 template_progress 表；
 * 自定义模板来自 custom_templates 表。两者合并为紧凑的文本摘要。
 * 同时抽取少量已有代码片段，让 AI 后续输出代码时对齐用户已有风格。
 */
export function buildTemplateLibrarySummary(db: Db): string {
  // 用户对内置模板的学习进度 + 已写入内容
  const progressRows = db
    .prepare(
      `SELECT template_id, status, code, idea FROM template_progress WHERE user_id = ?`,
    )
    .all(DEFAULT_USER_ID) as Array<{
    template_id: string;
    status: string;
    code: string | null;
    idea: string | null;
  }>;
  const progress = new Map<string, { status: string; hasContent: boolean }>();
  for (const r of progressRows) {
    progress.set(r.template_id, {
      status: r.status,
      hasContent: !!r.code?.trim() || !!r.idea?.trim(),
    });
  }

  // 用户自定义模板
  const customRows = db
    .prepare(
      `SELECT category_key, name, difficulty, tags, code, idea FROM custom_templates WHERE user_id = ? ORDER BY category_key, id`,
    )
    .all(DEFAULT_USER_ID) as Array<{
    category_key: string;
    name: string;
    difficulty: number;
    tags: string;
    code: string;
    idea: string | null;
  }>;

  const lines: string[] = [];

  // 内置课程模板：按分类列出名称、难度、状态
  for (const cat of CURRICULUM) {
    const items: string[] = [];
    for (const t of cat.templates) {
      const p = progress.get(t.id);
      const statusTag = p?.status === 'mastered' ? '✓已掌握' : p?.status === 'learning' ? '学习中' : '';
      const contentTag = p?.hasContent ? '✏已有内容' : '';
      const tags = [statusTag, contentTag].filter(Boolean).join(' ');
      items.push(`  - ${t.name}（难度${t.difficulty}${tags ? `，${tags}` : ''}）`);
    }
    lines.push(`### ${cat.name}（${cat.key}）`);
    lines.push(items.join('\n'));
  }

  // 自定义模板
  if (customRows.length > 0) {
    lines.push('### 用户自定义模板');
    for (const r of customRows) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags) as string[];
      } catch {
        /* tags 格式异常跳过 */
      }
      const hasContent = !!r.code?.trim() || !!r.idea?.trim();
      const tagStr = tags.length ? `，标签：${tags.join('/')}` : '';
      const contentStr = hasContent ? '，已有内容' : '，空模板';
      lines.push(`  - [${r.category_key}] ${r.name}（难度${r.difficulty}${tagStr}${contentStr}）`);
    }
  }

  const mastered = [...progress.values()].filter((p) => p.status === 'mastered').length;
  const withContent = [...progress.values()].filter((p) => p.hasContent).length;

  // 抽取已有代码片段作为风格参考（内置 + 自定义各取最多 2 个，避免上下文过大）
  const styleSamples: string[] = [];
  for (const r of progressRows) {
    if (r.code?.trim() && styleSamples.length < 2) {
      const tpl = CURRICULUM.flatMap((c) => c.templates).find((t) => t.id === r.template_id);
      if (tpl) styleSamples.push(`【${tpl.name}】\n\`\`\`cpp\n${codeSnippet(r.code)}\n\`\`\``);
    }
  }
  for (const r of customRows) {
    if (r.code?.trim() && styleSamples.length < 4) {
      styleSamples.push(`【${r.name}】\n\`\`\`cpp\n${codeSnippet(r.code)}\n\`\`\``);
    }
  }

  const parts = [
    `内置模板 ${CURRICULUM.reduce((n, c) => n + c.templates.length, 0)} 个（已掌握 ${mastered}、已写入内容 ${withContent}），自定义模板 ${customRows.length} 个。`,
    '分类与模板列表：',
    lines.join('\n'),
  ];

  if (styleSamples.length > 0) {
    parts.push('\n用户已有模板代码风格参考（后续写入 template-add 的 code 字段请对齐此风格——命名习惯、宏定义、缩进、头文件、输入输出方式等）：');
    parts.push(styleSamples.join('\n\n'));
  }

  return parts.join('\n');
}

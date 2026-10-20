import { registerTool } from './tools/registry.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import { listTemplateCategoryOptions } from '../templates/categories.ts';

/**
 * read_template 工具：按模板 id 读取模板库中某个模板的完整内容。
 *
 * 背景：template-add 的 code 字段要求对齐用户已有代码风格，而带 templateId
 * 完善内置条目时前端走的是整体覆盖（PUT /api/templates/:id/content，旧
 * code/idea 直接被替换）。旧实现是在系统提示词里预抽 2-4 段 30 行代码片段
 * 当风格参考——每轮对话都被撑大，AI 看不到完整模板，完善条目时更可能把用户
 * 已写内容覆盖丢掉。现改为按需查询：AI 需要时自己调本工具读模板全文，
 * 仿照代码风格、在旧内容基础上增量完善，系统提示词不再预注入代码片段。
 *
 * 模板 id 的两个来源（系统提示词「用户模板库现有内容」摘要里都给了）：
 * - 内置课程条目：CURRICULUM 中的 id（如 ds-dsu）；
 * - 用户自定义模板：c-<数据库 id>（与模板库页 / template-add 的 id 同一命名空间）。
 */

/** 内置模板索引：id → 分类 + 模板元信息（CURRICULUM 是编译期常量，模块级建一次） */
const BUILTIN_INDEX = new Map(
  CURRICULUM.flatMap((c) => c.templates.map((t) => [t.id, { cat: c, t }] as const)),
);

interface ProgressRow {
  status: string;
  code: string | null;
  idea: string | null;
  complexity: string | null;
  url: string | null;
}

interface CustomRow {
  id: number;
  category_key: string;
  name: string;
  difficulty: number;
  tags: string;
  code: string;
  idea: string | null;
  complexity: string | null;
  url: string | null;
}

/** 读取一个模板的完整内容。返回错误文案（不抛错）或 JSON 详情，由 execute 包装。 */
function readTemplateDetail(db: Db, userId: number, templateId: string): { error: string } | { detail: Record<string, unknown> } {
  // ---------- 内置课程条目 ----------
  const builtin = BUILTIN_INDEX.get(templateId);
  if (builtin) {
    const p = db
      .prepare(
        'SELECT status, code, idea, complexity, url FROM template_progress WHERE user_id = ? AND template_id = ?',
      )
      .get(userId, templateId) as ProgressRow | undefined;
    const code = p?.code?.trim() ? p.code : null;
    const idea = p?.idea?.trim() ? p.idea : null;
    const hasContent = code !== null || idea !== null;
    return {
      detail: {
        templateId,
        source: 'builtin',
        name: builtin.t.name,
        categoryKey: builtin.cat.key,
        category: builtin.cat.name,
        difficulty: builtin.t.difficulty,
        tags: builtin.t.tags,
        status: p?.status ?? 'todo',
        outline: builtin.t.outline,
        examples: builtin.t.examples,
        code,
        idea,
        complexity: p?.complexity ?? null,
        url: p?.url ?? null,
        hasContent,
        note: hasContent
          ? '用户已写入以上内容。带 templateId 完善该条目时，必须在现有 code/idea 基础上增量补充完善（保留仍然有效的部分），不要凭空重写整体覆盖；输出 template-add 的 code 字段请对齐此条目已有代码风格。'
          : '该条目用户尚未写入内容（code/idea 为空），完善它时无旧内容需保留，可直接生成；代码风格请参考用户其他「✏已有内容」条目（可用本工具另查）。',
      },
    };
  }

  // ---------- 用户自定义模板：c-<数据库 id> ----------
  const m = /^c-(\d+)$/.exec(templateId);
  if (m) {
    const row = db
      .prepare(
        'SELECT id, category_key, name, difficulty, tags, code, idea, complexity, url FROM custom_templates WHERE id = ? AND user_id = ?',
      )
      .get(Number(m[1]), userId) as CustomRow | undefined;
    if (!row) return { error: `模板 ${templateId} 不存在（可能已被删除）。可对照系统提示词「用户模板库现有内容」摘要里的 id 重新确认。` };
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags) as string[];
    } catch {
      /* tags 格式异常按空处理 */
    }
    const category = listTemplateCategoryOptions(db).find((c) => c.key === row.category_key);
    const hasContent = !!row.code?.trim() || !!row.idea?.trim();
    return {
      detail: {
        templateId: `c-${row.id}`,
        source: 'custom',
        name: row.name,
        categoryKey: row.category_key,
        category: category?.name ?? row.category_key,
        difficulty: row.difficulty,
        tags,
        code: row.code || null,
        idea: row.idea || null,
        complexity: row.complexity ?? null,
        url: row.url ?? null,
        hasContent,
        note: hasContent
          ? '这是用户自定义模板。输出 template-add 的 code 字段时请对齐此条目已有代码风格；若要为同一算法补充内容，注意 template-add 不带 templateId 会新建条目而非更新它。'
          : '该自定义模板尚无实质内容（code/idea 为空）。',
      },
    };
  }

  return {
    error:
      `模板 ${templateId} 不存在。内置条目 id 见系统提示词「用户模板库现有内容」摘要（id=…），` +
      '自定义模板 id 形如 c-<数字>（摘要自定义模板条目已标注）；不要凭空编造 id。',
  };
}

registerTool({
  definition: { type: 'function', function: {
    name: 'read_template',
    description:
      '按模板 id 读取模板库中某个模板的完整内容（用户已写的 code/idea、学习状态、大纲要点、例题）。' +
      '两个用途：① 输出 template-add 前查看用户已有模板，对齐其代码风格（命名习惯、宏定义、缩进、头文件、输入输出方式），优先读「✏已有内容」的条目或与本次算法同类的条目；' +
      '② 通过 templateId 完善已有内置条目之前必须先调用本工具读出旧内容，在其基础上增量补充，避免整体覆盖丢失。' +
      'id 来源见系统提示词「用户模板库现有内容」摘要。本地查询，无需联网密钥。',
    parameters: { type: 'object', properties: {
      templateId: { type: 'string', description: '模板 id：内置课程条目如 ds-dsu，自定义模板如 c-3（摘要中均已标注）' },
    }, required: ['templateId'], additionalProperties: false },
  } },
  async execute(args, ctx) {
    if (!ctx.db) return { content: '模板库不可用：缺少本地数据库上下文。' };
    const templateId = typeof args.templateId === 'string' ? args.templateId.trim() : '';
    if (!templateId) return { content: '请提供 templateId（模板 id 见系统提示词「用户模板库现有内容」摘要）。' };
    const result = readTemplateDetail(ctx.db, ctx.userId ?? DEFAULT_USER_ID, templateId);
    if ('error' in result) return { content: result.error };
    return { content: JSON.stringify(result.detail) };
  },
});

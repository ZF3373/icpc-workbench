import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { CURRICULUM, TEMPLATE_TOTAL } from '../templates/curriculum.ts';
import {
  isTemplateId,
  nextTemplate,
  TEMPLATE_STATUSES,
  type ProgressEntry,
  type TemplateStatus,
} from '../templates/progress.ts';
import { upsertBankProblems } from '../import/bankService.ts';
import type { PlatformId } from '../../../shared/src/index.ts';

interface ProgressRow {
  template_id: string;
  status: string;
  note: string | null;
  code: string | null;
  idea: string | null;
  complexity: string | null;
  url: string | null;
}

interface ContentRow {
  code: string | null;
  idea: string | null;
  complexity: string | null;
  url: string | null;
}

const CONTENT_FIELDS = 'code, idea, complexity, url';

const readContent = (row: ProgressRow): ContentRow => ({
  code: row.code,
  idea: row.idea,
  complexity: row.complexity,
  url: row.url,
});

const emptyContent = (): ContentRow => ({ code: null, idea: null, complexity: null, url: null });

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

const loadProgress = (db: Db): Map<string, ProgressEntry> => {
  const rows = db
    .prepare(
      `SELECT template_id, status, note, ${CONTENT_FIELDS} FROM template_progress WHERE user_id = ?`,
    )
    .all(DEFAULT_USER_ID) as unknown as ProgressRow[];
  const map = new Map<string, ProgressEntry>();
  for (const row of rows) {
    map.set(row.template_id, {
      status: (TEMPLATE_STATUSES as string[]).includes(row.status)
        ? (row.status as TemplateStatus)
        : 'todo',
      note: row.note,
    });
  }
  return map;
};

const loadContent = (db: Db): Map<string, ContentRow> => {
  const rows = db
    .prepare(
      `SELECT template_id, ${CONTENT_FIELDS} FROM template_progress WHERE user_id = ? AND code IS NOT NULL`,
    )
    .all(DEFAULT_USER_ID) as unknown as Array<{ template_id: string } & ContentRow>;
  const map = new Map<string, ContentRow>();
  for (const row of rows) {
    map.set(row.template_id, readContent(row as ProgressRow));
  }
  return map;
};

/** 自建模板 id 命名空间：c-<dbId>，与内置课程 id 天然不冲突 */
const customId = (dbId: number): string => `c-${dbId}`;

/** 内置或本人自建模板均允许写进度 */
function assertTemplateExists(db: Db, id: string): boolean {
  if (isTemplateId(id)) return true;
  if (id.startsWith('c-')) {
    const dbId = Number(id.slice(2));
    if (Number.isInteger(dbId)) {
      const row = db
        .prepare('SELECT id FROM custom_templates WHERE id = ? AND user_id = ?')
        .get(dbId, DEFAULT_USER_ID);
      return !!row;
    }
  }
  return false;
}

/** 例题练习状态：是否已入库 problems、是否已 AC */
function loadExampleStatus(
  db: Db,
  pairs: Array<{ platform: PlatformId; key: string }>,
): Map<string, { inBank: boolean; ac: boolean }> {
  const byPlatform = new Map<PlatformId, string[]>();
  for (const { platform, key } of pairs) {
    const keys = byPlatform.get(platform) ?? [];
    keys.push(key);
    byPlatform.set(platform, keys);
  }
  const map = new Map<string, { inBank: boolean; ac: boolean }>();
  const sql = (placeholders: string) => `
    SELECT p.problem_key AS key,
           COUNT(s.id) AS attempts,
           COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac
      FROM problems p
      LEFT JOIN submissions s ON s.problem_id = p.id AND s.user_id = ?
     WHERE p.platform = ? AND p.problem_key IN (${placeholders})
     GROUP BY p.problem_key`;
  for (const [platform, keys] of byPlatform) {
    const placeholders = keys.map(() => '?').join(',');
    const rows = db
      .prepare(sql(placeholders))
      .all(DEFAULT_USER_ID, platform, ...keys) as unknown as Array<{
      key: string;
      attempts: number;
      ac: number;
    }>;
    for (const row of rows) {
      map.set(`${platform}:${row.key}`, { inBank: true, ac: row.ac > 0 });
    }
  }
  return map;
}

const safeTags = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 12) : [];
  } catch {
    return [];
  }
};

/** 内置模板课程 + 自建模板 + 个人学习进度 + 例题练习状态 */
export function templatesRoutes(db: Db): Router {
  const r = Router();

  // GET /api/templates → 课程大纲全量（合并自建模板，含个人进度、用户写入内容、例题状态）+ 统计 + 下一课
  r.get('/', (_req, res) => {
    const progress = loadProgress(db);
    const contentMap = loadContent(db);
    const custom = db
      .prepare('SELECT * FROM custom_templates WHERE user_id = ? ORDER BY id')
      .all(DEFAULT_USER_ID) as unknown as CustomRow[];

    // 收集全部内置例题 (platform, key) 做一次性状态查询
    const examplePairs: Array<{ platform: PlatformId; key: string }> = [];
    for (const cat of CURRICULUM)
      for (const t of cat.templates)
        for (const ex of t.examples) examplePairs.push({ platform: ex.platform, key: ex.key });
    const exampleStatus = loadExampleStatus(db, examplePairs);

    const customByCategory = new Map<string, CustomRow[]>();
    for (const row of custom) {
      const list = customByCategory.get(row.category_key) ?? [];
      list.push(row);
      customByCategory.set(row.category_key, list);
    }

    const categories = CURRICULUM.map((cat) => ({
      key: cat.key,
      name: cat.name,
      description: cat.description,
      templates: [
        ...cat.templates.map((t) => ({
          custom: false,
          ...t,
          examples: t.examples.map((ex) => ({
            ...ex,
            ...(exampleStatus.get(`${ex.platform}:${ex.key}`) ?? { inBank: false, ac: false }),
          })),
          status: progress.get(t.id)?.status ?? 'todo',
          note: progress.get(t.id)?.note ?? null,
          content: contentMap.get(t.id) ?? null,
        })),
        ...(customByCategory.get(cat.key) ?? []).map((row) => ({
          custom: true,
          id: customId(row.id),
          name: row.name,
          difficulty: Math.min(5, Math.max(1, row.difficulty)),
          tags: safeTags(row.tags),
          code: row.code,
          idea: row.idea ?? '',
          complexity: row.complexity ?? '',
          useCases: '',
          pitfalls: '',
          url: row.url,
          examples: [] as never[],
          status: progress.get(customId(row.id))?.status ?? 'todo',
          note: progress.get(customId(row.id))?.note ?? null,
          content: null,
        })),
      ],
    }));

    let mastered = 0;
    let learning = 0;
    for (const entry of progress.values()) {
      if (entry.status === 'mastered') mastered++;
      else if (entry.status === 'learning') learning++;
    }
    const next = nextTemplate(progress);
    res.json({
      total: TEMPLATE_TOTAL,
      mastered,
      learning,
      customCount: custom.length,
      next: next ? { id: next.id, name: next.name, difficulty: next.difficulty } : null,
      categories,
    });
  });

  // GET /api/templates/next → 下一课推荐
  r.get('/next', (_req, res) => {
    const next = nextTemplate(loadProgress(db));
    if (!next) return res.json({ next: null });
    const cat = CURRICULUM.find((c) => c.templates.some((t) => t.id === next.id));
    res.json({
      next: {
        id: next.id,
        name: next.name,
        category: cat?.name ?? '',
        categoryKey: cat?.key ?? '',
        difficulty: next.difficulty,
      },
    });
  });

  // ---------- 自建模板 CRUD ----------

  const validateCustomBody = (body: Record<string, unknown>) => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) return { error: 'name 必填且不超过 100 字' };
    const categoryKey = body.categoryKey;
    if (typeof categoryKey !== 'string' || !CURRICULUM.some((c) => c.key === categoryKey)) {
      return { error: 'categoryKey 需为课程分类之一' };
    }
    const difficulty = Number(body.difficulty);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
      return { error: 'difficulty 需为 1-5 整数' };
    }
    const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean).slice(0, 12) : [];
    const code = typeof body.code === 'string' ? body.code : '';
    if (code.length > 20000) return { error: 'code 过长（> 20000 字符）' };
    const idea = typeof body.idea === 'string' ? body.idea.slice(0, 5000) : '';
    const complexity = typeof body.complexity === 'string' ? body.complexity.slice(0, 200) : '';
    const url = typeof body.url === 'string' && body.url.trim() !== '' ? body.url.trim() : null;
    return { name, categoryKey, difficulty, tags, code, idea, complexity, url };
  };

  // POST /api/templates/custom  body: { categoryKey, name, difficulty, tags[], code, idea?, complexity?, url? }
  r.post('/custom', (req, res) => {
    const v = validateCustomBody(req.body ?? {});
    if ('error' in v) return res.status(400).json({ error: v.error });
    const result = db
      .prepare(
        `INSERT INTO custom_templates (user_id, category_key, name, difficulty, tags, code, idea, complexity, url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        DEFAULT_USER_ID,
        v.categoryKey,
        v.name,
        v.difficulty,
        JSON.stringify(v.tags),
        v.code,
        v.idea || null,
        v.complexity || null,
        v.url,
      );
    res.json({ ok: true, id: customId(Number(result.lastInsertRowid)) });
  });

  // PATCH /api/templates/custom/:id → 编辑自建模板（字段部分更新）
  r.patch('/custom/:id', (req, res) => {
    const dbId = Number(req.params.id);
    if (!Number.isInteger(dbId)) return res.status(400).json({ error: 'id 非法' });
    const existing = db
      .prepare('SELECT id FROM custom_templates WHERE id = ? AND user_id = ?')
      .get(dbId, DEFAULT_USER_ID);
    if (!existing) return res.status(404).json({ error: '自建模板不存在' });
    const v = validateCustomBody(req.body ?? {});
    if ('error' in v) return res.status(400).json({ error: v.error });
    db.prepare(
      `UPDATE custom_templates
          SET category_key = ?, name = ?, difficulty = ?, tags = ?, code = ?, idea = ?, complexity = ?, url = ?,
              updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`,
    ).run(
      v.categoryKey,
      v.name,
      v.difficulty,
      JSON.stringify(v.tags),
      v.code,
      v.idea || null,
      v.complexity || null,
      v.url,
      dbId,
      DEFAULT_USER_ID,
    );
    res.json({ ok: true });
  });

  // DELETE /api/templates/custom/:id → 删除自建模板（学习进度一并清理）
  r.delete('/custom/:id', (req, res) => {
    const dbId = Number(req.params.id);
    if (!Number.isInteger(dbId)) return res.status(400).json({ error: 'id 非法' });
    const result = db
      .prepare('DELETE FROM custom_templates WHERE id = ? AND user_id = ?')
      .run(dbId, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: '自建模板不存在' });
    db.prepare('DELETE FROM template_progress WHERE template_id = ? AND user_id = ?').run(
      customId(dbId),
      DEFAULT_USER_ID,
    );
    res.json({ ok: true });
  });

  // ---------- 例题练习 ----------

  // POST /api/templates/examples/collect
  // body: { platform, key, title, url?, tags? } → 例题一键入库题目管理（不产生提交，不污染统计）
  r.post('/examples/collect', (req, res) => {
    const { platform, key, title, url, tags } = req.body ?? {};
    if (typeof platform !== 'string' || !['codeforces', 'atcoder', 'luogu', 'nowcoder'].includes(platform)) {
      return res.status(400).json({ error: 'platform 非法' });
    }
    if (typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'key 必填' });
    }
    const result = upsertBankProblems(db, [
      {
        platform: platform as PlatformId,
        problemKey: key.trim(),
        title: typeof title === 'string' && title ? title : key.trim(),
        difficulty: null, // 例题难度由回填/同步补全，模板侧不臆测
        url: typeof url === 'string' && url ? url : null,
        tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
      },
    ]);
    res.json({ ok: true, ...(result[0] ?? { inserted: 0, updated: 0 }) });
  });

  // ---------- 学习进度 ----------

  // PUT /api/templates/:id/content  body: { code?, idea?, complexity?, url? }
  // 用户为自己写的大纲条目填充模板内容（自建模板走 PATCH /custom/:id）
  r.put('/:id/content', (req, res) => {
    const id = req.params.id;
    if (!isTemplateId(id)) return res.status(404).json({ error: `课程中不存在模板 ${id}` });
    const body = req.body ?? {};
    const code = typeof body.code === 'string' ? body.code : '';
    if (code.length > 20000) return res.status(400).json({ error: 'code 过长（> 20000 字符）' });
    const idea = typeof body.idea === 'string' ? body.idea.slice(0, 5000) : '';
    const complexity = typeof body.complexity === 'string' ? body.complexity.slice(0, 200) : '';
    const url = typeof body.url === 'string' && body.url.trim() !== '' ? body.url.trim().slice(0, 500) : null;
    const hasContent = code.trim() !== '' || idea.trim() !== '';
    db.prepare(
      `INSERT INTO template_progress (template_id, user_id, status, code, idea, complexity, url, updated_at)
       VALUES (?, ?, 'todo', ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, template_id)
       DO UPDATE SET code = excluded.code, idea = excluded.idea, complexity = excluded.complexity,
                     url = excluded.url, updated_at = datetime('now')`,
    ).run(id, DEFAULT_USER_ID, code || null, idea || null, complexity || null, url);
    res.json({ ok: true, hasContent });
  });

  // POST /api/templates/:id/status  body: { status: 'todo'|'learning'|'mastered' }
  r.post('/:id/status', (req, res) => {
    const { status } = req.body ?? {};
    if (!TEMPLATE_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status 需为 'todo' | 'learning' | 'mastered'" });
    }
    const id = req.params.id;
    if (!assertTemplateExists(db, id)) return res.status(404).json({ error: `课程中不存在模板 ${id}` });
    db.prepare(
      `INSERT INTO template_progress (template_id, user_id, status, mastered_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, template_id)
       DO UPDATE SET status = excluded.status,
                     mastered_at = excluded.mastered_at,
                     updated_at = datetime('now')`,
    ).run(id, DEFAULT_USER_ID, status, status === 'mastered' ? new Date().toISOString() : null);
    res.json({ ok: true });
  });

  // PATCH /api/templates/:id/note  body: { note }
  r.patch('/:id/note', (req, res) => {
    const note = req.body?.note;
    if (typeof note !== 'string') return res.status(400).json({ error: 'note 需为字符串' });
    const id = req.params.id;
    if (!assertTemplateExists(db, id)) return res.status(404).json({ error: `课程中不存在模板 ${id}` });
    db.prepare(
      `INSERT INTO template_progress (template_id, user_id, status, note) VALUES (?, ?, 'todo', ?)
       ON CONFLICT (user_id, template_id)
       DO UPDATE SET note = excluded.note, updated_at = datetime('now')`,
    ).run(id, DEFAULT_USER_ID, note.trim() === '' ? null : note);
    res.json({ ok: true });
  });

  // 未知子路径统一提示
  r.use((_req, res) => res.status(404).json({ error: '未知模板接口' }));
  return r;
}

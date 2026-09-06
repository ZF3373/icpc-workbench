import { Router } from 'express';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { AiProvider } from '../ai/provider.ts';
import { canonicalTag, TAG_ALIAS_TO_CANONICAL, type PlatformId } from '../../../shared/src/index.ts';
import { getAdapter } from '../adapters/registry.ts';
import { parseProblemListText } from '../problems/parseProblemList.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { buildPracticeSummary, renderSummaryForPrompt } from '../analysis/summary.ts';
import { effectiveAbility } from '../today/ability.ts';
import { renderTemplate } from '../plans/planService.ts';

/** 分类体系：与掌握度地图同一套知识点归并（canonical tag）+ 兜底「其他」 */
const TAXONOMY: string[] = [
  ...new Set([...Object.values(TAG_ALIAS_TO_CANONICAL), '搜索', '模拟', '构造', '交互', '其他']),
].sort();

/** 从题库 tags 推断知识点分类：取第一个可归并的 tag 的规范名 */
function classifyByTags(tagsJson: string | null | undefined): string | null {
  if (!tagsJson) return null;
  let tags: string[] = [];
  try {
    tags = JSON.parse(tagsJson) as string[];
  } catch {
    return null;
  }
  const canonical = tags.map(canonicalTag).find((t) => TAXONOMY.includes(t));
  return canonical ?? null;
}

/** 解析 AI 回复中的 JSON（围栏/前后解释文字/尾逗号容错，同 planService 思路） */
function extractAiJson(raw: string): unknown {
  let text = raw.trim();
  if (text.includes('```')) text = text.replace(/```[a-zA-Z-]*\s*/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
  }
}

export function listsRoutes(
  db: Db,
  getAiConfig: () => AiConfig,
  opts: { createProvider?: () => Pick<AiProvider, 'chat' | 'enabled'> } = {},
): Router {
  const r = Router();

  // GET /api/lists → 题单列表（含题数/分类数）
  r.get('/', (_req, res) => {
    const lists = db
      .prepare(
        `SELECT l.id, l.title, l.source_url, l.created_at,
                (SELECT COUNT(*) FROM problem_list_items i WHERE i.list_id = l.id) AS item_count,
                (SELECT COUNT(DISTINCT i.category) FROM problem_list_items i WHERE i.list_id = l.id) AS category_count,
                (SELECT COUNT(*) FROM problem_list_items i
                  JOIN problems p ON p.platform = i.platform AND p.problem_key = i.problem_key
                  JOIN submissions s ON s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC'
                  WHERE i.list_id = l.id) AS solved_count
           FROM problem_lists l
          WHERE l.user_id = ?
          ORDER BY l.created_at DESC, l.id DESC`,
      )
      .all(DEFAULT_USER_ID, DEFAULT_USER_ID);
    res.json(lists);
  });

  // POST /api/lists  body: { title, raw, sourceUrl? } → 解析粘贴文本并入库（入库即按题库 tags 分类）
  r.post('/', (req, res) => {
    const { title, raw, sourceUrl } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title 必填' });
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ error: 'raw 必填：粘贴平台题单的题目列表文本' });
    }
    const parsed = parseProblemListText(raw);
    if (parsed.length === 0) {
      return res.status(400).json({ error: '未解析到任何题目：请确认每行包含题号或题目链接' });
    }
    const ins = db.prepare(
      `INSERT INTO problem_lists (user_id, title, source_url) VALUES (?, ?, ?)`,
    );
    const insItem = db.prepare(
      `INSERT INTO problem_list_items (list_id, platform, problem_key, title, url, category, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      db.exec('BEGIN');
      const listId = Number(ins.run(DEFAULT_USER_ID, title.trim(), typeof sourceUrl === 'string' && sourceUrl.trim() ? sourceUrl.trim() : null).lastInsertRowid);
      for (let pos = 0; pos < parsed.length; pos += 1) {
        const it = parsed[pos];
        // 题库信息回填：标题/难度/标签分类/链接兜底
        const p = db
          .prepare('SELECT title, url, tags, difficulty FROM problems WHERE platform = ? AND problem_key = ?')
          .get(it.platform, it.problemKey) as
          | { title: string; url: string | null; tags: string; difficulty: number | null }
          | undefined;
        const finalUrl = it.url ?? p?.url ?? getAdapter(it.platform)?.problemUrl({ problemKey: it.problemKey }) ?? null;
        const category = classifyByTags(p?.tags) ?? '未分类';
        insItem.run(listId, it.platform, it.problemKey, it.title ?? p?.title ?? null, finalUrl, category, pos);
      }
      db.exec('COMMIT');
      const totalLines = raw.split(/\r?\n/).filter((l) => l.trim()).length;
      return res.json({
        ok: true,
        id: listId,
        imported: parsed.length,
        unrecognized: Math.max(0, totalLines - parsed.length),
      });
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: `导入失败：${(e as Error).message}` });
    }
  });

  // GET /api/lists/:id → 题单详情（含题目难度/标签/已 AC 状态）
  r.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const list = db
      .prepare('SELECT id, title, source_url, created_at FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as Record<string, unknown> | undefined;
    if (!list) return res.status(404).json({ error: '题单不存在' });
    const items = db
      .prepare(
        `SELECT i.id, i.platform, i.problem_key, i.title, i.url, i.category, i.position,
                p.difficulty, p.tags,
                EXISTS (SELECT 1 FROM submissions s
                         JOIN problems p2 ON p2.id = s.problem_id
                        WHERE s.user_id = ? AND s.verdict = 'AC'
                          AND p2.platform = i.platform AND p2.problem_key = i.problem_key) AS solved
           FROM problem_list_items i
           LEFT JOIN problems p ON p.platform = i.platform AND p.problem_key = i.problem_key
          WHERE i.list_id = ?
          ORDER BY i.position, i.id`,
      )
      .all(DEFAULT_USER_ID, id) as Array<Record<string, unknown> & { tags: string | null }>;
    res.json({
      ...list,
      items: items.map(({ tags, ...it }) => ({
        ...it,
        solved: Number(it.solved) === 1,
        tags: tags ? (JSON.parse(tags) as string[]) : [],
      })),
    });
  });

  // PATCH /api/lists/items/:itemId  body: { category } → 手动改分类
  r.patch('/items/:itemId', (req, res) => {
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'itemId 非法' });
    const { category } = req.body ?? {};
    if (typeof category !== 'string' || !category.trim() || category.trim().length > 20) {
      return res.status(400).json({ error: 'category 必填（≤20 字）' });
    }
    const result = db
      .prepare(
        `UPDATE problem_list_items SET category = ?
          WHERE id = ? AND list_id IN (SELECT id FROM problem_lists WHERE user_id = ?)`,
      )
      .run(category.trim(), itemId, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: '条目不存在' });
    res.json({ ok: true });
  });

  // DELETE /api/lists/items/:itemId
  r.delete('/items/:itemId', (req, res) => {
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'itemId 非法' });
    const result = db
      .prepare(
        `DELETE FROM problem_list_items
          WHERE id = ? AND list_id IN (SELECT id FROM problem_lists WHERE user_id = ?)`,
      )
      .run(itemId, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: '条目不存在' });
    res.json({ ok: true });
  });

  // DELETE /api/lists/:id → 删除题单（条目级联）
  r.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    const result = db
      .prepare('DELETE FROM problem_lists WHERE id = ? AND user_id = ?')
      .run(id, DEFAULT_USER_ID);
    if (result.changes === 0) return res.status(404).json({ error: '题单不存在' });
    res.json({ ok: true });
  });

  // POST /api/lists/:id/classify → 按题库 tags 规则分类（幂等，无 AI）
  r.post('/:id/classify', (req, res) => {
    const id = Number(req.params.id);
    const list = db
      .prepare('SELECT id FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID);
    if (!list) return res.status(404).json({ error: '题单不存在' });
    const items = db
      .prepare('SELECT id, platform, problem_key, category FROM problem_list_items WHERE list_id = ?')
      .all(id) as Array<{ id: number; platform: PlatformId; problem_key: string; category: string }>;
    const upd = db.prepare('UPDATE problem_list_items SET category = ? WHERE id = ?');
    let updated = 0;
    for (const it of items) {
      const p = db
        .prepare('SELECT tags FROM problems WHERE platform = ? AND problem_key = ?')
        .get(it.platform, it.problem_key) as { tags: string } | undefined;
      const category = classifyByTags(p?.tags) ?? '其他';
      if (category !== it.category) {
        upd.run(category, it.id);
        updated += 1;
      }
    }
    res.json({ ok: true, updated, total: items.length });
  });

  // POST /api/lists/:id/ai-classify → AI 分类（题库 tags 覆盖不到的题目）
  r.post('/:id/ai-classify', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const list = db
      .prepare('SELECT id, title FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as { id: number; title: string } | undefined;
    if (!list) return res.status(404).json({ error: '题单不存在' });
    const provider = opts.createProvider?.() ?? new AiProvider(getAiConfig());
    if (!provider.enabled) {
      return res.status(400).json({ error: 'AI 未配置：请先到「设置 → AI 配置」填写接口', needConfig: true });
    }
    const items = db
      .prepare('SELECT id, platform, problem_key, title, category FROM problem_list_items WHERE list_id = ? ORDER BY position')
      .all(id) as Array<{ id: number; platform: string; problem_key: string; title: string | null; category: string }>;
    if (items.length === 0) return res.status(400).json({ error: '题单为空' });
    const lines = items
      .map((it, i) => `${i}. [${it.platform}/${it.problem_key}] ${it.title ?? ''}（当前：${it.category}）`)
      .join('\n');
    const raw = await provider.chat([
      { role: 'system', content: '你是算法竞赛教练，只输出严格 JSON，不加任何解释。' },
      {
        role: 'user',
        content: `下面是题单「${list.title}」的题目列表。请给每道题归入一个知识点分类，分类只能从给定目录中选择（拿不准归"其他"）。\n\n分类目录：${TAXONOMY.join('、')}\n\n题目列表：\n${lines}\n\n只输出 JSON 数组，格式：[{"i": 0, "category": "二分"}, ...]，i 为题目的序号，每道题都必须出现一次。`,
      },
    ]);
    let arr: Array<{ i?: unknown; category?: unknown }>;
    try {
      arr = extractAiJson(raw) as Array<{ i?: unknown; category?: unknown }>;
    } catch (e) {
      return res.status(502).json({ error: `AI 输出解析失败：${(e as Error).message}` });
    }
    if (!Array.isArray(arr)) return res.status(502).json({ error: 'AI 输出不是 JSON 数组' });
    const upd = db.prepare('UPDATE problem_list_items SET category = ? WHERE id = ?');
    let updated = 0;
    const allowed = new Set(TAXONOMY);
    for (const entry of arr) {
      const idx = Number(entry?.i);
      const category = typeof entry?.category === 'string' ? entry.category.trim() : '';
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
      if (!category || !allowed.has(category)) continue;
      if (category !== items[idx].category) {
        upd.run(category, items[idx].id);
        updated += 1;
      }
    }
    res.json({ ok: true, updated, total: items.length });
  }));

  // POST /api/lists/:id/ai-suggest → AI 读取题单内容给练习建议（返回 markdown，不落库）
  r.post('/:id/ai-suggest', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const list = db
      .prepare('SELECT id, title, source_url FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as { id: number; title: string; source_url: string | null } | undefined;
    if (!list) return res.status(404).json({ error: '题单不存在' });
    const provider = opts.createProvider?.() ?? new AiProvider(getAiConfig());
    if (!provider.enabled) {
      return res.status(400).json({ error: 'AI 未配置：请先到「设置 → AI 配置」填写接口', needConfig: true });
    }
    const items = db
      .prepare(
        `SELECT i.platform, i.problem_key, i.title, i.category, p.difficulty,
                EXISTS (SELECT 1 FROM submissions s
                         JOIN problems p2 ON p2.id = s.problem_id
                        WHERE s.user_id = ? AND s.verdict = 'AC'
                          AND p2.platform = i.platform AND p2.problem_key = i.problem_key) AS solved
           FROM problem_list_items i
           LEFT JOIN problems p ON p.platform = i.platform AND p.problem_key = i.problem_key
          WHERE i.list_id = ? ORDER BY i.position`,
      )
      .all(DEFAULT_USER_ID, id) as Array<{ platform: string; problem_key: string; title: string | null; category: string; difficulty: number | null; solved: number }>;
    const lines = items
      .map((it) => `- [${it.category}] ${it.platform}/${it.problem_key}《${it.title ?? ''}》${it.difficulty ? `难度${it.difficulty}` : ''}${it.solved ? '（已AC）' : ''}`)
      .join('\n');
    const weakness = computeWeakness(db, DEFAULT_USER_ID, { minAttempts: 5, topN: 8 });
    const summaryPrompt = renderSummaryForPrompt(buildPracticeSummary(db, DEFAULT_USER_ID));
    const ability = effectiveAbility(db, DEFAULT_USER_ID);
    const prompt = renderTemplate(
      '你是 ICPC 备赛教练。用户导入了一份题单「{title}」{source}，请结合用户数据给出练习建议：\n\n' +
        '## 用户练习数据汇总\n{summary}\n\n## 用户弱项画像（JSON）\n{weakness}\n\n## 当前估算能力值\n{level}\n\n## 题单内容\n{items}\n\n' +
        '要求（简体中文 markdown）：1) 优先做哪些题、为什么（结合弱项与难度）；2) 哪些题可以先跳过/后置及原因；3) 按建议顺序给出练习路线（分组列出）；4) 指出题单未覆盖的弱项知识点。控制在 400 字内，直接给结论。',
      {
        title: list.title,
        source: list.source_url ? `（来源：${list.source_url}）` : '',
        summary: summaryPrompt,
        weakness: JSON.stringify(weakness.items),
        level: `${ability.effective}（计算值 ${ability.computed}${ability.override ? '，AI 已调整' : ''}）`,
        items: lines || '（空题单）',
      },
    );
    try {
      const reply = await provider.chat([{ role: 'user', content: prompt }]);
      res.json({ reply });
    } catch (e) {
      res.status(502).json({ error: `AI 调用失败：${(e as Error).message}` });
    }
  }));

  return r;
}

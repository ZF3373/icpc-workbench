import { Router } from 'express';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { AiProvider } from '../ai/provider.ts';
import { canonicalTag, coarseCategoryNames, TAG_ALIAS_TO_CANONICAL, type PlatformId } from '../../../shared/src/index.ts';
import { getAdapter } from '../adapters/registry.ts';
import { parseProblemListText } from '../problems/parseProblemList.ts';
import { classifyTitle } from '../knowledge/ruleEngine.ts';
import { nameOfCode } from '../knowledge/taxonomy.ts';
import { getConfidenceThreshold, READABLE_SOURCES_SQL } from '../knowledge/store.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { buildPracticeSummary, renderSummaryForPrompt } from '../analysis/summary.ts';
import { effectiveAbility } from '../today/ability.ts';
import { renderTemplate } from '../plans/planService.ts';

/**
 * 分类体系：与掌握度地图同一套知识点归并（canonical tag = taxonomy 名）+ 粗粒度兜底。
 * 注意：对象值即规范名（taxonomy 名），例如「二分查找」而非课程里的短名「二分」——
 * 旧实现用别名映射表的**目标词**当目录，词表一改就会静默换一套分类，故改为直接取规范名。
 */
const TAXONOMY: string[] = [
  ...new Set([...Object.values(TAG_ALIAS_TO_CANONICAL), ...coarseCategoryNames(), '其他']),
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

interface ProblemLookup {
  /** 解析后的平台/题号（镜像题回退到原生平台，知识点标注按此身份查询） */
  platform: string;
  problemKey: string;
  tags: string | null;
  title: string | null;
  url: string | null;
  difficulty: number | null;
}

/**
 * 镜像题回退的规则说明（判定顺序见 candidateIdentities）。
 * 洛谷题单常含 CF / AtCoder 镜像题（key 形如 CF351E / at_agc018_c），这些题在洛谷库
 * 大多不存在，但同一道题以原生 key（351E / agc018_c）存于 codeforces / atcoder 库——
 * 按前缀回退到镜像源平台再查一次，否则规则分类永远查不到 tags 而全部落到「其他」。
 *
 * 分类口径（见 classifyItemsBatch）：已标注题直接用标注（最高置信）；未标注走 L1 标题
 * 规则即时标注；仍无结果回退题库 tags 归并（老行为）。null 表示无法分类（保留现有分类）。
 */

/**
 * 一题的候选题库身份（按序尝试）：自身 → 洛谷镜像题回退到原生平台。
 * 与 lookupProblemTags 的判定顺序完全一致，供批量版本复用。
 */
function candidateIdentities(platform: string, problemKey: string): Array<[string, string]> {
  const out: Array<[string, string]> = [[platform, problemKey]];
  // 洛谷 CF 镜像（CF351E / CF958E2 → codeforces/351E / 958E2；后缀模式同 parseProblemList 的 CF_KEY_RE）
  if (platform === 'luogu' && /^CF\d{1,6}[A-Z][0-9]?$/.test(problemKey)) {
    out.push(['codeforces', problemKey.slice(2)]);
  }
  // 洛谷 AtCoder 镜像（at_agc018_c / AT_agc018_c → atcoder/agc018_c）
  if (platform === 'luogu' && /^at_/i.test(problemKey)) {
    out.push(['atcoder', problemKey.slice(3).toLowerCase()]);
  }
  return out;
}

/** 批量分组查询的 IN 占位符 */
function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * 批量版 lookupProblemTags + classifyByKnowledge。
 *
 * 原实现逐题查题库、再逐题查标注与分类，导入/重分类 N 题就是 2N 次往返（P1-3 N+1）。
 * 这里把 ①题库信息 ②知识点标注 各压成**一次** IN 分组查询，再在内存里按原判定顺序
 * 做镜像回退与分类，语义与单题版本逐字对齐。
 */
function classifyItemsBatch(
  db: Db,
  items: Array<{ platform: string; problemKey: string }>,
): Array<{ lookup: ProblemLookup | undefined; category: string | null }> {
  const empty = items.map(() => ({ lookup: undefined as ProblemLookup | undefined, category: null as string | null }));
  if (items.length === 0) return empty;

  const identities = items.map((it) => candidateIdentities(it.platform, it.problemKey));

  // ① 题库信息：一次查询取回全部候选身份
  const byIdentity = new Map<string, Omit<ProblemLookup, 'platform' | 'problemKey'>>();
  const allPlatforms = [...new Set(identities.flat().map(([pf]) => pf))];
  const allKeys = [...new Set(identities.flat().map(([, k]) => k))];
  if (allPlatforms.length > 0 && allKeys.length > 0) {
    const rows = db
      .prepare(
        `SELECT platform, problem_key, tags, title, url, difficulty FROM problems
          WHERE platform IN (${placeholders(allPlatforms.length)})
            AND problem_key IN (${placeholders(allKeys.length)})`,
      )
      .all(...allPlatforms, ...allKeys) as Array<{
      platform: string;
      problem_key: string;
      tags: string | null;
      title: string | null;
      url: string | null;
      difficulty: number | null;
    }>;
    for (const row of rows) {
      byIdentity.set(`${row.platform}\u0000${row.problem_key}`, {
        tags: row.tags,
        title: row.title,
        url: row.url,
        difficulty: row.difficulty,
      });
    }
  }

  // ② 标注：一次查询取回全部候选身份的最高置信标注（与 ORDER BY confidence DESC LIMIT 1 等价）
  const kpByKey = new Map<string, string>();
  if (allPlatforms.length > 0 && allKeys.length > 0) {
    const threshold = getConfidenceThreshold(db);
    const kpRows = db
      .prepare(
        `SELECT platform, problem_key, name FROM (
            SELECT platform, problem_key, name,
                   ROW_NUMBER() OVER (PARTITION BY platform, problem_key ORDER BY confidence DESC) AS rn
              FROM problem_keypoints
             WHERE confidence >= ?
               AND ${READABLE_SOURCES_SQL}
               AND platform IN (${placeholders(allPlatforms.length)})
               AND problem_key IN (${placeholders(allKeys.length)})
          ) WHERE rn = 1`,
      )
      .all(threshold, ...allPlatforms, ...allKeys) as Array<{
      platform: string;
      problem_key: string;
      name: string;
    }>;
    for (const row of kpRows) kpByKey.set(`${row.platform}\u0000${row.problem_key}`, row.name);
  }

  return items.map((_it, i) => {
    let lookup: ProblemLookup | undefined;
    for (const [pf, key] of identities[i]) {
      const info = byIdentity.get(`${pf}\u0000${key}`);
      if (info) {
        lookup = { platform: pf, problemKey: key, ...info };
        break;
      }
    }
    if (!lookup) return { lookup, category: null };
    const kp = kpByKey.get(`${lookup.platform}\u0000${lookup.problemKey}`);
    if (kp !== undefined) return { lookup, category: kp };
    if (lookup.title) {
      const hits = classifyTitle(lookup.title);
      if (hits.length > 0) return { lookup, category: nameOfCode(hits[0].code) };
    }
    return { lookup, category: classifyByTags(lookup.tags) };
  });
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
                (SELECT COUNT(DISTINCT i.id) FROM problem_list_items i
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
      // 题库信息与知识点分类一次性批量取回（原为逐题 2 次查询，题单大会明显卡顿）
      const classified = classifyItemsBatch(
        db,
        parsed.map((it) => ({ platform: it.platform, problemKey: it.problemKey })),
      );
      for (let pos = 0; pos < parsed.length; pos += 1) {
        const it = parsed[pos];
        // 题库信息回填：标题/难度/标签分类/链接兜底（含 CF/AtCoder 镜像题回退查询）
        const p = classified[pos].lookup;
        const finalUrl = it.url ?? p?.url ?? getAdapter(it.platform)?.problemUrl({ problemKey: it.problemKey }) ?? null;
        const category = classified[pos].category ?? '未分类';
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

  // POST /api/lists/:id/items  body: { raw } → 向已有题单追加题目（解析与分类规则和导入一致）
  // 题单已有的题按「候选身份」（含洛谷 CF/AtCoder 镜像回退）去重跳过——同一道题换个平台
  // 粘贴不算新题；position 接在现有条目之后，不影响已有顺序与分类。
  r.post('/:id/items', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    const raw = req.body?.raw;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ error: 'raw 必填：粘贴题目列表文本（每行一题）' });
    }
    const list = db
      .prepare('SELECT id FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID);
    if (!list) return res.status(404).json({ error: '题单不存在' });
    const parsed = parseProblemListText(raw);
    if (parsed.length === 0) {
      return res.status(400).json({ error: '未解析到任何题目：请确认每行包含题号或题目链接' });
    }
    const identitySet = (platform: string, key: string) =>
      new Set(candidateIdentities(platform, key).map(([pf, k]) => `${pf}\u0000${k}`));
    const intersects = (a: Set<string>, b: Set<string>): boolean => {
      for (const x of a) if (b.has(x)) return true;
      return false;
    };
    const existing = db
      .prepare('SELECT platform, problem_key FROM problem_list_items WHERE list_id = ?')
      .all(id) as Array<{ platform: string; problem_key: string }>;
    const seen = existing.map((it) => identitySet(it.platform, it.problem_key));
    const fresh: typeof parsed = [];
    let duplicates = 0;
    for (const it of parsed) {
      const ids = identitySet(it.platform, it.problemKey);
      if (seen.some((s) => intersects(ids, s))) {
        duplicates += 1;
        continue;
      }
      seen.push(ids); // 批内镜像重复（如同时粘贴洛谷镜像链接与原生题号）同样只保留一个
      fresh.push(it);
    }
    if (fresh.length > 0) {
      const insItem = db.prepare(
        `INSERT INTO problem_list_items (list_id, platform, problem_key, title, url, category, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        db.exec('BEGIN');
        const maxPos = (
          db
            .prepare('SELECT COALESCE(MAX(position), -1) AS maxPos FROM problem_list_items WHERE list_id = ?')
            .get(id) as { maxPos: number }
        ).maxPos;
        const classified = classifyItemsBatch(
          db,
          fresh.map((it) => ({ platform: it.platform, problemKey: it.problemKey })),
        );
        for (let i = 0; i < fresh.length; i += 1) {
          const it = fresh[i]!;
          const p = classified[i]!.lookup;
          const finalUrl = it.url ?? p?.url ?? getAdapter(it.platform)?.problemUrl({ problemKey: it.problemKey }) ?? null;
          const category = classified[i]!.category ?? '未分类';
          insItem.run(id, it.platform, it.problemKey, it.title ?? p?.title ?? null, finalUrl, category, maxPos + 1 + i);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        return res.status(400).json({ error: `追加失败：${(e as Error).message}` });
      }
    }
    const totalLines = raw.split(/\r?\n/).filter((l) => l.trim()).length;
    return res.json({
      ok: true,
      added: fresh.length,
      duplicates,
      unrecognized: Math.max(0, totalLines - parsed.length),
    });
  });

  // GET /api/lists/:id → 题单详情（含题目难度/标签/已 AC 状态 + AI 建议缓存）
  r.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const list = db
      .prepare('SELECT id, title, source_url, created_at, ai_suggestion, ai_suggestion_at FROM problem_lists WHERE id = ? AND user_id = ?')
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
      aiSuggestion: list.ai_suggestion ?? null,
      aiSuggestionAt: list.ai_suggestion_at ?? null,
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

  // POST /api/lists/:id/reorder  body: { orderedIds: number[] } → 拖拽排序（全量重写 position）
  // 客户端拖拽后把整单的新顺序传回；分类不受影响（分组视图由 position + category 派生）。
  r.post('/:id/reorder', (req, res) => {
    const id = Number(req.params.id);
    const orderedIds = req.body?.orderedIds;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    if (!Array.isArray(orderedIds) || orderedIds.length === 0 || !orderedIds.every((v: unknown) => Number.isInteger(v))) {
      return res.status(400).json({ error: 'orderedIds 需为非空的条目 id 数组' });
    }
    const list = db
      .prepare('SELECT id FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID);
    if (!list) return res.status(404).json({ error: '题单不存在' });
    const items = db
      .prepare('SELECT id FROM problem_list_items WHERE list_id = ?')
      .all(id) as Array<{ id: number }>;
    const currentIds = new Set(items.map((i) => i.id));
    const ordered = [...new Set(orderedIds as number[])];
    if (ordered.length !== currentIds.size || !ordered.every((v) => currentIds.has(v))) {
      return res.status(400).json({ error: 'orderedIds 需恰好包含该题单的全部条目 id' });
    }
    try {
      db.exec('BEGIN');
      const upd = db.prepare('UPDATE problem_list_items SET position = ? WHERE id = ?');
      ordered.forEach((itemId, idx) => upd.run(idx, itemId));
      db.exec('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      db.exec('ROLLBACK');
      res.status(400).json({ error: `排序失败：${(e as Error).message}` });
    }
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
  // 只更新题库能查到 tags 的题；查不到的保留现有分类——用户此前通过
  // 「AI 分类」或手动调整设置的分类不应被规则分类抹成「其他」。
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
    let unmatched = 0;
    // 批量取回题库 tags 后内存分类（原为逐题一次查询）
    const lookups = classifyItemsBatch(
      db,
      items.map((it) => ({ platform: it.platform, problemKey: it.problem_key })),
    );
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const category = classifyByTags(lookups[i].lookup?.tags);
      if (category === null) {
        unmatched += 1; // 题库查不到/tags 归并不进目录：保留现有分类
        continue;
      }
      if (category !== it.category) {
        upd.run(category, it.id);
        updated += 1;
      }
    }
    res.json({ ok: true, updated, total: items.length, unmatched });
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
        content: `下面是题单「${list.title}」的题目列表。请给每道题归入一个知识点分类，分类只能从给定目录中选择（拿不准归"其他"）。\n\n分类目录：${TAXONOMY.join('、')}\n\n题目列表：\n${lines}\n\n只输出 JSON 数组，格式：[{"i": 0, "category": "${TAXONOMY[0]}"}, ...]，i 为题目的序号，每道题都必须出现一次。`,
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

  // POST /api/lists/:id/ai-suggest → AI 读取题单内容给练习建议（结果缓存到 DB，避免重复调用）
  // body: { force?: boolean } — force=true 时强制重新生成，忽略缓存
  r.post('/:id/ai-suggest', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const force = req.body?.force === true;
    const list = db
      .prepare('SELECT id, title, source_url, ai_suggestion, ai_suggestion_at FROM problem_lists WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as { id: number; title: string; source_url: string | null; ai_suggestion: string | null; ai_suggestion_at: string | null } | undefined;
    if (!list) return res.status(404).json({ error: '题单不存在' });

    // 有缓存且未强制刷新：直接返回
    if (!force && list.ai_suggestion) {
      return res.json({ reply: list.ai_suggestion, cached: true, cachedAt: list.ai_suggestion_at });
    }

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
      // 缓存到 DB
      db.prepare('UPDATE problem_lists SET ai_suggestion = ?, ai_suggestion_at = datetime(\'now\') WHERE id = ?')
        .run(reply, id);
      res.json({ reply, cached: false });
    } catch (e) {
      res.status(502).json({ error: `AI 调用失败：${(e as Error).message}` });
    }
  }));

  return r;
}

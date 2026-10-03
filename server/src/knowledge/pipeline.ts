/**
 * 知识点管线编排：L1 规则批跑 + 题源标签映射 + 版本差量重跑。
 * 当前清洗模块仅保留 L1（标题规则 + 题源标签映射）；AI 标注已退出，未命中题进入
 * 词表缺口报告（GET /gaps），不再等待模型标注。
 * 事务与文件顺序：DB 写入与 JSONL 追加在同一事务窗口内（先 append 后 COMMIT），
 * 崩溃时 JSONL 多出的行由下次启动重放自愈，不会丢标注。
 */
import type { Db } from '../db/index.ts';
import { codeOfTag } from '../../../shared/src/index.ts';
import { loadTaxonomy } from './taxonomy.ts';
import { classifyTitle, rulesVersion } from './ruleEngine.ts';
import {
  appendAnnotations,
  effectiveDataDir,
  setCurrentPipelineVersion,
  tombstoneLine,
  writeAnnotationsToDb,
  type AnnotationWrite,
  type JsonlLine,
} from './store.ts';
import { annotateProblemsFromTags } from './tagAnnotate.ts';

/**
 * 管线代码版本：仅当 pipeline.ts / ruleEngine.ts 的**匹配逻辑**改动时才 bump。
 * 单纯改规则内容（rules.json）不必动这里，见下方复合版本。
 */
export const PIPELINE_CODE_VERSION = 4;
/**
 * 管线版本 = 代码版本 × 1000 + rules.json 版本。
 * 把 rules.json 的 version 真正接入差量重跑依据，消灭「改了规则忘了 bump 版本 → 静默不重跑」，
 * 同时让此前零引用的 rulesVersion() 有了唯一消费方。
 * 例：代码版本 4、rules.json version 1 → 4001。
 *
 * ⚠️ 必须是**函数**，不能在模块加载期算成常量 —— 这是踩过的坑（nightly af38ae8 启动即崩）：
 * SEA 单文件 exe 把 rules.json **内嵌**在 exe 里、磁盘上没有该文件，由 `sea.ts` 调用
 * `setRulesJson()` 注入；而模块加载（import 求值）必然早于 `sea.ts` 里的注入语句。
 * 若在加载期调用 `rulesVersion()`，它只能去读磁盘 → `ENOENT: ...\rules.json` → 程序起不来。
 * 决策点：谁在加载期求值，谁就要为之付出「磁盘上必须存在」的代价。
 * 改成函数后，求值推迟到真正用到时（写标注 / 跑管线），那时注入早已完成。
 */
export function pipelineVersion(): number {
  return PIPELINE_CODE_VERSION * 1000 + rulesVersion();
}
setCurrentPipelineVersion(pipelineVersion);

export interface L1RunResult {
  scanned: number;
  /** 规则命中落库的题数 */
  annotated: number;
  /** tag 来源映射落库的题数（与 rule 并列的独立来源） */
  tagAnnotated: number;
  /**
   * 本轮**规则**未命中的题数（规则未命中的即时读数）。
   * 注意它**不是** gapReport 的「词表缺口」：规则未命中只说明规则没打中，同一题仍可能
   * 由题源标签完整标注（source = 'tag'，见 tagAnnotate.ts），这种题**不出现在
   * gapReport 的 gaps / uncovered 里**（后者只统计 tag/rule/manual 三来源皆无标注的题）。
   * 它曾同时是入队数，但该 AI 标注队列已随 AI 退出而退役、无写入方也无读取方，
   * 现在只作为运维可见的计数保留；缺口本身由 gapReport 按需从 problems 现算。
   */
  ruleMissed: number;
  /** 有人工校正标注而跳过的题数 */
  skippedManual: number;
}

interface ProblemRow {
  platform: string;
  problem_key: string;
  title: string;
  /** 题源标签 JSON（tag 来源标注用；缺省视为无标签） */
  tags?: string;
}

/**
 * 对给定题目集合跑 L1（导入/拉题库钩子与全量批跑共用）。
 * - 已有 manual 标注的题跳过（人工校正置顶）
 * - 已有任意标注的题跳过（增量语义），force 时重跑（覆盖 rule 来源旧标注）
 * - 命中落库 source=rule；未命中只计数（ruleMissed），不再写入任何队列
 * - 同时并联 tag 来源（题源标签 → 知识点 code，落库 source=tag，见 tagAnnotate.ts），
 *   两者同处一个事务窗口，JSONL 在本函数内统一追加
 */
export function annotateProblemsL1(
  db: Db,
  rows: Array<{ platform: string; problemKey: string; title: string; tags?: string }>,
  opts: { dataDir?: string | null; force?: boolean } = {},
): L1RunResult {
  const hasManual = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'manual' LIMIT 1",
  );
  const hasAny = db.prepare(
    'SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? LIMIT 1',
  );
  const deleteRule = db.prepare(
    "DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'rule'",
  );

  const writes: AnnotationWrite[] = [];
  const tombstones: JsonlLine[] = [];
  let ruleMissed = 0;
  let skippedManual = 0;
  let scanned = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (hasManual.get(row.platform, row.problemKey)) {
        skippedManual += 1;
        continue;
      }
      if (!opts.force && hasAny.get(row.platform, row.problemKey)) continue;
      scanned += 1;
      const hits = classifyTitle(row.title);
      if (opts.force && hits.length === 0) {
        // 差量重跑且不再命中：清除该题**规则来源**的过期标注 —— 下面的 DELETE 只删
        // source = 'rule'，同题由题源标签落下的 source = 'tag' 标注不受影响、照旧保留；
        // manual 也不会被清，但带 manual 的题在上面 hasManual 处已跳过，走不到这里。
        // JSONL 补清除快照，防止重放复活。本题下面会计入本轮 ruleMissed（规则口径）。
        deleteRule.run(row.platform, row.problemKey);
        tombstones.push(tombstoneLine(row.platform, row.problemKey, 'rule'));
      }
      if (hits.length > 0) {
        writes.push({
          platform: row.platform,
          problemKey: row.problemKey,
          source: 'rule',
          points: hits.map((h) => ({ code: h.code, confidence: h.confidence, method: h.method })),
          // 标题指纹：记录标注当时的标题，标题被修复后据此判定标注陈旧并触发重跑
          title: row.title,
        });
        // 规则命中：只落 rule 标注，不再有任何队列需要出队
      } else {
        // 规则未命中：计入本轮 ruleMissed（规则未命中的即时读数，≠ gapReport 的词表缺口）。
        // 缺口本身由 gapReport 按需从 problems 现算，不落表。
        ruleMissed += 1;
      }
    }
    const result = writeAnnotationsToDb(db, writes);
    // tag 来源与 rule 来源并联：两者互相独立（rule 已有标注的题仍可能有 tag 标注）。
    // 与 rule 的先后顺序不影响结果：同 code 跨来源冲突由 writeAnnotationsToDb 按
    // SOURCE_PRECEDENCE 显式让位（rule 接管 tag 占用的 code，tag 遇 rule 占位则让开）。
    // tags 的解析口径归 tagAnnotate 一处所有，这里只筛「有没有 tags 字段」。
    const tagWrites = rows
      .filter((r) => r.tags !== undefined)
      .map((r) => ({ platform: r.platform, problemKey: r.problemKey, tags: r.tags! }));
    // dataDir 显式传 null：本函数统一追加 JSONL（把 tagResult.lines 一并带上），
    // 避免同一事务窗口内追加两次（tagAnnotate 对显式 null 的语义见其文档注释）
    const tagResult = annotateProblemsFromTags(db, tagWrites, { dataDir: null });
    if (tagResult.malformedTags > 0) {
      console.warn(`[knowledge] ${tagResult.malformedTags} 题的 problems.tags 不是合法 JSON 数组，已按无标签处理`);
    }
    const dataDir = effectiveDataDir(opts.dataDir);
    if (dataDir) appendAnnotations(dataDir, [...result.lines, ...tagResult.lines, ...tombstones]);
    db.exec('COMMIT');
    return {
      scanned,
      annotated: result.written,
      tagAnnotated: tagResult.annotated,
      ruleMissed,
      skippedManual,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 全量 / 差量 L1 批跑。
 * - 默认：只扫无任何标注的题（增量）
 * - rerun：重跑 rule 来源中「管线/规则/taxonomy 版本落后」或「标题已变更」的题（差量重跑）
 */
export function runRulePass(
  db: Db,
  opts: { dataDir?: string | null; limit?: number; rerun?: boolean } = {},
): L1RunResult {
  const taxonomyVersion = loadTaxonomy().version;
  const limit = opts.limit ?? 20000;
  const rows = opts.rerun
    ? (db
        .prepare(
          `SELECT p.platform, p.problem_key, p.title, p.tags FROM problems p
           WHERE EXISTS (
             SELECT 1 FROM problem_keypoints k
             WHERE k.platform = p.platform AND k.problem_key = p.problem_key
               AND k.source = 'rule'
               AND (
                 k.pipeline_version < ? OR k.taxonomy_version < ?
                 OR k.annotated_title IS NOT p.title
               )
           )
           ORDER BY p.id LIMIT ?`,
        )
        .all(pipelineVersion(), taxonomyVersion, limit) as unknown as ProblemRow[])
    : (db
        .prepare(
          `SELECT p.platform, p.problem_key, p.title, p.tags FROM problems p
           WHERE NOT EXISTS (
             SELECT 1 FROM problem_keypoints k
             WHERE k.platform = p.platform AND k.problem_key = p.problem_key
           )
           ORDER BY p.id LIMIT ?`,
        )
        .all(limit) as unknown as ProblemRow[]);
  return annotateProblemsL1(
    db,
    rows.map((r) => ({ platform: r.platform, problemKey: r.problem_key, title: r.title, tags: r.tags })),
    { dataDir: opts.dataDir, force: opts.rerun === true },
  );
}

// ---------- 词表缺口报告（替代原「待 AI 标注队列」的用途） ----------

/**
 * 词表缺口报告（替代原「待 AI 标注队列」的用途）。
 *
 * AI 退出清洗模块后，未覆盖的题不再等待模型，而是成为**词表缺口**：
 * 这些题的题源标签存在，但映射不到任何 taxonomy code。
 * 补齐 shared/src/tags.ts 的同义组是唯一能真正提升覆盖率的手段（零 AI 成本）。
 */
export interface GapReport {
  /** 无法映射的原始标签 → 影响的题数（降序） */
  gaps: Array<{ tag: string; problems: number }>;
  /** 完全没有可用 code 的题数（题源标签也映射不上、规则也未命中） */
  uncovered: number;
}

export function gapReport(db: Db, opts: { limit?: number } = {}): GapReport {
  const limit = opts.limit ?? 100;

  // 未覆盖题的全部原始标签拉回内存聚合（用 codeOfTag 判定是否可映射）
  const rows = db
    .prepare(
      `SELECT p.tags AS tags FROM problems p
        WHERE NOT EXISTS (
          SELECT 1 FROM problem_keypoints k
           WHERE k.platform = p.platform AND k.problem_key = p.problem_key
             AND k.source IN ('tag','rule','manual')
        )`,
    )
    .all() as unknown as Array<{ tags: string }>;

  const byTag = new Map<string, number>();
  let uncovered = 0;
  for (const r of rows) {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(r.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tags = [];
    }
    if (!tags.some((t) => codeOfTag(t) !== undefined)) uncovered += 1;
    for (const t of new Set(tags)) {
      if (codeOfTag(t) !== undefined) continue;
      byTag.set(t, (byTag.get(t) ?? 0) + 1);
    }
  }

  const gaps = [...byTag.entries()]
    .map(([tag, problems]) => ({ tag, problems }))
    .sort((a, b) => b.problems - a.problems || a.tag.localeCompare(b.tag))
    .slice(0, limit);

  return { gaps, uncovered };
}

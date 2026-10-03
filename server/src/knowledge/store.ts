/**
 * 知识点标注存储层。
 * - dataDir/knowledge/annotations.jsonl：追加写的源真相（每行一题一个来源的完整快照）
 * - problem_keypoints 表：启动时从 JSONL 幂等重建的查询索引
 * 重跑语义：rule / ai 标注可被新版本管线覆盖；manual 永不覆盖（人工校正置顶）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import type {
  KnowledgeAnnotation,
  KnowledgeCoverage,
  KnowledgePointEntry,
  KnowledgeSource,
} from '../../../shared/src/index.ts';
import { loadTaxonomy, nameOfCode } from './taxonomy.ts';
import { rulesVersion } from './ruleEngine.ts';

/**
 * 可读的标注来源集合（单一权威）。
 * AI 已退出清洗模块，因此 `source='ai'` 不参与任何消费端读取；
 * 所有读取 problem_keypoints 的路径都应使用本集合，避免与 startup purge 形成口径差。
 */
export const READABLE_SOURCES_SQL = "source IN ('tag','rule','manual')";

/**
 * 统计端默认置信度阈值。
 * 取 0.6 而非 0.5：规则表最低置信度为 0.6、AI 标注下限已降到 0.35，
 * 阈值 0.5 会让「置信度闸门」在默认配置下拦不住任何一条标注（闸门形同虚设）。
 * 用户可在设置页调整。
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const THRESHOLD_SETTING_KEY = 'knowledge.minConfidence';

/** JSONL 行在 shared KnowledgeAnnotation 基础上带 writeSource：该行是题目某一来源的完整快照 */
export interface JsonlLine extends KnowledgeAnnotation {
  writeSource: KnowledgeSource;
  /** 标注当时的题目标题：标题被修复后据此判定标注陈旧，重跑才有的放矢 */
  annotatedTitle?: string;
}

/** 生成某来源的清除快照（重跑不再命中 / 人工校正覆盖时，防止 JSONL 重放复活旧标注） */
export function tombstoneLine(platform: string, problemKey: string, source: KnowledgeSource): JsonlLine {
  return {
    platform: platform as JsonlLine['platform'],
    problemKey,
    knowledgePoints: [],
    taxonomyVersion: loadTaxonomy().version,
    pipelineVersion: currentPipelineVersion(),
    annotatedAt: new Date().toISOString(),
    writeSource: source,
  };
}

/**
 * 同 code 冲突时的来源优先级（必须两两不同）。
 *
 * `problem_keypoints` 主键是 `(platform, problem_key, code)` —— **不含 source**，
 * 同一 code 只允许一行。因此写入路径必须按本表**显式让位**，而不是依赖调用顺序：
 * 高优先级来源可以接管低优先级来源占用的 code，反之则放弃该 code。
 * 读路径（`loadAnnotationsIntoDb` 从 JSONL 重建）用同一张表，保证「库内视图」与
 * 「源真相重放结果」一致。
 */
export const SOURCE_PRECEDENCE: Record<KnowledgeSource, number> = { manual: 4, ai: 3, rule: 2, tag: 1 };

/** 一次管线写入（同源一组知识点） */
export interface AnnotationWrite {
  platform: string;
  problemKey: string;
  source: KnowledgeSource;
  points: Array<{ code: string; confidence: number; method: string }>;
  /** 标注依据的题目标题（记入 annotated_title，供标题变更后判定陈旧），AI 通道可能缺失 */
  title?: string;
}

// ---------- dataDir 解析（模块级默认 + 调用方显式覆盖） ----------

let defaultDataDir: string | null = null;

/** 服务启动时调用一次：设定 JSONL 落盘目录（测试可不设 = 仅写库模式） */
export function initKnowledgeStore(dataDir: string | null): void {
  defaultDataDir = dataDir;
}

function resolveDataDir(dataDir?: string | null): string | null {
  return dataDir ?? defaultDataDir;
}

/** 调用方未显式传 dataDir 时回退到模块级默认（initKnowledgeStore 设定） */
export function effectiveDataDir(dataDir?: string | null): string | null {
  return resolveDataDir(dataDir);
}

export function annotationsPath(dataDir: string): string {
  return path.join(dataDir, 'knowledge', 'annotations.jsonl');
}

// ---------- 置信度阈值（设置页可调） ----------

export function getConfidenceThreshold(db: Db): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(THRESHOLD_SETTING_KEY) as
    | { value: string }
    | undefined;
  const v = row === undefined ? NaN : Number(row.value);
  if (!Number.isFinite(v) || v < 0 || v > 1) return DEFAULT_CONFIDENCE_THRESHOLD;
  return v;
}

export function setConfidenceThreshold(db: Db, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`置信度阈值须在 [0,1] 内: ${value}`);
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(THRESHOLD_SETTING_KEY, String(value));
}

// ---------- JSONL 读写 ----------

/** 追加写 JSONL（源真相）。须在 DB 事务 COMMIT 前调用：崩溃时 JSONL 多出的行会在下次启动重放自愈 */
export function appendAnnotations(dataDir: string, lines: JsonlLine[]): void {
  if (lines.length === 0) return;
  const file = annotationsPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/**
 * 启动时幂等重建：解析 JSONL，按（题目 × 来源）取最后一行快照，各来源并集落库；
 * 同 code 冲突时按 SOURCE_PRECEDENCE 取高优先级来源。
 * taxonomy 中不存在的 code 丢弃并计数（幻觉/废弃 code 拦截）。
 */
export function loadAnnotationsIntoDb(
  db: Db,
  dataDir: string,
): { lines: number; problems: number; inserted: number; skippedUnknownCode: number } {
  const file = annotationsPath(dataDir);
  if (!fs.existsSync(file)) return { lines: 0, problems: 0, inserted: 0, skippedUnknownCode: 0 };
  const raw = fs.readFileSync(file, 'utf8');
  const latest = new Map<string, JsonlLine>(); // key: platform|key|source
  let lines = 0;
  for (const text of raw.split('\n')) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    lines += 1;
    let line: JsonlLine;
    try {
      line = JSON.parse(trimmed) as JsonlLine;
    } catch {
      continue; // 半行（崩溃截断）跳过
    }
    const source = line.writeSource ?? line.knowledgePoints?.[0]?.source;
    if (!source) continue;
    latest.set(`${line.platform}|${line.problemKey}|${source}`, line);
  }

  // 按题目并集各来源快照；同 code 取高优先级来源（见 SOURCE_PRECEDENCE）
  const byProblem = new Map<string, Map<string, { point: JsonlLine['knowledgePoints'][number]; prio: number }>>();
  for (const line of latest.values()) {
    const problemId = `${line.platform}|${line.problemKey}`;
    let codes = byProblem.get(problemId);
    if (!codes) {
      codes = new Map();
      byProblem.set(problemId, codes);
    }
    for (const point of line.knowledgePoints ?? []) {
      const prio = SOURCE_PRECEDENCE[point.source] ?? 0;
      const existing = codes.get(point.code);
      if (!existing || prio >= existing.prio) codes.set(point.code, { point, prio });
    }
  }

  const insert = db.prepare(
    `INSERT INTO problem_keypoints
       (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_title, annotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skippedUnknownCode = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM problem_keypoints');
    for (const [problemId, codes] of byProblem) {
      const [platform, problemKey] = splitProblemId(problemId);
      for (const { point } of codes.values()) {
        const name = nameOfCode(point.code);
        if (name === null) {
          skippedUnknownCode += 1;
          continue;
        }
        insert.run(
          platform,
          problemKey,
          point.code,
          name,
          point.confidence,
          point.source,
          point.method,
          lineVersion(latest, problemId, point.source, 'taxonomy'),
          lineVersion(latest, problemId, point.source, 'pipeline'),
          lineAnnotatedTitle(latest, problemId, point.source),
          lineAnnotatedAt(latest, problemId, point.source),
        );
        inserted += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { lines, problems: byProblem.size, inserted, skippedUnknownCode };
}

function splitProblemId(id: string): [string, string] {
  const idx = id.indexOf('|');
  return [id.slice(0, idx), id.slice(idx + 1)];
}

function lineVersion(
  latest: Map<string, JsonlLine>,
  problemId: string,
  source: KnowledgeSource,
  kind: 'taxonomy' | 'pipeline',
): number {
  const line = latest.get(`${problemId}|${source}`);
  return kind === 'taxonomy' ? (line?.taxonomyVersion ?? 0) : (line?.pipelineVersion ?? 0);
}

function lineAnnotatedAt(latest: Map<string, JsonlLine>, problemId: string, source: KnowledgeSource): string {
  return latest.get(`${problemId}|${source}`)?.annotatedAt ?? new Date().toISOString();
}

function lineAnnotatedTitle(
  latest: Map<string, JsonlLine>,
  problemId: string,
  source: KnowledgeSource,
): string | null {
  return latest.get(`${problemId}|${source}`)?.annotatedTitle ?? null;
}

// ---------- 写入（管线 / 人工校正共用） ----------

/**
 * 批量写入标注（同源）。manual 保护：题目已有 manual 标注时整题跳过（人工校正置顶）。
 * 同来源旧行整体替换（重跑语义）。
 * 同 code 跨来源冲突按 SOURCE_PRECEDENCE 让位（见该常量注释），因此**调用顺序不影响结果**：
 * 高优先级来源接管低优先级的同 code 行，低优先级来源遇到高优先级占位则跳过该 code。
 * 返回各题目的 JSONL 行（调用方在 COMMIT 前 appendAnnotations）。
 */
export function writeAnnotationsToDb(
  db: Db,
  writes: AnnotationWrite[],
): { lines: JsonlLine[]; written: number; skippedManual: number } {
  const taxonomyVersion = loadTaxonomy().version;
  const pipelineVersion = currentPipelineVersion();
  const hasManual = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'manual' LIMIT 1",
  );
  const delSameSource = db.prepare(
    'DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = ?',
  );
  // 主键 (platform, problem_key, code) 不含 source：同 code 只能一行，写入前必须查占位者
  const holderOfCode = db.prepare(
    'SELECT source FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND code = ? LIMIT 1',
  );
  const delCode = db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND code = ?');
  const insert = db.prepare(
    `INSERT INTO problem_keypoints
       (platform, problem_key, code, name, confidence, source, method, taxonomy_version, pipeline_version, annotated_title, annotated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const lines: JsonlLine[] = [];
  let written = 0;
  let skippedManual = 0;
  const now = new Date().toISOString();
  for (const w of writes) {
    if (w.source !== 'manual' && hasManual.get(w.platform, w.problemKey)) {
      skippedManual += 1;
      continue;
    }
    delSameSource.run(w.platform, w.problemKey, w.source);
    const points: JsonlLine['knowledgePoints'] = [];
    for (const p of w.points) {
      const name = nameOfCode(p.code);
      if (name === null) continue; // 幻觉 / 废弃 code 拦截
      // 同 code 被别的来源占位时按优先级让位：优先级更高 → 删掉占位行后接管；
      // 更低 → 放弃该 code（不写库、也不进本条 JSONL 快照，保持「快照 = 本来源实际持有」）。
      // 这样 rule 想接管 tag 已占用的 code 时不会再撞主键、把整批事务打回。
      // `?? 0` 与读路径（loadAnnotationsIntoDb）口径一致：枚举外的脏 source 视为最低优先级。
      const holder = holderOfCode.get(w.platform, w.problemKey, p.code) as { source: KnowledgeSource } | undefined;
      if (holder && (SOURCE_PRECEDENCE[holder.source] ?? 0) > (SOURCE_PRECEDENCE[w.source] ?? 0)) continue;
      if (holder) delCode.run(w.platform, w.problemKey, p.code);
      insert.run(
        w.platform,
        w.problemKey,
        p.code,
        name,
        p.confidence,
        w.source,
        p.method,
        taxonomyVersion,
        pipelineVersion,
        w.title ?? null,
        now,
      );
      points.push({ code: p.code, confidence: p.confidence, source: w.source, method: p.method });
    }
    lines.push({
      platform: w.platform as JsonlLine['platform'],
      problemKey: w.problemKey,
      knowledgePoints: points,
      taxonomyVersion,
      pipelineVersion,
      annotatedAt: now,
      writeSource: w.source,
      ...(w.title !== undefined ? { annotatedTitle: w.title } : {}),
    });
    written += 1;
  }
  return { lines, written, skippedManual };
}

/**
 * 当前管线版本 —— **惰性求值**，不要在模块加载期算。
 *
 * 由 pipeline.ts 在模块加载时注册一个 getter（避免循环依赖），首次写入标注时才真正求值。
 * 为什么必须惰性：SEA 单文件 exe 把 rules.json 内嵌在 exe 里，靠 sea.ts 注入；
 * 而模块加载早于注入，加载期求值会去读磁盘 → ENOENT → 启动即崩
 * （nightly af38ae8 的真实故障，见 GitHub issue #15）。
 */
let versionGetter: (() => number) | null = null;
let fallbackVersion = 1;

/** 由 pipeline.ts 在模块加载时注册（只注册 getter，不在此时调用它） */
export function setCurrentPipelineVersion(v: number | (() => number)): void {
  if (typeof v === 'function') versionGetter = v;
  else fallbackVersion = v;
}

/** 取当前管线版本：有 getter 时惰性求值，否则回退到注册值（默认 1） */
function currentPipelineVersion(): number {
  return versionGetter === null ? fallbackVersion : versionGetter();
}

/** L3 人工校正：整题覆盖写 source=manual（重跑管线不覆盖 manual） */
export function setManualKeypoints(
  db: Db,
  platform: string,
  problemKey: string,
  codes: string[],
  opts: { dataDir?: string | null } = {},
): { lines: JsonlLine[] } {
  const points = codes.map((code) => {
    if (nameOfCode(code) === null) throw new Error(`未知知识点 code: ${code}`);
    return { code, confidence: 1, method: 'manual' };
  });
  // dataDir 语义与同文件的 purgeAiAnnotations **不同**，此处刻意保留（本次改动要求可观察行为不变）：
  //   本函数：undefined 与显式 null 都回退到模块级默认目录（resolveDataDir 的 `??` 语义）；
  //   purgeAiAnnotations：显式 null = 明确不写 JSONL。
  // ⚠️ 这处分歧**没有任何测试锚定**：test/knowledge-store.test.ts 里唯一的 { dataDir: null }
  // 调用之所以没写 JSONL，只是因为那个用例没调 initKnowledgeStore、模块默认目录恰好为 null，
  // 两种语义在该用例下结果相同。生产唯一调用方（routes/knowledge.ts 的人工校正端点）不传 opts，
  // 走模块默认目录。故这是一处未被锚定的分歧，值得日后统一，本次不动它。
  const dataDir = resolveDataDir(opts.dataDir);
  db.exec('BEGIN');
  try {
    // 人工校正清除该题全部旧来源标注后写 manual（校正即定论）；
    // rule/tag/ai 各补一行清除快照，防止 JSONL 重放时复活旧来源标注
    // （tag 层不会重访 manual 题，漏掉 tag 墓碑 = 被清除的 tag 行下次启动原样复活）
    db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?').run(platform, problemKey);
    const result = writeAnnotationsToDb(db, [{ platform, problemKey, source: 'manual', points }]);
    if (dataDir) {
      // ⚠️ 写序：manual 快照行必须**先于**其它来源的墓碑行。JSONL 是源真相，崩溃可能落在
      // 两次 append 之间；先写 manual 才能让「用户显式校正」在任何截断点上都已落盘，
      // 重放最多让被清除的 rule/tag 旧行回来（可再校正），绝不会丢掉人工校正本身。
      // 反过来（墓碑在前）则截断后 JSONL 只剩墓碑、没有 manual 行 → 启动重放把用户
      // 的显式校正永久抹掉（不可逆的数据损失）。
      appendAnnotations(dataDir, [
        ...result.lines,
        tombstoneLine(platform, problemKey, 'rule'),
        tombstoneLine(platform, problemKey, 'tag'),
        tombstoneLine(platform, problemKey, 'ai'),
      ]);
    }
    db.exec('COMMIT');
    return { lines: result.lines };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** AI 退出知识点清洗模块：删除全部 source='ai' 的标注，并向 JSONL 源真相追加 tombstone 防止复活。
 * 必须在事务内完成：DELETE 与 JSONL 追加同时成功或同时回滚。 */
export function purgeAiAnnotations(
  db: Db,
  opts: { dataDir?: string | null } = {},
): { deleted: number; tombstones: number } {
  const rows = db
    .prepare("SELECT DISTINCT platform, problem_key FROM problem_keypoints WHERE source = 'ai'")
    .all() as unknown as Array<{ platform: string; problem_key: string }>;
  if (rows.length === 0) return { deleted: 0, tombstones: 0 };

  // 显式 null = 不写 JSONL；undefined = 回退模块级默认目录
  const dataDir = opts.dataDir === null ? null : effectiveDataDir(opts.dataDir);
  db.exec('BEGIN');
  try {
    const info = db.prepare("DELETE FROM problem_keypoints WHERE source = 'ai'").run();
    if (dataDir) {
      appendAnnotations(dataDir, rows.map((r) => tombstoneLine(r.platform, r.problem_key, 'ai')));
    }
    db.exec('COMMIT');
    return { deleted: Number(info.changes ?? 0), tombstones: dataDir ? rows.length : 0 };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 查询接口 ----------

export function keypointsOfProblem(db: Db, platform: string, problemKey: string): KnowledgePointEntry[] {
  const rows = db
    .prepare(
      `SELECT code, name, confidence, source, method FROM problem_keypoints
       WHERE platform = ? AND problem_key = ? AND ${READABLE_SOURCES_SQL}
       ORDER BY confidence DESC`,
    )
    .all(platform, problemKey) as unknown as KnowledgePointEntry[];
  return rows;
}

/**
 * 知识点读取路径（**唯一实现**，调用处的题目表别名必须是 p）。
 *
 * 三来源：problem_keypoints 中 source IN ('tag','rule','manual') 的标注按题聚合，
 * 一题多 code 全返回（主键 (platform, problem_key, code) 保证同题同 code 至多一行，
 * 故 SQL 无需 DISTINCT）；无标注则回退题源 tags（已净化的原始值，供审计与兜底）。
 *
 * `manual` 必须留在读取侧：`setManualKeypoints`（人工校正）会先删掉该题**全部**旧行、
 * 再只写 manual 行 —— 读取侧若不认 manual，用户显式做出的校正就会在题库列表 / 统计 /
 * 复习里被静默回退成平台原始 tags。manual 是人工覆盖，为本模块最高优先级来源
 * （见 SOURCE_PRECEDENCE）。**同 code 的跨来源让位只发生在写入侧**：读取侧不挑来源、
 * 不做优先级裁决，各来源的点位取并集。
 *
 * 已摘除两个分支（清洗重构 spec §1.3）：
 * - `source='ai'`：AI 已退出清洗模块，不再参与任何统计
 * - `problem_topics`（v1 遗留层）：表与写入路径已彻底移除，不再参与读取
 *
 * confidence 不再作为可信度门槛（该字段已降级为来源内排序权重）；
 * 因此本函数不再读取知识库阈值设置。
 *
 */
export function knowledgeTagsSql(_db: Db): string {
  return (
    `CASE WHEN EXISTS (SELECT 1 FROM problem_keypoints pk WHERE pk.platform = p.platform ` +
    `AND pk.problem_key = p.problem_key AND pk.${READABLE_SOURCES_SQL}) ` +
    `THEN (SELECT json_group_array(pk2.name) FROM problem_keypoints pk2 WHERE pk2.platform = p.platform ` +
    `AND pk2.problem_key = p.problem_key AND pk2.${READABLE_SOURCES_SQL}) ` +
    `ELSE p.tags END AS tags`
  );
}

/**
 * knowledgeTagsSql 同一口径的 CTE 版本：把标注侧预聚合成按题一行的小派生表，
 * 再由调用方 LEFT JOIN —— 避免标量子查询逐行重跑（题库 2 万题时的主要开销）。
 * 来源过滤与标量版严格一致（tag/rule/manual；含 manual 的理由见 knowledgeTagsSql 注释）。
 * 用法：`WITH ${problemKeypointsCte(db)} SELECT ... ${knowledgeTagsCoalesceSql()} FROM problems p ${knowledgeTagsJoinSql()}`
 */
export function problemKeypointsCte(_db: Db): string {
  return (
    `pk AS (SELECT platform, problem_key, json_group_array(name) AS tags FROM problem_keypoints ` +
    `WHERE ${READABLE_SOURCES_SQL} GROUP BY platform, problem_key)`
  );
}

/** problemKeypointsCte 对应的 FROM 附加子句 */
export function knowledgeTagsJoinSql(): string {
  return 'LEFT JOIN pk ON pk.platform = p.platform AND pk.problem_key = p.problem_key';
}

/**
 * 三来源回退的 tags 列（配合 knowledgeTagsJoinSql 使用），别名必须为 p。
 * ⚠️ 仅返回题源 tags 回退值 —— pk 侧的名称数组在调用方需另行透传，
 * 本函数保留 `AS tags` 形态以兼容既有 problems.ts 用法。
 */
export function knowledgeTagsCoalesceSql(): string {
  return `${knowledgeTagsExpr()} AS tags`;
}

/** 同上但**不带 AS 别名**：供 json_each(...) 等需要表达式的场景使用 */
export function knowledgeTagsExpr(): string {
  return 'COALESCE(pk.tags, p.tags)';
}

export function getCoverage(db: Db): KnowledgeCoverage {
  const t = getConfidenceThreshold(db);
  const total = (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c;
  const annotated = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM problem_keypoints WHERE ${READABLE_SOURCES_SQL} AND confidence >= ? GROUP BY platform, problem_key)`)
      .get(t) as { c: number }
  ).c;
  const withAny = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM problem_keypoints WHERE ${READABLE_SOURCES_SQL} GROUP BY platform, problem_key)`)
      .get() as { c: number }
  ).c;
  const bySourceRows = db
    .prepare(`SELECT source, COUNT(DISTINCT platform || char(31) || problem_key) AS c FROM problem_keypoints WHERE ${READABLE_SOURCES_SQL} GROUP BY source`)
    .all() as Array<{ source: KnowledgeSource; c: number }>;
  const bySource: Record<KnowledgeSource, number> = { tag: 0, rule: 0, ai: 0, manual: 0 };
  for (const row of bySourceRows) bySource[row.source] = row.c;
  return {
    total,
    annotated,
    coverage: total === 0 ? 0 : Math.round((annotated / total) * 1000) / 10,
    lowConfidenceOnly: withAny - annotated,
    bySource,
    uncovered: total - annotated,
    taxonomyVersion: loadTaxonomy().version,
    pipelineVersion: currentPipelineVersion(),
    rulesVersion: rulesVersion(),
    threshold: t,
  };
}

import type {
  ManualSubmissionRow,
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { MANUAL_CSV_HEADER } from '../../../shared/src/index.ts';
import { parseCsv } from './csv.ts';

const VERDICTS: readonly Verdict[] = ['AC', 'WA', 'TLE', 'RE', 'MLE', 'CE', 'SKIPPED'];

/** 将单行手动输入（JSON 表单 / CSV 行）校验并转换为统一 Submission 结构。 */
export function parseManualRow(
  platform: PlatformId,
  row: ManualSubmissionRow,
  index: number,
): NormalizedSubmission {
  const problemKey = String(row.problemKey ?? '').trim();
  if (!problemKey) {
    throw new Error(`第 ${index + 1} 行缺少 problemKey`);
  }
  const verdictRaw = String(row.verdict ?? 'SKIPPED').trim().toUpperCase();
  if (!(VERDICTS as readonly string[]).includes(verdictRaw)) {
    throw new Error(
      `第 ${index + 1} 行 verdict 非法: "${row.verdict}"（可用 ${VERDICTS.join('/')}）`,
    );
  }
  let submittedAt = new Date().toISOString();
  if (row.submittedAt) {
    if (Number.isNaN(Date.parse(row.submittedAt))) {
      throw new Error(`第 ${index + 1} 行 submittedAt 无法解析: ${row.submittedAt}`);
    }
    submittedAt = new Date(row.submittedAt).toISOString();
  }
  const tags = Array.isArray(row.tags)
    ? row.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(row.tags ?? '')
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean);
  // null/空串/纯空白一律按缺省（NaN）：Number(null)=0、Number('')=0 会绕过 isFinite
  // 校验，以 manual 最高优先级写入 difficulty=0，永久挡住难度回填并污染低分桶。
  const difficultyRaw = row.difficulty;
  const difficulty =
    difficultyRaw === undefined || difficultyRaw === null || String(difficultyRaw).trim() === ''
      ? NaN
      : Number(difficultyRaw);
  // 缺省 externalId：稳定组合（平台+题号+结果），重复导入同一条记录自动去重；
  // 同一题不同结果（WA/AC）会保留多条
  const externalId =
    row.externalId ?? `manual:${platform}:${problemKey}:${verdictRaw}`;

  return {
    problem: {
      platform,
      problemKey,
      title: row.title?.trim() || problemKey,
      ...(Number.isFinite(difficulty) ? { difficulty } : {}),
      ...(row.url?.trim() ? { url: row.url.trim() } : {}),
      tags,
    },
    verdict: verdictRaw as Verdict,
    // 手动导入可粘贴 JSON，language 可能是数字（洛谷 langId）：?.trim() 对 number 会抛
    // TypeError，把整行报成难懂的导入失败。统一先 String()，具体归一交给写入层守卫。
    ...(String(row.language ?? '').trim() ? { language: String(row.language).trim() } : {}),
    submittedAt,
    externalId,
  };
}

/** 解析手动导入 CSV（表头 + 数据行），返回统一 Submission 结构。 */
export function parseCsvRows(
  platform: PlatformId,
  csv: string,
): NormalizedSubmission[] {
  return parseCsvRowsWithReport(platform, csv).subs;
}

/** 逐行解析结果：合法行 + 非法行（含行号与原因），预览接口使用 */
export interface RowParseReport {
  subs: NormalizedSubmission[];
  invalid: Array<{ line: number; error: string }>;
}

/** 逐行解析手动行：单行失败不中断整批（导入预览用），非法行带行号与原因 */
export function parseManualRowsWithReport(
  platform: PlatformId,
  rows: ManualSubmissionRow[],
): RowParseReport {
  const subs: NormalizedSubmission[] = [];
  const invalid: Array<{ line: number; error: string }> = [];
  rows.forEach((row, i) => {
    try {
      subs.push(parseManualRow(platform, row, i));
    } catch (e) {
      invalid.push({ line: i + 1, error: (e as Error).message });
    }
  });
  return { subs, invalid };
}

/** 逐行解析 CSV：表头缺失仍整体抛错（结构性问题）；数据行单行失败不中断 */
export function parseCsvRowsWithReport(platform: PlatformId, csv: string): RowParseReport {
  const rows = parseCsv(csv);
  if (rows.length === 0) return { subs: [], invalid: [] };
  const header = rows[0].map((h) => h.trim());
  for (const col of MANUAL_CSV_HEADER) {
    if (!header.includes(col)) {
      throw new Error(`CSV 缺少列: ${col}（表头: ${MANUAL_CSV_HEADER.join(',')}）`);
    }
  }
  const subs: NormalizedSubmission[] = [];
  const invalid: Array<{ line: number; error: string }> = [];
  rows.slice(1).forEach((r, i) => {
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c += 1) {
      const val = (r[c] ?? '').trim();
      if (val === '') continue;
      obj[header[c]] = header[c] === 'difficulty' ? Number(val) : val;
    }
    // line 用含表头的 CSV 文件行号（表头为第 1 行，数据行从第 2 行起）
    try {
      subs.push(parseManualRow(platform, obj as unknown as ManualSubmissionRow, i + 1));
    } catch (e) {
      invalid.push({ line: i + 2, error: (e as Error).message });
    }
  });
  return { subs, invalid };
}

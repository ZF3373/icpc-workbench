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
  const difficulty = row.difficulty !== undefined ? Number(row.difficulty) : NaN;
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
    ...(row.language?.trim() ? { language: row.language.trim() } : {}),
    submittedAt,
    externalId,
  };
}

/** 解析手动导入 CSV（表头 + 数据行），返回统一 Submission 结构。 */
export function parseCsvRows(
  platform: PlatformId,
  csv: string,
): NormalizedSubmission[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  for (const col of MANUAL_CSV_HEADER) {
    if (!header.includes(col)) {
      throw new Error(`CSV 缺少列: ${col}（表头: ${MANUAL_CSV_HEADER.join(',')}）`);
    }
  }
  return rows.slice(1).map((r, i) => {
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c += 1) {
      const val = (r[c] ?? '').trim();
      if (val === '') continue;
      obj[header[c]] = header[c] === 'difficulty' ? Number(val) : val;
    }
    return parseManualRow(platform, obj as unknown as ManualSubmissionRow, i + 1);
  });
}

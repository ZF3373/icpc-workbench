// 跨端共享类型与常量（server / client 通过相对路径 import）
// 1.2 阶段会扩展 Submission / Problem / Plan 等数据结构。

export type PlatformId = 'codeforces' | 'atcoder' | 'luogu' | 'nowcoder';

export type PlatformSync = 'auto' | 'cookie' | 'manual';

export interface PlatformMeta {
  id: PlatformId;
  name: string;
  nameEn: string;
  hasOfficialApi: boolean;
  homepage: string;
  /** 刷题数据获取方式：auto=公开 API 自动同步；cookie=需配置登录 Cookie 后自动同步；manual=仅手动导入 */
  sync: PlatformSync;
}

export const PLATFORMS: PlatformMeta[] = [
  { id: 'codeforces', name: 'Codeforces', nameEn: 'Codeforces', hasOfficialApi: true, homepage: 'https://codeforces.com', sync: 'auto' },
  { id: 'atcoder', name: 'AtCoder', nameEn: 'AtCoder', hasOfficialApi: false, homepage: 'https://atcoder.jp', sync: 'auto' },
  { id: 'luogu', name: '洛谷', nameEn: 'Luogu', hasOfficialApi: false, homepage: 'https://www.luogu.com.cn', sync: 'cookie' },
  { id: 'nowcoder', name: '牛客', nameEn: 'Nowcoder', hasOfficialApi: false, homepage: 'https://ac.nowcoder.com', sync: 'auto' },
];

export function platformMeta(id: PlatformId): PlatformMeta {
  const m = PLATFORMS.find((p) => p.id === id);
  if (!m) throw new Error(`unknown platform: ${id}`);
  return m;
}

// ---------- 刷题记录与题目（平台适配器输出统一结构） ----------

export type Verdict =
  | 'AC'
  | 'WA'
  | 'TLE'
  | 'RE'
  | 'MLE'
  | 'CE'
  | 'SKIPPED';

export interface NormalizedProblem {
  platform: PlatformId;
  /** 平台内唯一标识，如 CF 题号 1919C / AtCoder abc321_a */
  problemKey: string;
  title: string;
  /** 难度：CF rating；AtCoder 映射分值；洛谷难度数值；无则省略 */
  difficulty?: number;
  url?: string;
  tags: string[];
}

export interface NormalizedSubmission {
  problem: NormalizedProblem;
  verdict: Verdict;
  language?: string;
  /** ISO8601 UTC */
  submittedAt: string;
  /** 平台侧提交号（去重/增量依据） */
  externalId: string;
}

export interface SyncResult {
  platform: PlatformId;
  handle: string;
  imported: number;
  skipped: number;
  errors: string[];
}

/** 手动导入单行输入（JSON 表单或 CSV 解析后）。 */
export interface ManualSubmissionRow {
  /** 平台内题目标识，如 P1001 / abc321_a（必填） */
  problemKey: string;
  title?: string;
  verdict?: string;
  difficulty?: number;
  /** 多个标签用 '|' 或数组 */
  tags?: string[] | string;
  url?: string;
  /** ISO8601，缺省为导入时刻 */
  submittedAt?: string;
  language?: string;
  externalId?: string;
}

/** 手动导入 CSV 表头（不含 platform，平台由请求 body 指定）。 */
export const MANUAL_CSV_HEADER = [
  'problemKey',
  'title',
  'verdict',
  'difficulty',
  'tags',
  'url',
  'submittedAt',
  'language',
  'externalId',
] as const;

// ---------- 弱项画像（分析引擎输出，跨端契约） ----------

export interface WeaknessItem {
  tag: string;
  attempts: number;
  ac: number;
  acRate: number;
  avgAcRate: number;
  /** avg - self，正值表示弱于总体平均 */
  gap: number;
  solved: number;
}

export interface DifficultyWeakness {
  bucket: string;
  attempts: number;
  ac: number;
  acRate: number;
  gap: number;
}

export interface WeaknessProfile {
  items: WeaknessItem[];
  byDifficulty: DifficultyWeakness[];
  generatedAt: string;
}


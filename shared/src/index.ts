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
  /** 本次为增量同步（沿用上次同步起点 / 已知提交号提前终止）；仅 true 时出现 */
  incremental?: boolean;
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


// ---------- 复习库（间隔复习，借鉴 cf-compass） ----------

export type ReviewFeedback = 'hard' | 'ok' | 'easy';

/** 复习队列条目（服务端联表 problems 输出） */
export interface ReviewItem {
  id: number;
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
  /** 间隔阶梯档位（0 起步） */
  stage: number;
  /** 当前档位对应的间隔天数 */
  intervalDays: number;
  note: string | null;
  /** 下次到期日 YYYY-MM-DD */
  nextDueOn: string;
  lastReviewedAt: string | null;
  addedAt: string;
}

// ---------- 今日训练（三档题单，借鉴 cf-compass） ----------

export type TodayBandKey = 'consolidation' | 'core' | 'challenge';

/** 三档题单中的候选题 */
export interface TodayProblem {
  id: number;
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
  /** 命中的弱项标签（推荐理由） */
  weakTags: string[];
}

export interface TodayBand {
  key: TodayBandKey;
  label: string;
  description: string;
  /** 本档难度区间 [min, max]（闭区间，null 表示不限） */
  range: [number | null, number | null];
  problems: TodayProblem[];
  /** 该难度段的候选题总数（选题前，用于空态提示） */
  pool: number;
}

export interface TodayPlan {
  date: string;
  /** 估算能力值（近期 AC 难度中位数，千人千面的三档分档基准） */
  level: number;
  bands: TodayBand[];
  /** 到期复习数（来自复习库） */
  dueReviews: number;
  /** 今日计划任务完成度（无计划时为 null） */
  planProgress: { total: number; checked: number } | null;
}

// ---------- 赛事中心（多 OJ 公开赛事列表） ----------

export interface ContestInfo {
  /** 平台内唯一 ID：cf-2259 / at-abc380 / lg-353129 */
  id: string;
  platform: PlatformId;
  name: string;
  /** 展示用分类：Div. 2 / ABC / AGC / 月赛 / 重现赛 … */
  category: string;
  /** ISO8601 开始时间（null = 时间待定，不参与日程） */
  startTimeIso: string | null;
  /** 时长（分钟） */
  durationMinutes: number;
  phase: string;
  url: string;
}

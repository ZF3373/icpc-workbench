// 跨端共享类型与常量（server / client 通过相对路径 import）
// 1.2 阶段会扩展 Submission / Problem / Plan 等数据结构。

// 仅类型引用：本模块反向 re-export difficulty.ts，用 import type 避免运行时循环依赖
import type { DifficultyScale } from './difficulty.ts';

export type PlatformId = 'codeforces' | 'atcoder' | 'luogu' | 'nowcoder' | 'daimayuan' | 'leetcode' | 'jisuanke' | 'qoj';

export type PlatformSync = 'auto' | 'cookie' | 'manual';

export interface PlatformMeta {
  id: PlatformId;
  name: string;
  nameEn: string;
  hasOfficialApi: boolean;
  homepage: string;
  /** 刷题数据获取方式：auto=公开 API 自动同步；cookie=需配置登录 Cookie 后自动同步；manual=仅手动导入 */
  sync: PlatformSync;
  /** 是否提供公开题库拉取（QOJ 无：/problems 需 cf_clearance 且无难度字段） */
  hasBank: boolean;
  /** 难度所属标度（前端展示与说明用） */
  difficultyScale: DifficultyScale;
  /** 提交来源：contest=比赛内提交；practice=自由练题/题库提交；none=不适用 */
  syncSources: Array<'contest' | 'practice' | 'none'>;
}

export const PLATFORMS: PlatformMeta[] = [
  { id: 'codeforces', name: 'Codeforces', nameEn: 'Codeforces', hasOfficialApi: true, homepage: 'https://codeforces.com', sync: 'auto', hasBank: true, difficultyScale: 'cf-rating', syncSources: ['none'] },
  { id: 'atcoder', name: 'AtCoder', nameEn: 'AtCoder', hasOfficialApi: false, homepage: 'https://atcoder.jp', sync: 'auto', hasBank: true, difficultyScale: 'atcoder-kenkoooo-irt', syncSources: ['none'] },
  { id: 'luogu', name: '洛谷', nameEn: 'Luogu', hasOfficialApi: false, homepage: 'https://www.luogu.com.cn', sync: 'cookie', hasBank: true, difficultyScale: 'luogu-2026-06', syncSources: ['none'] },
  { id: 'nowcoder', name: '牛客', nameEn: 'Nowcoder', hasOfficialApi: false, homepage: 'https://ac.nowcoder.com', sync: 'auto', hasBank: true, difficultyScale: 'nowcoder-score', syncSources: ['none'] },
  // 代码源（Hydro 系）：评测记录页需登录（会话 Cookie sid），题库公开
  { id: 'daimayuan', name: '代码源', nameEn: 'Daimayuan', hasOfficialApi: false, homepage: 'https://bs.daimayuan.top', sync: 'cookie', hasBank: true, difficultyScale: 'hydro-1-10', syncSources: ['none'] },
  // 力扣（leetcode.cn）：GraphQL 接口无官方公开 API；提交记录需登录 Cookie，题库匿名可访问。
  // 仅接入了力扣中国（leetcode.cn）——国际版 leetcode.com 的 GraphQL schema 不同，未接入。
  { id: 'leetcode', name: 'LeetCode', nameEn: 'LeetCode', hasOfficialApi: false, homepage: 'https://leetcode.cn', sync: 'cookie', hasBank: true, difficultyScale: 'leetcode-tier', syncSources: ['none'] },
  // 计蒜客（www.jisuanke.com，原 nanti.jisuanke.com 竞赛 OJ）：无公开 API；
  // 提交记录按「参加过的比赛」组织，需登录 Cookie 后逐赛拉取，题库非独立公开页。
  { id: 'jisuanke', name: '计蒜客', nameEn: 'Jisuanke', hasOfficialApi: false, homepage: 'https://www.jisuanke.com', sync: 'cookie', hasBank: true, difficultyScale: 'jisuanke-level-8', syncSources: ['contest', 'practice'] },
  // QOJ（qoj.ac，UOJ 系评测系统，Universal Cup 等 ICPC 系列赛的官方 OJ）：
  // 无公开提交 API（/api/* 恒返回 401），提交记录只有服务端渲染的 /submissions 分页 HTML 可用；
  // 站点前置 Cloudflare 托管挑战，因此除登录会话 UOJSESSID 外通常还需浏览器签发的 cf_clearance。
  { id: 'qoj', name: 'QOJ', nameEn: 'QOJ', hasOfficialApi: false, homepage: 'https://qoj.ac', sync: 'cookie', hasBank: false, difficultyScale: 'none', syncSources: ['none'] },
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
  /**
   * 平台原生难度原文（洛谷 `4` / 计蒜客 `level6` / 力扣 `HARD` / 牛客 `1500` / kenkoooo `1545`）。
   * 与 difficulty（CF rating）同时写入，供平台改档后按标度重算与 UI 展示。
   */
  nativeDifficulty?: string;
  /** 原生难度所属标度（见 difficulty.ts 的 DifficultyScale） */
  difficultyScale?: DifficultyScale;
  url?: string;
  tags: string[];
}

/** 提交语境（能区分赛场发挥与练习/补题的平台才下发，其余为 undefined） */
export type SubmissionContext = 'contest' | 'virtual' | 'practice';

export interface NormalizedSubmission {
  problem: NormalizedProblem;
  verdict: Verdict;
  language?: string;
  /** ISO8601 UTC */
  submittedAt: string;
  /** 平台侧提交号（去重/增量依据） */
  externalId: string;
  /**
   * 提交语境：contest = 比赛进行中（含现场非正式参赛）、virtual = 虚拟赛、practice = 赛后补题/题单练习。
   * 目前仅 Codeforces 下发（user.status.participantType）；能力值算法用其区分赛场 AC 与补题 AC。
   */
  context?: SubmissionContext;
}

export interface SyncResult {
  platform: PlatformId;
  handle: string;
  imported: number;
  skipped: number;
  errors: string[];
  /** 本次为增量同步（沿用上次同步起点 / 已知提交号提前终止）；仅 true 时出现 */
  incremental?: boolean;
  /**
   * 本次因触及「单次同步上限」而提前停止（提交记录过多，分批拉取以防触发平台风控封号）。
   * 为 true 时 last_sync_at 不会推进到「现在」（AtCoder 按已拉最新时间续拉），
   * 且 platform_accounts.sync_truncated 置 1，下次同步自动进入补全模式继续拉取更早的历史。
   */
  truncated?: boolean;
  /** 截断等情况下给用户的可读提示（前端直接展示） */
  note?: string;
  /**
   * 本次截断后已注册的后台分批续拉（缺省 = 未注册：轮数上限为 0、days 窗口模式、
   * 后台续拉自身触发，或未装配调度器）。前端同步中心据此显示「第 N/M 轮 · X 秒后继续」。
   */
  autoContinue?: { round: number; maxRounds: number; nextAt: string };
}

/** 同步任务历史一行（同步中心展示）。status: ok=成功 / failed=失败（含需手动导入引导）。 */
export interface SyncRun {
  id: number;
  platform: PlatformId;
  handle: string;
  /** ISO8601 UTC */
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  imported: number;
  skipped: number;
  truncated: number;
  /** 限速等待总耗时（毫秒） */
  waitedMs: number;
  /** full=换账号全量 / incremental=增量 / backfill=补全 / days=仅最近 N 天 */
  mode: 'full' | 'incremental' | 'backfill' | 'days';
  status: 'ok' | 'failed';
  /** auth_expired / rate_limited / schema_changed / manual_required / network / unknown */
  errorCode: string | null;
  errorMessage: string | null;
  /** manual=手动 / retry=重试失败平台 / days=窗口同步 / all=一键同步 */
  triggeredBy: string;
  /** 按平台节奏推荐的下次同步时间（ISO8601，可为空） */
  nextSuggestedSyncAt: string | null;
}

/**
 * 进行中的同步（GET /api/sync/progress 的一项）。
 *
 * 为什么需要：单次同步现在按平台节奏限速（几十秒到几分钟），而 POST /api/sync/:platform
 * 是一发到底的长请求，中途没有任何响应。前端据此显示「已用时 + 该站点请求数 + 最后请求距今」，
 * 让用户看见它确实在动，不会误以为卡住而退出。
 *
 * 数据来源都是**真实发生的请求**（节流层计数），不是估值百分比 —— 适配器内部的页数/条数
 * 知识不下放到前端，宁可不给百分比也不给假进度。
 */
export interface SyncProgressJob {
  platform: PlatformId;
  handle: string;
  /** full=换账号全量 / incremental=增量 / backfill=补全 / days=仅最近 N 天 */
  mode: SyncRun['mode'];
  /** 仅 mode='days' 时有值：窗口天数 */
  days?: number;
  /** 单次同步新增上限（前端文案「最多 N 条」用） */
  maxSubmissions?: number;
  /** fetching=正在拉取提交 / saving=正在写入数据库 */
  phase: 'fetching' | 'saving';
  /** ISO8601 UTC */
  startedAt: string;
  /** 已进行时长（服务端算好，避免客户端时钟偏差） */
  elapsedMs: number;
  /**
   * 本窗口内该站点的请求数（节流层按域名统计的增量）。
   * 口径是「站点」而非「本次同步」：同期难度回填打同一站点也会计入——
   * 这正是风控关心的量，且无论如何都证明请求在流动。
   */
  siteRequests: number;
  /** 距最后一次真实请求的毫秒数；一个请求都还没发出时为 null（等待上游） */
  lastRequestAgoMs: number | null;
}

/** 一键同步整批进度里已完成的一项 */
export interface SyncProgressBatchItem {
  platform: PlatformId;
  status: 'ok' | 'failed';
  imported: number;
  /** 失败时的首条错误信息（与 sync_runs.error_message 同源） */
  error?: string;
}

/** 一键同步（POST /api/sync/all）的整批进度：顺序执行，前端据此画出「待同步/已完成」 */
export interface SyncProgressBatch {
  /** 本批要同步的平台（顺序即执行顺序） */
  platforms: PlatformId[];
  /** 当前正在同步的平台；全部结束时为 null */
  current: PlatformId | null;
  completed: SyncProgressBatchItem[];
  startedAt: string;
  elapsedMs: number;
  /**
   * 整批结束时刻（ISO8601）；null = 仍在进行。
   *
   * 结束时**不立即从快照里消失**：否则最后一步「第 N 个平台完成」与「批次清空」发生在同一刻，
   * 前端永远看不到「已完成 N/M」的收尾状态。服务端短期保留（约 5 分钟）后自行丢弃，
   * 前端在收到 finishedAt 后展示一小段时间再隐藏。
   */
  finishedAt: string | null;
}

/** GET /api/sync/progress 响应：无同步时 jobs 为空数组、batch 为 null（前端据此自停轮询） */
export interface SyncProgressSnapshot {
  jobs: SyncProgressJob[];
  batch: SyncProgressBatch | null;
}

/** 平台同步健康状态（按最近一次同步推导，供同步中心徽章展示） */
export type PlatformSyncStatus =
  | 'healthy'
  | 'degraded'
  | 'auth_expired'
  | 'rate_limited'
  | 'schema_changed'
  | 'manual_required'
  | 'never';

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
  /**
   * 百分数（14.3 表示 14.3%），与后端 `analysis/stats.rate()` 同量纲。
   * **不是** 0–1 比例：消费方请用 `client/src/ui.ts` 的 `pct()` 格式化，
   * 不要再乘 100（历史缺陷：设置页双口径对比弹窗乘了第二次，显示成 1430%）。
   */
  acRate: number;
  /** 同上：百分数（45.6 表示 45.6%） */
  avgAcRate: number;
  /** avg - self，正值表示弱于总体平均；单位为**百分点**（31.3 = 高 31.3 个百分点） */
  gap: number;
  /**
   * 排序得分 = gap × 概念信息量权重（见 knowledge/conceptStats.ts）。
   * 低信息量的膨胀标签（如低难度题的「数学」覆盖 24.8%）被降权后排到后面；
   * gap 本身保持不变，仍是原始可观测的 AC 率差值。
   */
  rank: number;
  solved: number;
}

export interface DifficultyWeakness {
  bucket: string;
  attempts: number;
  ac: number;
  /** 百分数（14.3 = 14.3%），非 0–1 比例 */
  acRate: number;
  /** 百分点差值（31.3 = 高 31.3 个百分点） */
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
  /** 已在复习队列时为复习条目 id（用于移出），否则 null */
  reviewItemId: number | null;
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
  /** 候选题不足时放宽了哪条去重规则（冷却窗口/复习排除）；null 表示按标准规则出题 */
  relaxed: string | null;
}

/** 能力值构成明细（透出给 UI / AI，便于理解计算值从哪来） */
export interface AbilityLevelDetail {
  /** 难度基数：窗口内解题证据的加权中位数（含离群折扣）；无任何带难度 AC 时为 null */
  base: number | null;
  /** 通过率校准修正（同段难度 AC 率推导，±150 封顶） */
  performanceAdj: number;
  /** 基数 + 校准后的目标值（未做平滑） */
  target: number;
  /** 自上次校准以来的新练习提交数（含失败；0 = 能力值保持不动） */
  newEvidence: number;
  /** 窗口内参与估算的解题证据条数 */
  samples: number;
}

export interface TodayPlan {
  date: string;
  /**
   * 估算能力值（加权解题证据模型：难度加权中位数 × 独立完成度降权 × 通过率校准，
   * 再做有状态的缓慢校准；千人千面的三档分档基准）
   */
  level: number;
  /** 能力值构成明细（缺失时 UI 不展示构成） */
  levelDetail?: AbilityLevelDetail;
  /** 标准冷却窗口：近 N 天推荐过的题不再出现 */
  cooldownDays: number;
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

// ---------- 知识点掌握度地图（刷题数据 × 模板课程联动） ----------

/**
 * 标签 → 规范名的同义词体系（含可选的 taxonomy code 锚定）。
 *
 * 实现已移至 `./tags.ts`：把「平台英文标签 / 课程中文 tag / 常见别名」组织为同义词组，
 * 带 code 的组名严格等于 taxonomy 的 name，从结构上消除「归并目标名不存在」导致的
 * 同一知识点分裂（历史缺陷：'binary search' → 「二分」，而体系里叫「二分查找」）。
 * 此处仅做 re-export，保持既有 import 路径（'.../shared/src/index.ts'）不变。
 */
export {
  TAG_SYNONYM_GROUPS,
  TAG_ALIAS_TO_CANONICAL,
  canonicalTag,
  expandTag,
  codeOfTag,
  codeOfCanonicalName,
  coarseCategoryNames,
  type TagSynonymGroup,
} from './tags.ts';

// ---------- 平台凭据表单字段（client 渲染 + server 单字段合并校验的共享真相） ----------

export {
  COOKIE_FIELDS,
  CREDENTIAL_UA_FIELDS,
  cookieFieldsOf,
  cookieOnlyFieldsOf,
  cookieFieldValue,
  buildCookieItem,
  mergeCookieFields,
  splitCookieFields,
  type CookieFieldDef,
} from './credentials.ts';

// ---------- 标签净化：过滤非算法能力维度的噪声标签 ----------

/** CF 特殊题型标记（*special / *2200 等，非算法维度） */
const CF_NOISE_PREFIX = '*';

/** 赛事/来源/机构类关键词（洛谷 tag 字典"来源"分区 + 各地区赛事） */
const CONTEST_SOURCE_KEYWORDS = [
  '蓝桥杯', 'NOIP', 'NOI', '省选', '联赛', '洛谷', 'Codeforces', 'AtCoder',
  'ABC', 'ARC', 'AGC', '牛客', 'GESP', 'USACO', 'IOI', 'ICPC', 'COCI', 'POI',
  'NERC', 'CERC', 'eJOI', 'Code+', '夏令营', '导刊', '青少年', '信息与未来',
];

/** 省份/地区名（洛谷 tag 字典中的地区分区） */
const REGION_TAGS = new Set([
  '北京', '天津', '安徽', '江苏', '湖南', '福建', '浙江', '上海', '广东',
  '四川', '重庆', '河北', '河南', '山东', '陕西', '湖北',
]);

/** 其他明确非算法能力维度的标签（题型事务/评分方式/教学分类） */
const MISC_NOISE_TAGS = new Set([
  'O2优化', 'Special Judge', 'SPJ', '提交答案', '提答', '模板题', '入门',
]);

/** 纯年份（如 1998 / 2026）：题目来源年份 */
function isYearTag(tag: string): boolean {
  return /^(19|20)\d{2}$/.test(tag);
}

/** 含赛事/来源关键词的标签（如「蓝桥杯省赛」「NOIP 普及组」「各省省选」） */
function isContestSourceTag(tag: string): boolean {
  return CONTEST_SOURCE_KEYWORDS.some((k) => tag.includes(k));
}

/** 判断单个标签是否为噪声（非算法能力维度） */
export function isNoiseTag(tag: string): boolean {
  const t = tag.trim();
  if (t === '') return true;
  if (t.startsWith(CF_NOISE_PREFIX)) return true;
  if (isYearTag(t)) return true;
  if (isContestSourceTag(t)) return true;
  if (REGION_TAGS.has(t)) return true;
  if (MISC_NOISE_TAGS.has(t)) return true;
  return false;
}

/** 过滤标签数组，仅保留算法能力维度标签 */
export function filterNoiseTags(tags: string[]): string[] {
  return tags.filter((t) => !isNoiseTag(t));
}

/** 掌握度档位：0 未开始 / 1 接触 / 2 入门 / 3 掌握 / 4 熟练 */
export type MasteryLevel = 0 | 1 | 2 | 3 | 4;

export const MASTERY_LEVEL_LABELS: Record<MasteryLevel, string> = {
  0: '未开始',
  1: '接触',
  2: '入门',
  3: '掌握',
  4: '熟练',
};

export interface MasteryTemplateLink {
  id: string;
  name: string;
  categoryKey: string;
  categoryName: string;
  status: 'todo' | 'learning' | 'mastered';
}

export interface MasteryPoint {
  tag: string;
  /** 知识点 code（taxonomy 口径的点才有；tag 口径回退点无此字段） */
  code?: string;
  solved: number;
  attempts: number;
  acRate: number;
  /** 全部提交的总体 AC 率（弱项 gap 基准，与弱项画像一致） */
  avgAcRate: number;
  /** avgAcRate - acRate，正值表示弱于自身平均 */
  gap: number;
  level: MasteryLevel;
  /** 近 8 周通过题数（近期活跃度） */
  recentSolved: number;
  templates: MasteryTemplateLink[];
}

export interface MasteryReport {
  generatedAt: string;
  points: MasteryPoint[];
}

// ---------- 自建知识点管线（taxonomy + L1 规则 / L2 AI / L3 人工） ----------

/**
 * 标注来源：tag=题源标签映射（含粗粒度）/ rule=L1 标题规则 /
 * ai=L2 批量模型分类 / manual=L3 人工校正（永不被重跑覆盖）。
 * 同 code 冲突时的优先级：manual > ai > rule > tag（tag 层只补空缺，见 tagAnnotate.ts）。
 */
export type KnowledgeSource = 'tag' | 'rule' | 'ai' | 'manual';

/** 单题单个知识点的标注条目（problem_keypoints 行 / JSONL 内嵌结构） */
export interface KnowledgePointEntry {
  /** taxonomy code，如 basic.binary-search（稳定不可改） */
  code: string;
  /** 展示名（自 taxonomy 反规范化，启动重载时刷新） */
  name: string;
  confidence: number;
  source: KnowledgeSource;
  /** 溯源：rule#rNNN / ai:model名 / manual */
  method: string;
}

/** JSONL 落盘格式：每行一题，源真相（可审计、可重建 SQLite 索引） */
export interface KnowledgeAnnotation {
  platform: PlatformId;
  problemKey: string;
  knowledgePoints: Array<Omit<KnowledgePointEntry, 'name'>>;
  taxonomyVersion: number;
  pipelineVersion: number;
  /** ISO8601 UTC */
  annotatedAt: string;
}

/** 覆盖率报告（GET /api/knowledge/coverage） */
export interface KnowledgeCoverage {
  total: number;
  /** 有 ≥1 个达到统计阈值标注的题数 */
  annotated: number;
  /** 覆盖率百分数（0-100，保留 1 位小数；6.5 即 6.5%） */
  coverage: number;
  /** 有标注但全部低于统计阈值的题数 */
  lowConfidenceOnly: number;
  /** 各来源覆盖题数；AI 已退出清洗模块，ai 恒为 0 */
  bySource: Record<KnowledgeSource, number>;
  /** 未标注题数（统计端回退净化 tag，计入「未覆盖」桶） */
  uncovered: number;
  taxonomyVersion: number;
  /** 生效管线版本（= 代码版本 × 1000 + rules.json 版本，规则表改动即自动变化） */
  pipelineVersion: number;
  /** rules.json 版本 */
  rulesVersion: number;
  /** 统计端生效的置信度阈值（设置页可调，默认 0.6） */
  threshold: number;
}

/** 双口径对比单项（GET /api/knowledge/compare）：tag 口径 vs 知识点口径弱项 top */
export interface KnowledgeCompareReport {
  generatedAt: string;
  threshold: number;
  tagCaliber: WeaknessItem[];
  knowledgeCaliber: WeaknessItem[];
  /** 知识点口径中因无标注回退 tag 的「未覆盖」桶统计（null = 全部有标注）；acRate 为百分数（43.3 = 43.3%） */
  uncovered: { attempts: number; ac: number; acRate: number } | null;
}

// ---------- 赛前提醒 ----------

export interface ContestReminderConfig {
  enabled: boolean;
  /** 开赛前多少分钟提醒（5-120） */
  minutesBefore: number;
}

// ---------- 平台难度 → CF rating 统一标尺（唯一真源） ----------

export {
  CF_RATING_MIN,
  CF_RATING_MAX,
  LUOGU_LEVEL_NAMES,
  LUOGU_LEVEL_TO_RATING,
  JISUANKE_LEVEL_NAMES,
  JISUANKE_LEVEL_TO_RATING,
  ATCODER_ANCHORS,
  LEETCODE_TIER_TO_RATING,
  HYDRO_LEVEL_TO_RATING,
  atcoderThetaToRating,
  nowcoderScoreToRating,
  parseNativeDifficulty,
  toCfRating,
  nativeDifficultyLabel,
  difficultyFields,
  cfRatingTitle,
  type DifficultyScale,
  type DifficultyParse,
} from './difficulty.ts';

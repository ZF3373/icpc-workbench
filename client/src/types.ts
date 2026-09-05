// 前端 API 响应类型（与 server/src/analysis/*、plans/*、routes/* 对齐）
import type { PlatformId, SyncResult, WeaknessProfile } from '../../shared/src/index.ts'

export interface CountStat {
  attempts: number
  ac: number
  acRate: number
}

export interface PlatformStat extends CountStat {
  platform: PlatformId
  solved: number
}

export interface DifficultyStat extends CountStat {
  bucket: string
}

export interface TagStat extends CountStat {
  tag: string
  solved: number
}

export interface OverallStats extends CountStat {
  solvedProblems: number
  byPlatform: PlatformStat[]
  byDifficulty: DifficultyStat[]
  byTag: TagStat[]
}

export type { WeaknessProfile }

export interface TrendPoint {
  week: string
  attempts: number
  ac: number
  solved: number
  avgDifficulty: number | null
  difficultyDist: Record<string, number>
}

export interface PlanListItem {
  id: number
  title: string
  goal: string
  start_date: string
  end_date: string
  source: 'ai' | 'template' | 'manual'
  created_at: string
  task_count: number
  checked_count: number
}

export interface PlanTask {
  id: number
  task_date: string
  title: string
  kind: 'practice' | 'review' | 'topic' | 'contest'
  url: string | null
  note: string | null
  platform: PlatformId | null
  problem_key: string | null
  problem_title: string | null
  problem_url: string | null
  checked: number | null
}

export interface PlanDetail extends Omit<PlanListItem, 'task_count' | 'checked_count'> {
  tasks: PlanTask[]
}

export interface GenerateResult {
  planId: number
  source: 'ai' | 'template'
  title: string
}

export interface PlanPackage {
  profile: WeaknessProfile
  trend: TrendPoint[]
  problems: Array<{
    platform: PlatformId
    problemKey: string
    title: string
    difficulty: number | null
    tags: string[]
    url: string | null
  }>
  prompt: string
  meta: { startDate: string; days: number; generatedAt: string }
}

export type { SyncResult }

export interface DayTask {
  id: number
  task_date: string
  title: string
  kind: PlanTask['kind']
  url: string | null
  note: string | null
  platform: PlatformId | null
  problem_key: string | null
  problem_title: string | null
  problem_url: string | null
  checked: number | null
}

export interface DayPlanInfo {
  date: string
  total: number
  checked: number
}

export interface StreakInfo {
  current: number
  longest: number
  totalDays: number
}

export interface ReminderConfig {
  enabled: boolean
  time: string // HH:MM（24 小时制）
}

export interface UpdateCommit {
  sha: string
  shortSha: string
  message: string
  date: string
  page: string
}

export interface UpdateDownloadUrls {
  shell: string
  core: string
  checksums: string
}

export interface UpdateInfo {
  ok: boolean
  current: string
  buildCommit: string
  latest: string | null
  hasUpdate: boolean
  releasePage: string | null
  notes: string | null
  commit: UpdateCommit | null
  hasCommitUpdate: boolean
  channel: 'stable' | 'commit' | null
  download: UpdateDownloadUrls | null
  canSelfUpdate?: boolean
  message?: string
}

export interface UpdateProgress {
  phase: 'idle' | 'downloading' | 'verifying' | 'staged' | 'error'
  received: number
  total: number
  error: string | null
}

// ---------- 复习库 / 今日训练 / 赛事中心（与 shared 类型对齐） ----------
export type {
  ContestInfo,
  ReviewFeedback,
  ReviewItem,
  TodayBand,
  TodayBandKey,
  TodayPlan,
  TodayProblem,
} from '../../shared/src/index.ts'

// ---------- 模板库（内置课程 + 个人进度） ----------
export type TemplateStatus = 'todo' | 'learning' | 'mastered'

export interface TemplateExampleInfo {
  platform: 'codeforces' | 'luogu'
  key: string
  title: string
  url: string
  /** 是否已入库题目管理 */
  inBank?: boolean
  /** 是否已 AC（基于同步的提交记录） */
  ac?: boolean
}

export interface TemplateContentInfo {
  code: string | null
  idea: string | null
  complexity: string | null
  url: string | null
}

export interface TemplateItemInfo {
  /** 自建模板（c-<dbId>） */
  custom?: boolean
  id: string
  name: string
  difficulty: number
  tags: string[]
  /** 大纲要点（仅内置条目）：这条模板位需要覆盖什么 */
  outline?: string
  code: string
  idea: string
  complexity: string
  useCases: string
  pitfalls: string
  examples: TemplateExampleInfo[]
  /** 自建模板的出处 / 讲解链接 */
  url?: string | null
  /** 用户为内置条目写入的模板内容（自建模板内容直接在自身字段上） */
  content: TemplateContentInfo | null
  status: TemplateStatus
  note: string | null
}

export interface TemplateCategoryInfo {
  key: string
  name: string
  description: string
  templates: TemplateItemInfo[]
}

export interface TemplatesResponse {
  customCount: number
  total: number
  mastered: number
  learning: number
  next: { id: string; name: string; difficulty: number } | null
  categories: TemplateCategoryInfo[]
}

// ---------- 掌握度地图 / 赛前提醒（与 shared 类型对齐） ----------
export type {
  ContestReminderConfig,
  MasteryLevel,
  MasteryPoint,
  MasteryReport,
  MasteryTemplateLink,
} from '../../shared/src/index.ts'

export { MASTERY_LEVEL_LABELS } from '../../shared/src/index.ts'

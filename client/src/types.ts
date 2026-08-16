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

export interface UpdateInfo {
  ok: boolean
  current: string
  latest: string | null
  hasUpdate: boolean
  releasePage: string | null
  notes: string | null
  message?: string
}

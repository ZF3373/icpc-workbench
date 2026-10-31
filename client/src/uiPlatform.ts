/**
 * 平台品牌色 / 平台名 / 训练任务类型语义（原 ui.ts 第三节+三·五节）。
 * 聚合入口仍是 ui.ts。
 */
import { PLATFORMS } from '../../shared/src/index.ts'
import type { PlatformId } from '../../shared/src/index.ts'

/** 平台展示色（彩色圆点标识用，与后端无关；暗色底下的高可读版本） */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  codeforces: '#58a3ff',
  atcoder: '#f2b75b',
  luogu: '#45d5e5',
  nowcoder: '#69d7a5',
  vjudge: '#49b9aa',
  daimayuan: '#f2965c',
  leetcode: '#ffa116',
  jisuanke: '#7ee0a3', // 计蒜客品牌绿（暗色底可读版）
  qoj: '#b18cff', // QOJ / Universal Cup：暗色底可读的紫罗兰
  dashoj: '#e879a6', // DashOJ：暗色底可读的玫红（与代码源橙区分）
}

// id→name 的 O(1) 索引：platformName 在列表渲染等热路径被逐行调用，
// 每次 PLATFORMS.find 线性扫（menuConfig 同场景已用 Map，此处对齐口径）
const PLATFORM_NAME_BY_ID = new Map<string, string>(PLATFORMS.map((p) => [p.id as string, p.name]))

export function platformName(id: PlatformId): string {
  return PLATFORM_NAME_BY_ID.get(id) ?? id
}

/* ============================================================
   三·五、训练任务类型（kind）单一真源
   ============================================================ */

/** 训练任务的四种类型（与 shared 的 TodayPlanTask.kind / types.ts 的 PlanTask.kind 同口径） */
export type TaskKind = 'practice' | 'review' | 'topic' | 'contest'

/** kind → 中文标签（Plans 的 kindTag 与 Calendar 的 KIND_LABEL 原为两份独立实现） */
export const KIND_LABEL: Record<TaskKind, string> = {
  practice: '练习',
  review: '回顾',
  topic: '专题',
  contest: '模拟赛',
}

/** kind → antd Tag 配色（同上，两份实现已漂移风险高）。回顾用 gold：全站去紫（见 UI 优化方案），四类型蓝/金/青/橙红色环分布均匀 */
export const KIND_COLOR: Record<TaskKind, string> = {
  practice: 'geekblue',
  review: 'gold',
  topic: 'cyan',
  contest: 'volcano',
}

/** 新建计划时的类型下拉选项 */
export const KIND_OPTIONS: Array<{ value: TaskKind; label: string }> = [
  { value: 'practice', label: KIND_LABEL.practice },
  { value: 'review', label: KIND_LABEL.review },
  { value: 'topic', label: KIND_LABEL.topic },
  { value: 'contest', label: KIND_LABEL.contest },
]

import type { ParticipatedContest } from '../types'

/**
 * 赛后复盘入口的纯文案逻辑（与 Assistant.tsx 解耦，便于单测）：
 * 复盘请求文本、`?contest=` 跳转失败的提示。
 */

/** 未指定具体比赛时的通用复盘请求（`?contest=` 推导失败时的兜底预填） */
export const REVIEW_REQUEST_TEXT =
  '请复盘这场比赛：结合我的提交记录点评整体发挥与逐题表现，指出卡点与改进方向，并给出补题建议。'

/** 比赛展示名：无赛名时回退「平台 · 比赛号」 */
function contestLabel(contest: ParticipatedContest): string {
  return contest.name ?? `${contest.platform} · ${contest.contestId}`
}

/** 赛时/补题拆分标注：赛时数未知或与当前持平（没有补题可看）时不加 */
function contestAcSplit(contest: ParticipatedContest): string {
  const inContest = contest.inContestAcProblemCount
  if (inContest === null || inContest >= contest.acProblemCount) return ''
  return `（赛时 AC ${inContest}、赛后补题 ${contest.acProblemCount - inContest}）`
}

/**
 * 带**本场关键事实**的复盘请求：把 AI 本来要反问的事（哪一场、做了几题、
 * 有没有同步到提交）直接写进请求里，省一轮往返。
 * 零提交场次（`joined-list` 参赛记录但本地无提交）显式说明「没有同步到提交记录」，
 * 避免 AI 顺着空数据编出并不存在的提交明细。
 */
export function reviewRequestText(contest: ParticipatedContest): string {
  const facts =
    contest.submissionCount > 0
      ? `本场关键事实：AC ${contest.acProblemCount}/${contest.problemCount} 题${contestAcSplit(contest)}，共 ${contest.submissionCount} 次提交。`
      : '本场关键事实：我没有同步到该场的提交记录（可能尚未同步该平台，或该场确实一题未交）。'
  return `请复盘这场比赛（${contestLabel(contest)}）：${facts}请结合提交记录点评整体发挥与逐题表现，指出卡点与改进方向，并给出补题建议。`
}

/**
 * `?contest=<key>` 从赛事中心跳转过来、但本地推导不出该场时的提示。
 * **不静默丢弃**：明确说明原因，并保留预填的复盘请求文本，让用户能手动选场。
 */
export function contestJumpWarning(key: string): string {
  return `未能从提交记录推导出比赛「${key}」：可能尚未同步该平台的提交记录，或该场数据已被清理。已保留复盘请求文本，可在左侧手动选择比赛。`
}

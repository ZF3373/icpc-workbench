/**
 * 模板难度段位：difficulty 1-5 的展示语义。
 *
 * 存储值仍是 1-5 的整数（含用户自建模板），这里只提供唯一一份「数值 → 段位名」口径，
 * 避免模板库页 / 自建表单 / Markdown 导出 / PDF 导出各写一套字面量。
 *
 * 段位口径取自 XCPC 算法知识思维导图的节点配色分级：
 * 入门=不会就写不出任何题；铜牌=区域赛正常题的基本盘；银牌=进奖项线要会；
 * 金牌 / 争冠=冲牌位才需要投入的板子。
 */
export const TEMPLATE_TIER_LABELS = ['入门', '铜牌', '银牌', '金牌', '争冠'] as const;

export type TemplateTier = (typeof TEMPLATE_TIER_LABELS)[number];

/** 越界与非整数值一律夹到 1-5，返回值域内的段位名 */
export function templateTierLabel(difficulty: number): TemplateTier {
  const n = Math.min(5, Math.max(1, Math.round(Number(difficulty) || 1)));
  return TEMPLATE_TIER_LABELS[n - 1];
}

/** 星标 + 段位，供导出与 tooltip 复用：★★★☆☆ 银牌 */
export function templateTierBadge(difficulty: number): string {
  const n = Math.min(5, Math.max(1, Math.round(Number(difficulty) || 1)));
  return `${'★'.repeat(n)}${'☆'.repeat(5 - n)} ${templateTierLabel(n)}`;
}

/** 自建模板表单的下拉选项（1-5 与段位名一起给，避免用户猜数字含义） */
export const TEMPLATE_TIER_OPTIONS = TEMPLATE_TIER_LABELS.map((label, i) => ({
  value: i + 1,
  label: `${i + 1} · ${label}`,
}));

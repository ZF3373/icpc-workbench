/**
 * ICPC/CCPC 赛场文本归一（社区数据集赛场键、RankLand `uk`/名称、QOJ 比赛名三处共用一份规则）。
 *
 * 单独成模块的原因：`analysis/icpcBoard.ts`（榜单匹配）与 `analysis/xcpcFacets.ts`（属性识别与打分）
 * 都要用它，放在任一方都会形成循环依赖。
 */

/**
 * 匹配用文本归一化：小写、字母与数字边界切分、非字母数字（保留中文）折叠为空格。
 * 切分边界让 `icpc2026preliminary-1` 与 `icpc-2026-preliminary-1` 归一化后完全相同 ——
 * 社区数据集的赛场键与 RankLand 的 `uk` 只差分隔符风格，不该因此匹配失败。
 */
export function normalizeMatchText(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

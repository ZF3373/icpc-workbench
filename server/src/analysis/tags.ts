/**
 * 标签净化：过滤非算法能力维度的"噪声标签"。
 * 这些标签来自平台题库的来源/赛事实务维度，混入弱项画像会误导训练方向
 * （实测案例：洛谷「2026」「蓝桥杯省赛」、CF「*special」占据弱项 top8 的半数）。
 * 标签全集以真实库洛谷 117 个 tag 校准，避免误杀算法标签。
 */

/** CF 特殊题型标记（*special / *2200 等，非算法维度） */
const CF_NOISE_PREFIX = '*';

/** 赛事/来源/机构类关键词（洛谷 tag 字典"来源"分区 + 各地区赛事） */
const CONTEST_SOURCE_KEYWORDS = [
  '蓝桥杯',
  'NOIP',
  'NOI',
  '省选',
  '联赛',
  '洛谷',
  'Codeforces',
  'AtCoder',
  'ABC',
  'ARC',
  'AGC',
  '牛客',
  'GESP',
  'USACO',
  'IOI',
  'ICPC',
  'COCI',
  'POI',
  'NERC',
  'CERC',
  'eJOI',
  'Code+',
  '夏令营',
  '导刊',
  '青少年',
  '信息与未来',
];

/** 省份/地区名（洛谷 tag 字典中的地区分区） */
const REGION_TAGS = new Set([
  '北京',
  '天津',
  '安徽',
  '江苏',
  '湖南',
  '福建',
  '浙江',
  '上海',
  '广东',
  '四川',
  '重庆',
  '河北',
  '河南',
  '山东',
  '陕西',
  '湖北',
]);

/** 其他明确非算法能力维度的标签（题型事务/评分方式/教学分类） */
const MISC_NOISE_TAGS = new Set([
  'O2优化',
  'Special Judge',
  'SPJ',
  '提交答案',
  '提答',
  '模板题',
  '入门',
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

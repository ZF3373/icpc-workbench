/**
 * ICPC/CCPC 赛场「属性识别 + 榜单匹配打分」。
 *
 * 为什么需要这一层：本项目原先只按**社区数据集的赛场键文本**去匹配 RankLand 榜单
 * （`matchRanklandBoard`），那要求题目先在 `xcpcrating` 目录里 —— 目录没收录的题
 * （实测 `2513-14301`，2025 ICPC 亚洲东区网络赛第一场）连赛场都不知道，链路第一环就断了。
 * 参考项目 OJ_Insight 的做法（`src-tauri/src/xcpc/matcher.rs` 的
 * `classify_series/classify_stage/classify_site/contest_round/board_match_score`）：
 * 从**比赛名称**里识别年份 / 系列 / 赛段 / 赛站 / 场次，再用这些属性给榜单目录打分匹配。
 * 名称来自 QOJ 比赛页标题（见 analysis/qojContest.ts），不需要预先存在社区目录。
 *
 * 打分口径（与 OJ_Insight 同构，阈值按本项目实测收敛）：
 *   year 命中 +5（**必须命中**，否则直接排除）
 *   场次一致 +8（仅网络赛要求；两边都解析不出场次时按 0 处理）
 *   系列 ICPC/CCPC +4（文本里必须出现对应字样，否则排除）；省赛/市赛 +3
 *   赛站 +6（非「全国」时**必须**命中赛站别名，否则排除）
 *   赛段 +4（网络赛/邀请赛/总决赛/省市级要求命中对应词，否则排除）
 *   比赛名与榜单文本词元重合 +3
 * 最终要求 **≥ 10 分且最优唯一**，否则判为「匹配不上」（宁可未知，也不猜）。
 */
import { normalizeMatchText } from './xcpcText.ts';

/** 比赛属性（全部由名称推导；解析不出的字段取「未知」而非猜测） */
export interface ContestFacets {
  /** 4 位年份；解析不出为 '未知' */
  year: string;
  /** 系列：ICPC / CCPC / 省赛（可并存）；都没有则为 ['其他'] */
  series: string[];
  /** 赛段：网络赛 / 邀请赛 / 总决赛 / 区域赛 / 分站赛 / 省赛 / 市赛 / 女生赛 / 高职赛 / 地区赛 / 其他 */
  stage: string;
  /** 赛站（城市/省份）；识别不出的全国性比赛为 '全国' */
  site: string;
}

/** 年份：名称里第一个 19xx/20xx */
export function extractYear(name: string): string {
  return /(?:19|20)\d{2}/.exec(name)?.[0] ?? '未知';
}

/** 中文数字 / 罗马数字 / 阿拉伯数字 → 序号（1..99）；解析不出为 null */
export function ordinalNumber(raw: string): number | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n > 0 && n < 100 ? n : null;
  }
  const roman = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
  const romanIndex = roman.indexOf(text.toLowerCase());
  if (romanIndex >= 0) return romanIndex + 1;
  const digit = (ch: string): number | null => {
    const i = '一二三四五六七八九'.indexOf(ch);
    return i >= 0 ? i + 1 : null;
  };
  const chars = [...text];
  if (chars.length === 1) return digit(chars[0]!);
  if (chars.length === 2 && chars[0] === '十') {
    const u = digit(chars[1]!);
    return u === null ? null : 10 + u;
  }
  if (chars.length === 2 && chars[1] === '十') {
    const t = digit(chars[0]!);
    return t === null ? null : t * 10;
  }
  if (chars.length === 3 && chars[1] === '十') {
    const t = digit(chars[0]!);
    const u = digit(chars[2]!);
    return t === null || u === null ? null : t * 10 + u;
  }
  return null;
}

/**
 * 场次（网络赛第几场）。识别 `(I) / (II) / Online Contest 2 / preliminary-1 / qualification 2 /
 * 第X场 / 第X轮`。**只有唯一一个候选时才算数**：`2026 ICPC Asia EC网络预选赛 - 第一场`
 * 这类两边都能解析；解析出多个不同数字时返回 null（宁可判不了，也不要错配兄弟场）。
 */
export function contestRound(text: string): number | null {
  const found = new Set<number>();
  const patterns: RegExp[] = [
    /[（(]\s*([ivx]+|\d{1,2})\s*[)）]/gi,
    /(?:online(?:\s*[-_]?\s*(?:qualification|contest))?|preliminary|qualification\s*[-_]?\s*round|round)\s*[-_: ]\s*([ivx]+|\d{1,2})(?![a-z0-9])/gi,
    /第\s*([一二三四五六七八九十\d]+)\s*[场轮]/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = ordinalNumber(m[1] ?? '');
      if (n !== null) found.add(n);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** 系列识别（可并存：CCPC 的省赛同时算 CCPC 与 省赛） */
export function classifySeries(name: string): string[] {
  const low = name.toLowerCase();
  const out: string[] = [];
  if (low.includes('icpc')) out.push('ICPC');
  if (low.includes('ccpc') || name.includes('中国大学生程序设计竞赛')) out.push('CCPC');
  if (localStage(name) !== null) out.push('省赛');
  return out.length > 0 ? out : ['其他'];
}

/** 省/市级别的补充判据（很多省赛名称里没有 provincial 字样） */
function localStage(name: string): string | null {
  const low = name.toLowerCase();
  if (name.includes('东北地区') || low.includes('northeast collegiate')) return '地区赛';
  if (low.includes('provincial') || low.includes('province programming') || name.includes('省赛') || name.includes('省大学生')) {
    return '省赛';
  }
  if (name.includes('市赛') || name.includes('市大学生')) return '市赛';
  if (low.includes('collegiate programming contest')) {
    const site = classifySite(name);
    if (['北京', '上海', '天津', '重庆'].includes(site)) return '市赛';
    if (site !== '全国' && !['香港', '澳门'].includes(site)) return '省赛';
  }
  return null;
}

/** 赛段识别 */
export function classifyStage(name: string): string {
  const low = name.toLowerCase();
  if (low.includes('online') || name.includes('网络')) return '网络赛';
  if (low.includes('invitational') || name.includes('邀请赛')) return '邀请赛';
  if (low.includes('final') || name.includes('总决赛')) return '总决赛';
  if (low.includes('women') || name.includes('女生')) return '女生赛';
  if (low.includes('vocational') || name.includes('高职')) return '高职赛';
  const local = localStage(name);
  if (local !== null) return local;
  if (low.includes('regional') || name.includes('区域赛')) return '区域赛';
  if (low.includes('site') || name.includes('站')) return '分站赛';
  return '其他';
}

/** 赛站候选（中文名 → 英文别名，榜单里两种写法都可能出现） */
const SITE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['Northeast', '东北'], ['Beijing', '北京'], ['北京', '北京'], ['Changchun', '长春'], ['长春', '长春'],
  ['Chengdu', '成都'], ['成都', '成都'], ['Chongqing', '重庆'], ['重庆', '重庆'], ['Fujian', '福建'],
  ['广东', '广东'], ['Guangzhou', '广州'], ['广州', '广州'], ['Hangzhou', '杭州'], ['Harbin', '哈尔滨'],
  ['哈尔滨', '哈尔滨'], ['Hefei', '合肥'], ['Hong Kong', '香港'], ['Jinan', '济南'], ['济南', '济南'],
  ['Kunming', '昆明'], ['Nanchang', '南昌'], ['Nanjing', '南京'], ['南京', '南京'], ['Qingdao', '青岛'],
  ['Shanghai', '上海'], ['上海', '上海'], ['Shenyang', '沈阳'], ['沈阳', '沈阳'], ['Wuhan', '武汉'],
  ['武汉', '武汉'], ["Xi'an", '西安'], ['Xian', '西安'], ['西安', '西安'], ['Zhengzhou', '郑州'],
  ['郑州', '郑州'], ['Zhejiang', '浙江'], ['Shenzhen', '深圳'], ['深圳', '深圳'], ['Changsha', '长沙'],
  ['长沙', '长沙'], ['Guilin', '桂林'], ['桂林', '桂林'], ['Qinhuangdao', '秦皇岛'], ['秦皇岛', '秦皇岛'],
  ['Xuzhou', '徐州'], ['徐州', '徐州'], ['Weihai', '威海'], ['威海', '威海'], ['Mianyang', '绵阳'],
  ['Xiamen', '厦门'], ['Yinchuan', '银川'], ['Jiaozuo', '焦作'], ['Nanning', '南宁'], ['Urumqi', '乌鲁木齐'],
  ['Ürümqi', '乌鲁木齐'], ['Fuzhou', '福州'], ['Anhui', '安徽'], ['安徽', '安徽'], ['福建', '福建'],
  ['Gansu', '甘肃'], ['甘肃', '甘肃'], ['Guangxi', '广西'], ['广西', '广西'], ['Guizhou', '贵州'],
  ['贵州', '贵州'], ['Hainan', '海南'], ['海南', '海南'], ['Hebei', '河北'], ['河北', '河北'],
  ['Henan', '河南'], ['河南', '河南'], ['Heilongjiang', '黑龙江'], ['黑龙江', '黑龙江'], ['Hubei', '湖北'],
  ['湖北', '湖北'], ['Hunan', '湖南'], ['湖南', '湖南'], ['Jilin', '吉林'], ['吉林', '吉林'],
  ['Jiangsu', '江苏'], ['江苏', '江苏'], ['Jiangxi', '江西'], ['江西', '江西'], ['Liaoning', '辽宁'],
  ['辽宁', '辽宁'], ['Inner Mongolia', '内蒙古'], ['内蒙古', '内蒙古'], ['Ningxia', '宁夏'], ['宁夏', '宁夏'],
  ['Qinghai', '青海'], ['青海', '青海'], ['Shandong', '山东'], ['山东', '山东'], ['Shanxi', '山西'],
  ['山西', '山西'], ['Shaanxi', '陕西'], ['陕西', '陕西'], ['Sichuan', '四川'], ['四川', '四川'],
  ['Tianjin', '天津'], ['天津', '天津'], ['Tibet', '西藏'], ['西藏', '西藏'], ['Xinjiang', '新疆'],
  ['新疆', '新疆'], ['Yunnan', '云南'], ['云南', '云南'], ['Macau', '澳门'], ['澳门', '澳门'],
];

/** 赛站：识别不出具体城市/省份时返回 '全国'（不是错误，而是「全国性比赛」） */
export function classifySite(name: string): string {
  const lower = name.toLowerCase().replace(/['’‘]/g, '');
  for (const [needle, label] of SITE_ALIASES) {
    if (name.includes(label)) return label;
    const n = needle.toLowerCase().replace('\'', '');
    for (let start = lower.indexOf(n); start >= 0; start = lower.indexOf(n, start + 1)) {
      // 完整词匹配：`Xiangtan` 不该被 `Xian` 命中
      const before = lower[start - 1];
      const after = lower[start + n.length];
      const isAlpha = (ch: string | undefined): boolean => ch !== undefined && /[a-z]/.test(ch);
      if (!isAlpha(before) && !isAlpha(after)) return label;
    }
  }
  return '全国';
}

/** 名称 → 比赛属性 */
export function contestFacets(name: string): ContestFacets {
  return {
    year: extractYear(name),
    series: classifySeries(name),
    stage: classifyStage(name),
    site: classifySite(name),
  };
}

/** 赛站别名（用于榜单文本匹配） */
export function siteAliases(site: string): string[] {
  const out: string[] = [];
  for (const [en, zh] of SITE_ALIASES) {
    if (zh === site) {
      out.push(normalizeMatchText(zh), normalizeMatchText(en));
    }
  }
  return [...new Set(out.filter((v) => v !== ''))];
}

/** 热身赛/练习赛：任何来源都不该拿它的榜单当正式成绩 */
export function isWarmup(text: string): boolean {
  const low = text.toLowerCase();
  return low.includes('warm up') || low.includes('warm-up') || low.includes('warmup') || low.includes('practice') || text.includes('热身');
}

/** 赛段对应的榜单文本关键词（网络赛/省赛等；缺一不可） */
function stageTerms(stage: string): string[] {
  switch (stage) {
    case '网络赛':
      return ['preliminary', 'online', 'qualification', '网络', '预选'];
    case '邀请赛':
      return ['invitational', '邀请'];
    case '总决赛':
      return ['final', '总决赛', '总决'];
    case '省赛':
    case '地区赛':
      return ['provincial', '省赛', '大学生程序设计', 'collegiate'];
    case '市赛':
      return ['city', '市赛', '大学生程序设计', 'collegiate'];
    default:
      return [];
  }
}

/** 非网络赛时用来排除「其实是网络赛/邀请赛/总决赛榜单」的词 */
const OTHER_STAGE_TERMS = ['preliminary', 'online', 'qualification', '网络', '预选', 'invitational', '邀请', 'final', '总决'];

/**
 * 属性 → 榜单文本打分。返回 null = 明确排除（年份/系列/赛站/赛段对不上）；
 * 返回数字 = 分数（调用方要求 ≥ 10 且唯一）。
 * @param qojName 该场比赛在 QOJ 上的完整名称（用于词元重合加分）
 */
export function facetMatchScore(
  facets: ContestFacets,
  boardText: string,
  qojName = '',
): number | null {
  if (isWarmup(boardText)) return null;
  const text = normalizeMatchText(boardText);
  if (text === '') return null;
  // 年份必须命中（年份是赛场的强标识；OJ_Insight 同口径）
  if (facets.year === '未知' || !text.includes(facets.year)) return null;

  let score = 5;

  // 场次：网络赛必须一致（第一场/第二场用词元打分完全并列，只能靠场次区分）
  if (facets.stage === '网络赛') {
    const want = contestRound(qojName);
    const got = contestRound(boardText);
    if (want !== null && got !== null) {
      if (want !== got) return null;
      score += 8;
    } else if (want !== null || got !== null) {
      // 一边有一边没有 → 无法确认是不是同一场，不猜
      return null;
    }
  }

  // 系列
  if (facets.series.includes('ICPC')) {
    if (!text.includes('icpc')) return null;
    score += 4;
  } else if (facets.series.includes('CCPC')) {
    if (!text.includes('ccpc') && !text.includes(normalizeMatchText('中国大学生程序设计竞赛'))) return null;
    score += 4;
  } else if (facets.series.includes('省赛')) {
    score += 3;
  }

  // 赛站：非全国性比赛必须命中赛站别名
  if (facets.site !== '全国') {
    if (siteAliases(facets.site).some((alias) => text.includes(alias))) score += 6;
    else return null;
  }

  // 赛段
  const terms = stageTerms(facets.stage);
  if (terms.length > 0) {
    if (terms.some((t) => text.includes(normalizeMatchText(t)))) score += 4;
    else return null;
  } else if (OTHER_STAGE_TERMS.some((t) => text.includes(normalizeMatchText(t)))) {
    // 区域赛/分站赛的榜单文本里出现了网络赛/邀请赛/总决赛字样 → 不是它
    return null;
  }

  // 名称词元重合（全国性区域赛没有赛站分可加，靠这一项过阈值）
  const qoj = normalizeMatchText(qojName);
  if (qoj !== '' && (text.includes(qoj) || qoj.includes(text))) score += 3;

  return score;
}

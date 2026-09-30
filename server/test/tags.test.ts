import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterNoiseTags, isNoiseTag } from '../src/analysis/tags.ts';

// 标签全集以真实库存活 tag 全集校准（2026-09-30 快照：dev 库 ∪ 内置题库，631 个存活 tag）

test('isNoiseTag catches source/contest/year/region tags', () => {
  // 年份
  for (const t of ['1998', '2026', '2013']) assert.equal(isNoiseTag(t), true, t);
  // 赛事/来源
  for (const t of ['蓝桥杯省赛', 'NOIP 普及组', 'NOIP 提高组', '各省省选', '洛谷原创', '洛谷月赛', '洛谷比赛', 'NOI 导刊', '福建省历届夏令营', '蓝桥杯青少年组']) {
    assert.equal(isNoiseTag(t), true, t);
  }
  // 2026-09 校准补漏：梦熊比赛曾以 unmapped tag 身份冲进弱项 top（用户反馈）
  for (const t of [
    '梦熊比赛', '语言月赛', '省赛/邀请赛', '高校校赛', '传智杯', '科大国创杯',
    '入门赛', '初中活动', '科创活动', '集训队互测',
    'Google Kick Start', 'Google Code Jam', 'CSP-J 入门级', 'CSP-S 提高级',
    'CCPC', 'THUPC', 'THUSC', 'THUWC', 'EC Final', 'CSPro', 'Moscow Olympiad',
    'NAC', 'AGM', 'WF', 'NWRRC', 'SEERC', 'SWERC',
    'JOI（日本）', 'JOISC/JOIST（日本）', 'PA（波兰）', 'KOI（韩国）',
    'ROIR（俄罗斯）', 'ROI（俄罗斯）', 'UOI（乌克兰）', 'BalticOI（波罗的海）',
    'NordicOI（北欧）', 'EGOI（欧洲/女生）', 'CEOI（中欧）', 'COI（克罗地亚）',
    'CCO（加拿大）', 'CCC（加拿大）', 'MCC/MCO（马来西亚）', 'PO（瑞典）', 'KTSC（韩国）',
    '语言题', '过关题目',
  ]) {
    assert.equal(isNoiseTag(t), true, t);
  }
  // 地区/国际赛事
  for (const t of ['北京', '天津', '安徽', 'COCI（克罗地亚）', 'POI（波兰）', 'NERC/NEERC', 'USACO', 'eJOI（欧洲）', 'CERC', 'Code+', 'GESP', '信息与未来']) {
    assert.equal(isNoiseTag(t), true, t);
  }
  // 地区/承办城市（2026-09 校准补齐）
  for (const t of ['台湾', '香港', '澳门', '吉林', '辽宁', '云南', '江西', '南京', '西安', '成都', '杭州', '哈尔滨', '济南', '昆明', '青岛', '横浜', '首尔']) {
    assert.equal(isNoiseTag(t), true, t);
  }
  // CF 特殊题型标记 / 事务性标签
  for (const t of ['*special', '*2200', 'Special Judge', '提交答案', 'O2优化', '模板题', '入门']) {
    assert.equal(isNoiseTag(t), true, t);
  }
});

test('isNoiseTag keeps real algorithm tags', () => {
  for (const t of [
    '动态规划 DP', '线性 DP', '状压 DP', '背包 DP', '记忆化搜索',
    '图论', '最短路', '分治', '二分', '贪心', '构造', '枚举', '模拟',
    '离散化', '哈希 hashing', '线段树', '树状数组', '单调栈', '单调队列',
    '并查集', 'dsu', 'dp', 'greedy', 'graphs', 'math', 'interactive',
    '交互题', '组合数学', '素数判断', '高精度', '递推', '递归', '前缀和',
    '深度优先搜索 DFS', '广度优先搜索 BFS', '双指针 two-pointer', '倍增',
    'Fibonacci 数列', 'Catalan 数', 'KMP 算法', 'Floyd 算法', 'ST 表', 'STL',
    '期望', '逆元', '进制', '位运算', '排序', '剪枝', '搜索', '排列组合',
    '优先队列', '堆', '栈', '队列', '链表', '树形数据结构', '线性数据结构',
    '笛卡尔树', '最大公约数 gcd', '差分', '图遍历', '连通块', 'Ad-hoc',
    '字符串', '数学', '循环结构', '顺序结构',
    // 2026-09 校准回归：高频真实算法 tag 不得被新增来源关键词误杀
    '数学（综合）', '图论（综合）', '数据结构（综合）', '位运算技巧', '树论', '其它技巧',
    '深度优先搜索(DFS)', '广度优先搜索(BFS)', '莫队', '启发式合并',
  ]) {
    assert.equal(isNoiseTag(t), false, `误杀算法标签: ${t}`);
  }
});

test('filterNoiseTags removes noise and keeps order', () => {
  const tags = ['贪心', '2026', '蓝桥杯省赛', 'dp', '*special', '提交答案'];
  assert.deepEqual(filterNoiseTags(tags), ['贪心', 'dp']);
});

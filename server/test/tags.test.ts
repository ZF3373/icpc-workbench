import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterNoiseTags, isNoiseTag } from '../src/analysis/tags.ts';

// 标签全集以真实库洛谷 117 个 tag 校准（2026-08 快照）

test('isNoiseTag catches source/contest/year/region tags', () => {
  // 年份
  for (const t of ['1998', '2026', '2013']) assert.equal(isNoiseTag(t), true, t);
  // 赛事/来源
  for (const t of ['蓝桥杯省赛', 'NOIP 普及组', 'NOIP 提高组', '各省省选', '洛谷原创', '洛谷月赛', '洛谷比赛', 'NOI 导刊', '福建省历届夏令营', '蓝桥杯青少年组']) {
    assert.equal(isNoiseTag(t), true, t);
  }
  // 地区/国际赛事
  for (const t of ['北京', '天津', '安徽', 'COCI（克罗地亚）', 'POI（波兰）', 'NERC/NEERC', 'USACO', 'eJOI（欧洲）', 'CERC', 'Code+', 'GESP', '信息与未来']) {
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
  ]) {
    assert.equal(isNoiseTag(t), false, `误杀算法标签: ${t}`);
  }
});

test('filterNoiseTags removes noise and keeps order', () => {
  const tags = ['贪心', '2026', '蓝桥杯省赛', 'dp', '*special', '提交答案'];
  assert.deepEqual(filterNoiseTags(tags), ['贪心', 'dp']);
});

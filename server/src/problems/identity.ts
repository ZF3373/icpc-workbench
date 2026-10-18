/**
 * 原题身份（洛谷 CF / AtCoder 镜像共用原题身份；AtCoder 展示题号忽略下划线）。
 * 核心表达式只接受**列引用片段**，因此同一份骨架既能给带别名的查询用，
 * 也能生成 `problems` 表的生成列（生成列里禁止 `.` 运算符）。
 */
function identityExpr(platformCol: string, keyCol: string): string {
  const key = `lower(trim(${keyCol}))`;
  return `CASE
    WHEN ${platformCol} = 'luogu' AND ${key} GLOB 'cf[0-9]*' THEN 'codeforces:' || substr(${key}, 3)
    WHEN ${platformCol} = 'luogu' AND substr(${key}, 1, 3) = 'at_' THEN 'atcoder:' || replace(substr(${key}, 4), '_', '')
    WHEN ${platformCol} = 'atcoder' THEN 'atcoder:' || replace(${key}, '_', '')
    ELSE ${platformCol} || ':' || ${key} END`;
}

export function problemIdentitySql(alias: string): string {
  return identityExpr(`${alias}.platform`, `${alias}.problem_key`);
}

/**
 * `problems.identity` 生成列的表达式（无表别名）。
 *
 * 与 `problemIdentitySql(别名)` 是同一份骨架，只是列引用不带前缀 —— SQLite 的生成列
 * 禁止 `.` 运算符（`the "." operator prohibited in generated columns`），带别名的版本
 * 无法直接塞进 DDL。函数集合（lower / trim / substr / replace / GLOB）都是内建确定性
 * 函数，满足生成列要求；改这里等于改身份口径，务必同时跑 identity 对照用例。
 */
export const IDENTITY_COLUMN_EXPR = identityExpr('platform', 'problem_key');

/**
 * 读生成列用的 SQL 片段；使用处的题目表别名必须是 p。
 *
 * 身份**等值查找**（`WHERE p.identity = ?`、`ON a.identity = p.identity`）一律读生成列，
 * 不要改回 `problemIdentitySql(别名)`：表达式版每行重算一遍 CASE，只能全表扫描
 * （真实库 1.9 万题实测 8.4ms，走 idx_problems_identity 后 0.006ms）。
 * 题目表别名不是 p 时（如 todayTasks 里的 sp），直接写 `${别名}.identity`。
 */
export const IDENTITY_COLUMN_SQL = 'p.identity';

export function problemIdentity(p: { platform: string; problemKey: string }): string {
  let platform = p.platform;
  let key = p.problemKey.trim().toLowerCase();
  if (platform === 'luogu' && /^cf\d/.test(key)) { platform = 'codeforces'; key = key.slice(2); }
  if (platform === 'luogu' && key.startsWith('at_')) { platform = 'atcoder'; key = key.slice(3); }
  if (platform === 'atcoder') key = key.replaceAll('_', '');
  return `${platform}:${key}`;
}

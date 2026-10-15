/** 洛谷 CF / AtCoder 镜像共用原题身份；AtCoder 展示题号忽略下划线。 */
export function problemIdentitySql(alias: string): string {
  const platform = `${alias}.platform`;
  const key = `lower(trim(${alias}.problem_key))`;
  return `CASE
    WHEN ${platform} = 'luogu' AND ${key} GLOB 'cf[0-9]*' THEN 'codeforces:' || substr(${key}, 3)
    WHEN ${platform} = 'luogu' AND substr(${key}, 1, 3) = 'at_' THEN 'atcoder:' || replace(substr(${key}, 4), '_', '')
    WHEN ${platform} = 'atcoder' THEN 'atcoder:' || replace(${key}, '_', '')
    ELSE ${platform} || ':' || ${key} END`;
}

export function problemIdentity(p: { platform: string; problemKey: string }): string {
  let platform = p.platform;
  let key = p.problemKey.trim().toLowerCase();
  if (platform === 'luogu' && /^cf\d/.test(key)) { platform = 'codeforces'; key = key.slice(2); }
  if (platform === 'luogu' && key.startsWith('at_')) { platform = 'atcoder'; key = key.slice(3); }
  if (platform === 'atcoder') key = key.replaceAll('_', '');
  return `${platform}:${key}`;
}

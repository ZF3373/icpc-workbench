/**
 * 生成内置题库 server/src/data/bank-builtin.json（构建期一次性运行，产物提交进仓库）。
 *
 *   npx tsx scripts/gen-builtin-bank.ts [--cf-only] [--luogu-max 3000]
 *
 * 数据源（均匿名公开）：
 * - Codeforces problemset.problems：单次调用全量（约 1 万题，自带 rating + tags）
 * - 洛谷公开题库：difficulty>=3（普及/提高- 及以上），限量 --luogu-max（默认 3000）
 *   洛谷按页限速爬取（约 1-2 分钟/千题），失败不阻断——降级为 CF-only 并提示重跑。
 * 产物带版本号（生成日期），运行时 seedBuiltinBank 按版本比对幂等入库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchCodeforcesBank, fetchLuoguBank } from '../src/adapters/problemBank.ts';

const args = process.argv.slice(2);
const cfOnly = args.includes('--cf-only');
const luoguMaxIdx = args.indexOf('--luogu-max');
const luoguMax = luoguMaxIdx >= 0 ? Number(args[luoguMaxIdx + 1]) || 3000 : 3000;

const OUT_PATH = path.resolve(import.meta.dirname, '..', 'src', 'data', 'bank-builtin.json');

interface BuiltinProblem {
  platform: string;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string;
  tags: string[];
}

const problems: BuiltinProblem[] = [];
const parts: string[] = [];

// ---------- Codeforces ----------
console.log('[1/2] 拉取 Codeforces 全量题库（单次调用）...');
const cf = await fetchCodeforcesBank(fetch, {});
problems.push(
  ...cf.problems.map((p) => ({
    platform: p.platform,
    problemKey: p.problemKey,
    title: p.title,
    difficulty: p.difficulty,
    url: p.url,
    tags: p.tags,
  })),
);
parts.push(`codeforces=${cf.problems.length}`);
console.log(`      Codeforces ${cf.problems.length} 题`);

// ---------- 洛谷 ----------
if (!cfOnly) {
  console.log(`[2/2] 拉取洛谷题库（difficulty>=3，上限 ${luoguMax}，限速爬取请耐心等待）...`);
  try {
    const lg = await fetchLuoguBank(fetch, { max: luoguMax, luoguMinDifficulty: 3 });
    problems.push(
      ...lg.problems.map((p) => ({
        platform: p.platform,
        problemKey: p.problemKey,
        title: p.title,
        difficulty: p.difficulty,
        url: p.url,
        tags: p.tags,
      })),
    );
    parts.push(`luogu=${lg.problems.length}`);
    console.log(`      洛谷 ${lg.problems.length} 题`);
  } catch (e) {
    console.warn(`      洛谷拉取失败（${(e as Error).message}），本次产物仅含 Codeforces；可稍后重跑本脚本补上`);
  }
} else {
  console.log('[2/2] --cf-only：跳过洛谷');
}

// ---------- 写产物 ----------
const version = new Date().toISOString().slice(0, 10);
const payload = {
  version,
  generatedAt: new Date().toISOString(),
  source: `builtin bank snapshot (${parts.join(', ')})`,
  count: problems.length,
  problems,
};
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
const sizeMb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
console.log(`已写入 ${OUT_PATH}`);
console.log(`版本 ${version}，共 ${problems.length} 题（${parts.join(' + ')}），${sizeMb}MB`);

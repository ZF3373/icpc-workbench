/**
 * Windows SEA 打包脚本：node scripts/build-exe.mjs
 *
 * 步骤：
 * 1. npm run build（client dist）
 * 2. esbuild bundle server/src/sea.ts → dist/sea-bundle.js（CJS，全依赖打入）
 * 3. 生成 SEA 配置 sea-config.json：主脚本 + 内嵌资源
 *    （schema.sql / plan-prompt.md / widget.html / client-dist/**）
 * 4. node --experimental-sea-config 生成 blob → postject 注入 node.exe 副本
 *
 * 产物：dist/icpc-workbench.exe（约 80-120MB），旁置 config.json 可选。
 * 运行：双击或命令行启动，访问 http://localhost:3001，
 * 数据库落在 exe 同目录 data/icpc.db。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');
const outDir = path.join(serverRoot, 'dist');
const exePath = path.join(outDir, 'icpc-workbench.exe');

console.log('[1/5] 构建前端 client/dist ...');
execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });

console.log('[2/5] esbuild bundle server/src/sea.ts ...');
fs.mkdirSync(outDir, { recursive: true });
// CJS bundle：SEA 主脚本按 CJS 执行（embedderRunCjs）。
// 源码普遍在模块顶层用 fileURLToPath(import.meta.url) 定位资源，
// CJS 下 import.meta 为空对象会当场抛错 —— 打包期重写为 __filename/__dirname。
const { build } = await import('esbuild');
const importMetaPlugin = {
  name: 'rewrite-import-meta',
  setup(b) {
    b.onLoad({ filter: /\.(ts|tsx)$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      const rewritten = src
        .replace(/fileURLToPath\(import\.meta\.url\)/g, '__filename')
        .replace(/import\.meta\.dirname/g, '__dirname')
        .replace(/import\.meta\.url/g, 'pathToFileURL(__filename).href');
      return rewritten === src ? null : { contents: rewritten, loader: 'ts' };
    });
  },
};
await build({
  entryPoints: [path.join(serverRoot, 'src', 'sea.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(outDir, 'sea-bundle.cjs'),
  external: ['node:*'],
  minify: true,
  plugins: [importMetaPlugin],
});

// ---- 收集内嵌资源 ----
console.log('[3/5] 收集 SEA 资源 ...');
// Node 24 SEA 配置：assets 为 name → 文件路径字符串映射（全部按二进制注入，
// 运行时 getAsset 返回 ArrayBuffer，由 sea.ts 统一 Buffer.from() 解码）
const assets = {};
assets['src/db/schema.sql'] = path.join(serverRoot, 'src', 'db', 'schema.sql');
assets['src/ai/plan-prompt.md'] = path.join(serverRoot, 'src', 'ai', 'plan-prompt.md');
assets['public/widget.html'] = path.join(serverRoot, 'src', 'public', 'widget.html');

// 前端 dist：二进制原样内嵌，附 manifest.txt 清单（运行时按清单提取）
const clientDist = path.join(repoRoot, 'client', 'dist');
const distFiles = [];
function walk(dir, base = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else distFiles.push(rel);
  }
}
walk(clientDist);
for (const rel of distFiles) {
  assets[`client-dist/${rel}`] = path.join(clientDist, rel);
}
// manifest 也作为资源内嵌（sea.ts 运行时读取）
const manifestPath = path.join(outDir, 'client-dist-manifest.txt');
fs.writeFileSync(manifestPath, distFiles.join('\n'));
assets['client-dist/manifest.txt'] = manifestPath;
console.log(`      前端文件 ${distFiles.length} 个，共 ${Object.keys(assets).length} 项资源`);

// ---- SEA 配置 ----
const seaConfig = {
  main: path.join(outDir, 'sea-bundle.cjs'),
  output: path.join(outDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  // useCodeCache 在部分 Node 版本与 text 资产/注入组合下会导致 getAsset 行为异常，关闭
  useCodeCache: false,
  assets,
};
const seaConfigPath = path.join(outDir, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

console.log('[4/5] 生成 SEA blob ...');
execSync(`node --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit' });

console.log('[5/5] 注入 node.exe ...');
// 复制 node.exe → 移除签名（Windows）→ postject 注入
fs.copyFileSync(process.execPath, exePath);
try {
  execSync(`npx postject "${exePath}" NODE_SEA_BLOB "${seaConfig.output}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, {
    stdio: 'inherit',
  });
} catch {
  // 已签名 exe 注入需先去签名；postject 失败时尝试 --overwrite 重试
  console.log('      postject 首次注入失败，尝试 --overwrite ...');
  execSync(
    `npx postject "${exePath}" NODE_SEA_BLOB "${seaConfig.output}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`,
    { stdio: 'inherit' },
  );
}

const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`\n完成: ${exePath} (${sizeMb} MB)`);
console.log('运行后访问 http://localhost:3001（数据库在 exe 旁 data/ 目录）');

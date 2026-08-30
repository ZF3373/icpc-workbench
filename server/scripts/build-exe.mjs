/**
 * Windows SEA 打包脚本：node scripts/build-exe.mjs
 *
 * 步骤：
 * 1. npm run build（client dist）
 * 2. esbuild bundle server/src/sea.ts → dist/sea-bundle.cjs（CJS，全依赖打入）
 * 3. 生成 SEA 配置 sea-config.json：主脚本 + 内嵌资源
 *    （schema.sql / plan-prompt.md / widget.html / client-dist/**）
 * 4. node --experimental-sea-config 生成 blob → postject 注入 node.exe 副本
 * 5. release/ 发布目录：exe + 使用说明.txt（整个文件夹直接拷给用户）
 *
 * 产物面向“电脑小白”双击即用：自动打开默认浏览器（127.0.0.1，
 * 不触发防火墙弹窗）、端口被占自动顺延、重复双击复用已运行实例、
 * 启动报错窗口不闪退。数据库落在 exe 同目录 data/icpc.db。
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
// --core-only：桌面壳打包用的无窗口核心（icpc-core.exe），跳过 release 目录组装
const coreOnly = process.argv.includes('--core-only');
const exePath = path.join(outDir, coreOnly ? 'icpc-core.exe' : 'icpc-workbench.exe');

console.log('[1/5] 构建前端 client/dist ...');
execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });

console.log('[2/5] esbuild bundle server/src/sea.ts ...');
fs.mkdirSync(outDir, { recursive: true });
// 版本号：取 HEAD 可达的最近 git tag（如 v0.2.1）注入 APP_VERSION，
// 供「软件更新」与 /api/health 显示与比对；无 tag 时回退 dev。
let appVersion = 'dev';
try {
  appVersion = execSync('git describe --tags --abbrev=0').toString().trim();
} catch {
  console.log('      （未找到 git tag，APP_VERSION=dev）');
}
console.log(`      APP_VERSION = ${appVersion}`);
// 构建 commit（短 SHA）：供更新检查与 GitHub master 最新提交比对（nightly 双通道）。
let buildCommit = 'dev';
try {
  buildCommit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  console.log('      （非 git 环境，BUILD_COMMIT=dev）');
}
console.log(`      BUILD_COMMIT = ${buildCommit}`);
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
  define: {
    'process.env.APP_VERSION': JSON.stringify(appVersion),
    'process.env.BUILD_COMMIT': JSON.stringify(buildCommit),
  },
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

const README_TXT = `
======================================
 ICPC 备赛工作台 · 使用说明
======================================

【怎么打开】
  双击 icpc-workbench.exe 就可以了。
  会出现一个黑色窗口，随后浏览器自动打开软件页面，即可开始使用。

【重要：先解压！】
  如果你拿到的是 zip 压缩包，请先把整个压缩包解压到任意文件夹再双击运行，
  不要直接在压缩包里双击（那样数据会丢失）。

【使用期间】
  1. 黑色窗口代表软件正在运行，请不要关闭它（最小化没有影响）。
     关闭黑色窗口 = 退出软件。
  2. 如果浏览器没有自动打开：手动打开浏览器，在地址栏输入
     http://localhost:3001
  3. 你的全部练习数据都保存在本文件夹的 data 子文件夹里。
     换电脑时，把整个文件夹一起拷过去即可。

【如果 Windows 拦截】
  首次运行可能提示"Windows 已保护你的电脑"：
  点击「更多信息」→「仍要运行」即可。
  （本软件未购买代码签名证书，属于正常提示，软件不联网上传任何数据。）
  部分杀毒软件可能误报，请选择"信任/允许运行"。

【其他情况】
  - 提示端口被占用：软件会自动换一个端口，以黑色窗口里显示的网址为准。
  - 双击后窗口一闪而过：说明启动出错，请把 exe 拖到命令行窗口里运行查看报错。
  - 重复双击：软件只会运行一份，直接为你打开正在运行的页面。
  - 检查更新：设置页底部有「检查更新」按钮，支持一键更新（正式版与
    GitHub 最新提交构建），也可按提示下载后手动替换，data 文件夹不用动。
`;

// ---- 发布目录：只放 exe + 使用说明，直接整个文件夹拷给用户 ----
if (coreOnly) {
  console.log(`
核心构建完成: ${exePath} (${sizeMb} MB)`);
  process.exit(0);
}

console.log('[6/6] 生成发布目录 release/ ...');
const releaseDir = path.join(serverRoot, 'release');
const releaseExe = path.join(releaseDir, 'icpc-workbench.exe');
try {
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(exePath, releaseExe);
  // 带 BOM 的 UTF-8，保证旧版记事本也不乱码
  fs.writeFileSync(path.join(releaseDir, '使用说明.txt'), `\ufeff${README_TXT}`, 'utf8');
} catch (e) {
  // 常见原因：用户还在运行 release 里的 exe（Windows 锁定运行中的 exe，无法删除/覆盖）
  console.error(`\n[发布目录失败] ${e instanceof Error ? e.message : String(e)}`);
  console.error(`请先关闭正在运行的 ${releaseExe}（黑色窗口）后重新打包。`);
  console.error(`本次构建的 exe 仍可用: ${exePath}`);
  process.exit(1);
}

console.log(`\n完成: ${path.join(releaseDir, 'icpc-workbench.exe')} (${sizeMb} MB)`);
console.log(`发布目录: ${releaseDir}（含 使用说明.txt，整个文件夹拷给用户即可）`);
console.log('双击 exe 即用：自动打开默认浏览器，数据落在 exe 旁 data/ 目录。');

/**
 * 桌面版打包脚本：node scripts/build-desktop.mjs
 *
 * 架构：Tauri 原生窗口壳（icpc-workbench.exe）+ 无窗口 Node 服务核心（icpc-core.exe sidecar）。
 * 产物：
 *   release/icpc-workbench-<ver>-x64-setup.exe  NSIS 安装程序（含壳 + 核心，中文界面，带卸载器）
 *   release/ 便携版：icpc-workbench.exe + icpc-core.exe + 使用说明.txt（解压即用，免安装）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');
const appTauriDir = path.join(repoRoot, 'desktop', 'app', 'src-tauri');
const sidecarDir = path.join(appTauriDir, 'binaries');

// 目标三元组（externalBin 命名需要）；gnu/msvc 均可，取本机 rustc host
const hostTriple = execSync('rustc -vV')
  .toString()
  .match(/host:\s*(\S+)/)?.[1];
if (!hostTriple) {
  console.error('无法确定 rustc host 三元组');
  process.exit(1);
}

const coreExe = path.join(serverRoot, 'dist', 'icpc-core.exe');
const shellExe = path.join(appTauriDir, 'target', 'release', 'icpc-workbench.exe');
const releaseDir = path.join(serverRoot, 'release');

console.log('[1/4] 构建无窗口核心（SEA）...');
execSync('node scripts/build-exe.mjs --core-only', { cwd: serverRoot, stdio: 'inherit' });
if (!fs.existsSync(coreExe)) {
  console.error('核心构建产物缺失: ' + coreExe);
  process.exit(1);
}

// 版本号同步：git tag → tauri.conf.json（安装程序文件名/卸载信息随 tag 走）
let appVersion = '0.0.0';
try {
  appVersion = execSync('git describe --tags --abbrev=0', { cwd: repoRoot }).toString().trim().replace(/^v/, '');
} catch {
  console.log('      （未找到 git tag，tauri.conf.json 版本保持不变）');
}
const tauriConfPath = path.join(appTauriDir, 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
if (appVersion !== '0.0.0' && tauriConf.version !== appVersion) {
  tauriConf.version = appVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`      tauri.conf.json version -> ${appVersion}`);
}

console.log(`[2/4] 复制核心为 sidecar（同时覆盖 gnu / msvc 两种 triple 命名）...`);
fs.mkdirSync(sidecarDir, { recursive: true });
for (const triple of ['x86_64-pc-windows-gnu', 'x86_64-pc-windows-msvc']) {
  fs.copyFileSync(coreExe, path.join(sidecarDir, `icpc-core-${triple}.exe`));
}

console.log('[3/4] 构建 Tauri 壳 + NSIS 安装程序（cargo + bundler）...');
execSync('npx tauri build', { cwd: path.join(appTauriDir, '..'), stdio: 'inherit' });
if (!fs.existsSync(shellExe)) {
  console.error('壳构建产物缺失: ' + shellExe);
  process.exit(1);
}
const bundleDir = path.join(appTauriDir, 'target', 'release', 'bundle', 'nsis');
const setupExe = fs
  .readdirSync(bundleDir)
  .filter((f) => f.endsWith('-setup.exe'))
  .sort()
  .at(-1);
if (!setupExe) {
  console.error('NSIS 安装程序未生成: ' + bundleDir);
  process.exit(1);
}

console.log('[4/4] 组装发布目录 release/ ...');
try {
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  // 安装程序（推荐）
  fs.copyFileSync(path.join(bundleDir, setupExe), path.join(releaseDir, setupExe));
  // 便携版（免安装）
  fs.copyFileSync(shellExe, path.join(releaseDir, 'icpc-workbench.exe'));
  fs.copyFileSync(coreExe, path.join(releaseDir, 'icpc-core.exe'));

  const README_TXT = `
======================================
 ICPC 备赛工作台 · 使用说明
======================================

【两种用法任选】

一、安装版（推荐）
  双击 icpc-workbench-*.x64-setup.exe，按提示安装（自动创建开始菜单与桌面快捷方式），
  之后从桌面/开始菜单打开软件。卸载时练习数据会自动备份到
  %APPDATA%\\icpc-workbench\\data，装回后可继续使用。

二、便携版（免安装）
  直接双击 icpc-workbench.exe 打开软件自己的窗口（不依赖浏览器）。
  icpc-core.exe 是本地服务核心，请勿删除；data/ 为练习数据（自动生成），
  换电脑时把整个文件夹一起拷走。

【如果 Windows 拦截】
  首次运行可能提示"Windows 已保护你的电脑"：
  点击「更多信息」→「仍要运行」即可。
  （本软件未购买代码签名证书，属于正常提示，软件不联网上传任何数据。）

【其他情况】
  - 关闭软件窗口 = 退出软件。
  - 若窗口停在"本地服务未响应"：软件会自动重启服务恢复，稍等即可。
  - 检查更新：设置页底部有「检查更新」按钮；升级时下载新版安装包覆盖，
    或用新便携版的两个 exe 覆盖旧文件，data 文件夹不用动。
`;

  fs.writeFileSync(path.join(releaseDir, '使用说明.txt'), `\ufeff${README_TXT}`, 'utf8');
} catch (e) {
  console.error(`\n[发布目录失败] ${e instanceof Error ? e.message : String(e)}`);
  console.error('请先关闭正在运行的软件窗口后重新打包。');
  process.exit(1);
}

const sizeOf = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`\n完成: ${releaseDir}`);
console.log(`  ${setupExe}  ${sizeOf(path.join(releaseDir, setupExe))} MB（安装程序）`);
console.log(`  icpc-workbench.exe  ${sizeOf(path.join(releaseDir, 'icpc-workbench.exe'))} MB（便携版壳）`);
console.log(`  icpc-core.exe       ${sizeOf(path.join(releaseDir, 'icpc-core.exe'))} MB（便携版核心）`);

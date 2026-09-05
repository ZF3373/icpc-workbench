/**
 * macOS 桌面版打包脚本：node scripts/build-desktop-mac.mjs（仅 macOS 运行）
 *
 * 架构与 Windows 版一致：Tauri 原生窗口壳 + 无窗口 Node SEA 核心（sidecar）。
 * 产物（release/）：
 *   icpc-workbench_<ver>_aarch64.dmg   拖入 Applications 的安装镜像（Apple Silicon）
 *   icpc-core                          mac 核心二进制（便携/排查用）
 *
 * 说明：
 * - 未购买 Apple 开发者证书，产物为未签名状态；首次打开需右键 →「打开」，
 *   或 `xattr -cr /Applications/icpc-workbench.app` 去除隔离属性。
 * - 夜间构建在 GitHub Actions macos-latest（arm64）上产出，覆盖 Apple Silicon；
 *   Intel Mac 暂不提供（Node SEA 核心是架构相关的，双架构需另行 lipo 合并）。
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

if (process.platform !== 'darwin') {
  console.error('本脚本仅支持在 macOS 上运行（Windows 请使用 build-desktop.mjs）');
  process.exit(1);
}

// 目标三元组（externalBin 侧Car命名需要），取本机 rustc host（CI 上为 aarch64-apple-darwin）
const hostTriple = execSync('rustc -vV')
  .toString()
  .match(/host:\s*(\S+)/)?.[1];
if (!hostTriple) {
  console.error('无法确定 rustc host 三元组');
  process.exit(1);
}

const coreBin = path.join(serverRoot, 'dist', 'icpc-core');
const releaseDir = path.join(serverRoot, 'release');

console.log('[1/4] 构建无窗口核心（SEA）...');
execSync('node scripts/build-exe.mjs --core-only', { cwd: serverRoot, stdio: 'inherit' });
if (!fs.existsSync(coreBin)) {
  console.error('核心构建产物缺失: ' + coreBin);
  process.exit(1);
}

// 版本号同步：git tag → tauri.conf.json（与 Windows 脚本同一套规则）
let appVersion = '0.0.0';
try {
  const described = execSync('git describe --tags --abbrev=0 --match "v[0-9]*"', { cwd: repoRoot }).toString().trim();
  if (/^v?\d+\.\d+\.\d+/.test(described)) {
    appVersion = described.replace(/^v/, '');
  } else {
    console.log(`      （最近 tag "${described}" 非语义化版本，tauri.conf.json 版本保持不变）`);
  }
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

console.log(`[2/4] 复制核心为 sidecar（${hostTriple}）...`);
fs.mkdirSync(sidecarDir, { recursive: true });
fs.copyFileSync(coreBin, path.join(sidecarDir, `icpc-core-${hostTriple}`));

console.log('[3/4] 构建 Tauri 壳 + .app/.dmg（targets 来自 tauri.macos.conf.json）...');
execSync('npx tauri build', { cwd: path.join(appTauriDir, '..'), stdio: 'inherit' });

const dmgDir = path.join(appTauriDir, 'target', 'release', 'bundle', 'dmg');
const dmgFile = fs
  .readdirSync(dmgDir)
  .filter((f) => f.endsWith('.dmg'))
  .sort()
  .at(-1);
if (!dmgFile) {
  console.error('dmg 未生成: ' + dmgDir);
  process.exit(1);
}

console.log('[4/4] 组装发布目录 release/ ...');
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
const dmgOut = path.join(releaseDir, dmgFile);
fs.copyFileSync(path.join(dmgDir, dmgFile), dmgOut);
// mac 核心二进制单独发布：便携排查 / 未来组装 .app 用
fs.copyFileSync(coreBin, path.join(releaseDir, `icpc-core-${hostTriple}`));

const README_TXT = `
======================================
 ICPC 备赛工作台 · macOS 使用说明
======================================

【安装】
  双击 icpc-workbench_*.dmg，把 icpc-workbench 拖入「应用程序」文件夹。

【首次打开（重要）】
  本软件未购买 Apple 开发者证书（nightly 构建为未签名版本），
  首次打开若提示"无法验证开发者"：
    方法一：在「应用程序」中右键 icpc-workbench →「打开」→ 再点「打开」。
    方法二：终端执行  xattr -cr /Applications/icpc-workbench.app  后正常双击打开。

【使用】
  - 打开软件会出现自己的窗口（不依赖浏览器）；练习数据保存在
    icpc-workbench.app 内的 data 文件夹（自动生成）。
  - 关闭窗口 = 退出软件。

【已知限制】
  - 本 dmg 为 Apple Silicon（M1/M2/M3/M4）版本，Intel Mac 暂不支持。
  - 应用内「一键更新」目前仅 Windows 支持；macOS 请到
    https://github.com/ZF3373/icpc-workbench/releases 下载新版覆盖。
`;
fs.writeFileSync(path.join(releaseDir, '使用说明-mac.txt'), `\ufeff${README_TXT}`, 'utf8');

const sizeOf = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`\n完成: ${releaseDir}`);
console.log(`  ${dmgFile}  ${sizeOf(dmgOut)} MB（Apple Silicon 安装镜像）`);
console.log(`  icpc-core-${hostTriple}  ${sizeOf(path.join(releaseDir, `icpc-core-${hostTriple}`))} MB（核心）`);

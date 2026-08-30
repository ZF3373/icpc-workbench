/**
 * 桌面版（原生窗口）打包脚本：node scripts/build-desktop.mjs
 *
 * 架构：Tauri 原生窗口壳（icpc-workbench.exe）+ 无窗口 Node 服务核心（icpc-core.exe sidecar）。
 * - 核心：SEA 单文件（build-exe.mjs --core-only），ICPC_EMBEDDED=1 由壳拉起，不抢浏览器
 * - 壳：desktop/app 的 Tauri 工程（cargo build --release，便携单 exe，无需 tauri CLI）
 * - 发布目录 release/：壳 + 核心 + 使用说明；data/ 由核心运行时创建
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..');
const appTauriDir = path.join(repoRoot, 'desktop', 'app', 'src-tauri');

const coreExe = path.join(serverRoot, 'dist', 'icpc-core.exe');
const shellExe = path.join(appTauriDir, 'target', 'release', 'icpc-workbench.exe');
const releaseDir = path.join(serverRoot, 'release');

console.log('[1/3] 构建无窗口核心（SEA）...');
execSync('node scripts/build-exe.mjs --core-only', { cwd: serverRoot, stdio: 'inherit' });
if (!fs.existsSync(coreExe)) {
  console.error('核心构建产物缺失: ' + coreExe);
  process.exit(1);
}

console.log('[2/3] 构建 Tauri 桌面壳（cargo release，首次需编译依赖）...');
execSync('cargo build --release', { cwd: appTauriDir, stdio: 'inherit' });
if (!fs.existsSync(shellExe)) {
  console.error('壳构建产物缺失: ' + shellExe);
  process.exit(1);
}

console.log('[3/3] 组装发布目录 release/ ...');
try {
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.copyFileSync(shellExe, path.join(releaseDir, 'icpc-workbench.exe'));
  fs.copyFileSync(coreExe, path.join(releaseDir, 'icpc-core.exe'));

  const README_TXT = `
======================================
 ICPC 备赛工作台 · 使用说明
======================================

【怎么打开】
  双击 icpc-workbench.exe，会打开软件自己的窗口（不再依赖浏览器）。
  首次启动需要几秒钟初始化本地服务，稍候即可。

【重要：先解压！】
  如果你拿到的是 zip 压缩包，请先把整个压缩包解压到任意文件夹再双击运行，
  不要直接在压缩包里双击（那样数据会丢失）。

【文件夹里有什么】
  - icpc-workbench.exe：软件入口（双击这个）
  - icpc-core.exe：本地服务核心，请勿删除或单独运行
  - data/：你的全部练习数据（自动生成；换电脑时整个文件夹一起拷走）

【如果 Windows 拦截】
  首次运行可能提示"Windows 已保护你的电脑"：
  点击「更多信息」→「仍要运行」即可。
  （本软件未购买代码签名证书，属于正常提示，软件不联网上传任何数据。）
  部分杀毒软件可能误报，请选择"信任/允许运行"。

【其他情况】
  - 关闭软件窗口 = 退出软件（后台服务会一并关闭）。
  - 若窗口停在"本地服务未响应"：软件会自动重启服务恢复，稍等即可。
  - 检查更新：设置页底部有「检查更新」按钮；升级时用新版的两个 exe
    覆盖旧文件，data 文件夹不用动。
`;

  fs.writeFileSync(path.join(releaseDir, '使用说明.txt'), `\ufeff${README_TXT}`, 'utf8');
} catch (e) {
  console.error(`\n[发布目录失败] ${e instanceof Error ? e.message : String(e)}`);
  console.error('请先关闭正在运行的软件窗口后重新打包。');
  process.exit(1);
}

const shellMb = (fs.statSync(path.join(releaseDir, 'icpc-workbench.exe')).size / 1024 / 1024).toFixed(1);
const coreMb = (fs.statSync(path.join(releaseDir, 'icpc-core.exe')).size / 1024 / 1024).toFixed(1);

console.log(`\n完成: ${releaseDir}`);
console.log(`  icpc-workbench.exe  ${shellMb} MB（桌面壳，双击启动）`);
console.log(`  icpc-core.exe       ${coreMb} MB（本地服务核心）`);

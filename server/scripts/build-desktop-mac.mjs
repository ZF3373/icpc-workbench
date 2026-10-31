/**
 * macOS 桌面版打包脚本：node scripts/build-desktop-mac.mjs（仅 macOS 运行）
 *
 * 架构与 Windows 版一致：Tauri 原生窗口壳 + 无窗口 Node SEA 核心（sidecar）。
 * 产物（release/）：
 *   icpc-workbench_<ver>_aarch64.dmg   拖入 Applications 的安装镜像（Apple Silicon）
 *   icpc-core-<triple>                 mac 核心二进制（便携/排查用）
 *
 * 说明：
 * - 未购买 Apple 开发者证书，产物为 ad-hoc 签名（codesign --sign -）；
 *   Apple Silicon 强制要求可执行文件与 .app 有有效签名，未签名/签名失效的包
 *   在用户机上表现为「已损坏，无法打开」——即 issue #14。签名 + 校验在本脚本
 *   内强制完成，签名不通过直接让 CI 失败，不再发布坏包。
 *   仍未公证（notarize）：首次打开可能提示「无法验证开发者」，
 *   右键 →「打开」（或系统设置 → 隐私与安全性 →「仍要打开」）即可放行。
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

/** 执行并回显外部命令；失败时抛出带命令原文的错误（便于 CI 日志定位）。 */
function run(cmd) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`命令执行失败: ${cmd}\n  ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * ad-hoc 签名 .app 全包（含 Contents/MacOS 下的 SEA 核心 sidecar）。
 *
 * 为什么必须做：Apple Silicon 上内核要求所有可执行文件带有效签名，且签名覆盖
 * 包内每个 Mach-O。仅签外层壳、或核心在拷贝进包后被改动，都会让签名失效，
 * 用户下载后表现为「icpc-workbench 已损坏，无法打开」。
 *
 * 刻意不用 `--options runtime`（hardened runtime）：已开启硬化运行时且缺少
 * allow-jit 权限时，Node 的 JIT 会被内核拒绝，核心进程起不来。
 */
function adhocSignApp(appPath) {
  // 先签包内的核心 sidecar，再签外层包：反过来会被外层签名覆盖，且校验可能不过
  const core = path.join(appPath, 'Contents', 'MacOS', 'icpc-core');
  if (!fs.existsSync(core)) {
    // 核心不在预期位置 = 包结构不对，壳启动后必然找不到核心，先在这里暴露
    throw new Error(`包内未找到核心 sidecar: ${core}`);
  }
  // 核心单独显式签一次：--deep 对 sidecar 的处理随版本变化，显式签保证确定行为
  run(`codesign --force --sign - "${core}"`);
  run(`codesign --force --sign - "${appPath}"`);
  // 校验刻意不加 --strict：--strict 额外要求 bundle 带密封的 CodeResources 资源清单，
  // 而这种「只塞了 sidecar、没有 Resources 清单」的 sparse bundle 会报
  // "code has no resources but signature indicates they must be present"
  // （issue #14 反馈里那条）。该报错并不代表签名没用——应用照常能启动，
  // 用 --strict 只会让构建变脆。不带 --strict 依旧会校验签名本体与包内每个 Mach-O，
  // 足以拦住「签名失效 → 已损坏」这类真问题。
  run(`codesign --verify --deep --verbose=2 "${appPath}"`);
  console.log('      签名校验通过（ad-hoc，含嵌入核心）');
}

console.log('[1/5] 构建无窗口核心（SEA）...');
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

console.log(`[2/5] 复制核心为 sidecar（${hostTriple}）...`);
fs.mkdirSync(sidecarDir, { recursive: true });
fs.copyFileSync(coreBin, path.join(sidecarDir, `icpc-core-${hostTriple}`));

console.log('[3/5] 构建 Tauri 壳 + .app/.dmg（targets 来自 tauri.macos.conf.json）...');
execSync('npx tauri build', { cwd: path.join(appTauriDir, '..'), stdio: 'inherit' });

const bundleDir = path.join(appTauriDir, 'target', 'release', 'bundle');
const appDir = path.join(bundleDir, 'macos');
const appFile = fs.existsSync(appDir)
  ? fs
      .readdirSync(appDir)
      .filter((f) => f.endsWith('.app'))
      .sort()
      .at(-1)
  : undefined;
if (!appFile) {
  console.error('未生成 .app: ' + appDir);
  process.exit(1);
}
const appPath = path.join(appDir, appFile);

// 签名必须在 tauri build 之后：Tauri 打包时会重新组装包内容，之前签的都会失效。
console.log('[4/5] ad-hoc 签名 .app 并校验签名 ...');
adhocSignApp(appPath);

const dmgDir = path.join(bundleDir, 'dmg');
const dmgFile = fs
  .readdirSync(dmgDir)
  .filter((f) => f.endsWith('.dmg'))
  .sort()
  .at(-1);
if (!dmgFile) {
  console.error('dmg 未生成: ' + dmgDir);
  process.exit(1);
}

console.log('[5/5] 组装发布目录 release/ ...');
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
  本软件未购买 Apple 开发者证书，构建时已做 ad-hoc 签名（Apple 芯片能正常启动），
  但未经 Apple 公证，首次打开系统仍可能拦一下。任选一种放行方式：

    方法一（推荐）：在「应用程序」里右键 icpc-workbench →「打开」→ 再点「打开」。
    方法二：打开「系统设置」→「隐私与安全性」，在底部找到被拦截的提示，
            点「仍要打开」，再输入密码确认。
    方法三：终端执行  xattr -cr /Applications/icpc-workbench.app  后即可双击打开。

  只提示一次，之后双击就能正常启动。

【使用】
  - 打开软件会出现自己的窗口（不依赖浏览器）。
  - 练习数据保存在用户目录：
      ~/Library/Application Support/icpc-workbench/data
    （故意不放在 icpc-workbench.app 内部：应用包内写入会让签名失效，
      导致「已损坏，无法打开」，且覆盖安装新版会丢数据。）
  - 关闭窗口 = 隐藏到托盘（不退出）；要完全退出请从菜单栏图标选择「退出」。
    （Windows 版同样如此：左键点击托盘图标可恢复窗口。）

【已知限制】
  - 本 dmg 为 Apple Silicon（M1/M2/M3/M4）版本，Intel Mac 暂不支持。
  - 应用内「一键更新」目前仅 Windows 支持；macOS 请到
    https://github.com/ZF3373/icpc-workbench/releases 下载新版覆盖，
    覆盖安装不会影响上面 data 目录里的练习数据。
`;
fs.writeFileSync(path.join(releaseDir, 'README-mac.txt'), `\ufeff${README_TXT}`, 'utf8');

const sizeOf = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`\n完成: ${releaseDir}`);
console.log(`  ${dmgFile}  ${sizeOf(dmgOut)} MB（Apple Silicon 安装镜像，含 ad-hoc 签名 .app）`);
console.log(`  icpc-core-${hostTriple}  ${sizeOf(path.join(releaseDir, `icpc-core-${hostTriple}`))} MB（核心）`);

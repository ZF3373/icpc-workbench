import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TYPST_VERSION = '0.15.1';

const ASSETS = {
  'win32-x64': {
    file: `typst-x86_64-pc-windows-msvc.zip`,
    sha256: '19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736',
  },
  'win32-arm64': {
    file: `typst-aarch64-pc-windows-msvc.zip`,
    sha256: '4ab28e1b71ec3184d38d580ab797f499b6770d952b6b19167be5cea5c2662e14',
  },
  'darwin-arm64': {
    file: `typst-aarch64-apple-darwin.tar.xz`,
    sha256: '48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a',
  },
  'darwin-x64': {
    file: `typst-x86_64-apple-darwin.tar.xz`,
    sha256: '7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa',
  },
  'linux-x64': {
    file: `typst-x86_64-unknown-linux-musl.tar.xz`,
    sha256: 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c',
  },
  'linux-arm64': {
    file: `typst-aarch64-unknown-linux-musl.tar.xz`,
    sha256: '5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee',
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

export function currentPlatformKey() {
  const key = `${process.platform}-${process.arch}`;
  if (!ASSETS[key]) throw new Error(`当前平台暂不支持 Typst 导出：${key}`);
  return key;
}

export function typstBinaryPath(key = currentPlatformKey()) {
  const name = key.startsWith('win32-') ? 'typst.exe' : 'typst';
  return path.join(serverRoot, 'vendor', 'typst', key, `v${TYPST_VERSION}`, name);
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 下载并校验当前平台的官方 Typst CLI，返回可执行文件绝对路径。 */
export async function ensureTypstBinary({ quiet = false } = {}) {
  const key = currentPlatformKey();
  const target = typstBinaryPath(key);
  if (fs.existsSync(target)) {
    if (!quiet) console.log(`[typst] 已就绪: ${target}`);
    return target;
  }

  const asset = ASSETS[key];
  const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${asset.file}`;
  const archiveDir = path.join(serverRoot, 'vendor', 'typst', '.cache');
  const archivePath = path.join(archiveDir, asset.file);
  fs.mkdirSync(archiveDir, { recursive: true });

  if (!quiet) console.log(`[typst] 下载 v${TYPST_VERSION} (${key}) ...`);
  // 无超时的 fetch 在网络挂起时会让构建/测试无限卡住（优化计划 #94）；
  // GitHub release 资产约 15-40MB，120s 对慢速链路也足够
  const response = await fetch(url, {
    headers: { 'User-Agent': 'icpc-workbench-build' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`下载 Typst 失败：HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = sha256(archive);
  if (actual !== asset.sha256) {
    throw new Error(`Typst 下载校验失败：期望 ${asset.sha256}，实际 ${actual}`);
  }
  fs.writeFileSync(archivePath, archive);

  const extractDir = fs.mkdtempSync(path.join(archiveDir, 'extract-'));
  try {
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
    const expectedName = key.startsWith('win32-') ? 'typst.exe' : 'typst';
    const found = walkFiles(extractDir).find((file) => path.basename(file) === expectedName);
    if (!found) throw new Error(`Typst 压缩包中未找到 ${expectedName}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(found, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  if (!quiet) console.log(`[typst] 校验通过: ${target}`);
  return target;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureTypstBinary().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

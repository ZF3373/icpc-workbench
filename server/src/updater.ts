import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadUrls } from './routes/update.ts';

/**
 * 一键自更新执行器（仅 Windows 桌面生产包）：
 *
 * download：把所选通道的 icpc-workbench.exe / icpc-core.exe 流式下载到
 *   data/update-staging，再拉取 checksums.sha256 做 SHA256 校验。
 * apply：原地替换——把运行中的旧 exe 改名为 *.exe.old（Windows 允许改名
 *   运行中的 exe，但不允许覆盖/删除），再把新 exe 拷入原位。当前进程仍运行
 *   旧代码（无影响），用户关闭软件窗口后重新打开即运行新版；遗留的 *.exe.old
 *   在下次启动时顺手清理（此时已无进程锁定）。
 *
 * 状态机：idle → downloading → verifying → staged →（apply 后回 idle）。
 * 前端轮询 updateState() 渲染进度；失败停在 error 并带原因。
 */

export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'staged' | 'error';

export interface UpdateProgressState {
  phase: UpdatePhase;
  received: number;
  total: number;
  error: string | null;
}

const state: UpdateProgressState = { phase: 'idle', received: 0, total: 0, error: null };

export function updateState(): UpdateProgressState {
  return { ...state };
}

export const SHELL_NAME = 'icpc-workbench.exe';
export const CORE_NAME = 'icpc-core.exe';
export const CHECKSUMS_NAME = 'checksums.sha256';

const UA_HEADERS = { 'User-Agent': 'icpc-workbench' };
/** 产物合理体积下限：防止拿到被网关劫持的错误页当 exe 用 */
const MIN_SIZE: Record<string, number> = { [SHELL_NAME]: 1_000_000, [CORE_NAME]: 20_000_000 };

/** 启动下载（异步推进，调用方通过 updateState() 轮询）。同一时间只允许一个任务。 */
export function startDownload(urls: DownloadUrls, stagingDir: string): { ok: boolean; message?: string } {
  if (state.phase === 'downloading' || state.phase === 'verifying') {
    return { ok: false, message: '已有更新任务在进行中' };
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  state.phase = 'downloading';
  state.received = 0;
  state.total = 0;
  state.error = null;
  void run(urls, stagingDir).catch(() => {}); // 错误已记录进 state
  return { ok: true };
}

async function run(urls: DownloadUrls, stagingDir: string): Promise<void> {
  try {
    for (const [url, name] of [
      [urls.shell, SHELL_NAME],
      [urls.core, CORE_NAME],
    ] as const) {
      await downloadFile(url, path.join(stagingDir, name));
    }
    state.phase = 'verifying';
    const checksums = await fetchText(urls.checksums);
    verifyChecksums(checksums, stagingDir, [SHELL_NAME, CORE_NAME]);
    state.phase = 'staged';
  } catch (e) {
    state.phase = 'error';
    state.error = e instanceof Error ? e.message : String(e);
  }
}

async function downloadFile(url: string, dest: string): Promise<void> {
  let received = 0;
  try {
    const res = await fetch(url, { headers: UA_HEADERS, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    if (total > 0) state.total += total;
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      async function* (source) {
        for await (const chunk of source) {
          received += (chunk as Buffer).length;
          state.received += (chunk as Buffer).length;
          yield chunk;
        }
      },
      fs.createWriteStream(dest),
    );
  } catch (e) {
    // 企业网/安全软件 TLS 拦截时 Node 内置 CA 校验会失败（与更新检查同一问题），
    // Windows 上回退 PowerShell（.NET 网络栈，走系统证书库）
    fs.rmSync(dest, { force: true });
    await downloadViaPowerShell(url, dest);
    received = fs.statSync(dest).size;
    state.received += received;
  }
  const min = MIN_SIZE[path.basename(dest)] ?? 0;
  if (received < min) throw new Error(`下载不完整（${received} 字节，小于合理体积下限）`);
}

/** PowerShell 下载兜底。url 来自 GitHub API 返回值，路径由本模块拼装，均转义后拼入。 */
function downloadViaPowerShell(url: string, dest: string): Promise<void> {
  const esc = (s: string) => s.replace(/'/g, "''");
  const script = `Invoke-WebRequest -Uri '${esc(url)}' -UserAgent 'icpc-workbench' -OutFile '${esc(dest)}'`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10 * 60_000, windowsHide: true }, (err) => {
      if (err) {
        reject(new Error(`下载失败（含 PowerShell 兜底）：${err.message.slice(0, 150)}`));
        return;
      }
      resolve();
    });
  });
}

/** 小文本（校验文件）下载：fetch 优先，Windows 上失败回退 PowerShell。 */
async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: UA_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`校验文件下载失败：HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (process.platform !== 'win32') throw e;
    const esc = (s: string) => s.replace(/'/g, "''");
    const script = `Invoke-RestMethod -Uri '${esc(url)}' -UserAgent 'icpc-workbench' -TimeoutSec 30`;
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 45_000, windowsHide: true }, (err, stdout) => {
        if (err) {
          reject(new Error(`校验文件下载失败：${e instanceof Error ? e.message : String(e)}`));
          return;
        }
        resolve(String(stdout));
      });
    });
  }
}

/** 解析 `<sha256>  <文件名>` 格式（GitHub Actions 生成，分隔符为两个空格）。 */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) map.set(m[2].trim().toLowerCase(), m[1].toLowerCase());
  }
  return map;
}

export function verifyChecksums(checksumsText: string, dir: string, names: string[]): void {
  const map = parseChecksums(checksumsText);
  for (const name of names) {
    const expected = map.get(name.toLowerCase());
    if (!expected) throw new Error(`校验文件缺少 ${name} 的哈希`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
    if (actual !== expected) throw new Error(`${name} SHA256 校验不通过，已放弃更新`);
  }
}

/** 原地替换已暂存的新 exe。成功后需要用户重启软件生效。 */
export function applyUpdate(stagingDir: string): { ok: boolean; message?: string } {
  if (state.phase !== 'staged') {
    return { ok: false, message: '没有已下载待应用的更新' };
  }
  const exeDir = path.dirname(process.execPath);
  const targets = [
    { name: SHELL_NAME, target: path.join(exeDir, SHELL_NAME) },
    { name: CORE_NAME, target: path.join(exeDir, CORE_NAME) },
  ];
  try {
    for (const t of targets) {
      const old = `${t.target}.old`;
      try {
        fs.rmSync(old, { force: true });
      } catch {
        /* 上次更新遗留且仍被锁定时忽略，不影响本次 */
      }
      if (fs.existsSync(t.target)) {
        fs.renameSync(t.target, old);
      }
      fs.copyFileSync(path.join(stagingDir, t.name), t.target);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `替换文件失败（文件可能被占用，请关闭软件后手动覆盖）：${message}` };
  }
  state.phase = 'idle';
  state.received = 0;
  state.total = 0;
  return { ok: true, message: '更新完成：请关闭软件窗口，稍候重新打开即生效' };
}

/** 清理上次更新遗留的 *.exe.old（进程已退出后才能删干净；失败静默）。 */
export function cleanupOldFiles(): void {
  const exeDir = path.dirname(process.execPath);
  for (const name of [SHELL_NAME, CORE_NAME]) {
    try {
      fs.rmSync(path.join(exeDir, `${name}.old`), { force: true });
    } catch {
      /* 仍被锁定则等下次 */
    }
  }
}

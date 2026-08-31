import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import type { DownloadUrls } from './routes/update.ts';

/**
 * 一键自更新执行器（仅 Windows 桌面生产包）：
 *
 * download：把所选通道的 icpc-workbench.exe / icpc-core.exe 下载到
 *   data/update-staging，再拉取 checksums.sha256 做 SHA256 校验。
 * apply：原地替换——把运行中的旧 exe 改名为 *.exe.old（Windows 允许改名
 *   运行中的 exe，但不允许覆盖/删除），再把新 exe 拷入原位。当前进程仍运行
 *   旧代码（无影响），用户关闭软件窗口后重新打开即运行新版；遗留的 *.exe.old
 *   在下次启动时顺手清理（此时已无进程锁定）。
 *
 * 下载加速（国内直连 GitHub 普遍只有几十 KB/s，实测镜像+分片可达 700KB/s+）：
 *   1. 候选源 = 直连 → 各加速镜像（URL 前缀代理）；每个源先按 PROBE_SECONDS
 *      试速，低于 SPEED_GATE 视为过慢，中断换下一个源。只有大文件产物走镜像，
 *      checksums.sha256 始终直连 GitHub，校验基准不经过第三方。
 *   2. 单源内按 Range 分 PARALLEL_PARTS 片并行下载；单连接静默超过 15 秒即
 *      掐掉重连、断点续传（连接级限速/掉线不拖垮整个源）；探测响应非 206
 *      （服务器不支持 Range）时自动退单流。
 *   3. 所有源都不达标时，改用测得最快的源不限速下完（慢总比失败好）；
 *      fetch 直接报错（企业网 TLS 拦截等）时仍回退 PowerShell。
 *   4. 每个候选源的产物先过「体积下限 + SHA256」再收货，镜像给出过期缓存时
 *      自动换源重试，而不是等最终校验失败。
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

/** 分片并行数；速度门槛取「多线程直连的典型值」上方，过慢即换下一个源 */
const PARALLEL_PARTS = 4;
const SPEED_GATE = 200 * 1024; // B/s，候选源滚动窗口均速门槛
const STALL_FLOOR = 8 * 1024; // B/s，终极兜底源只防死链：窗口均速低于它才放弃
const PROBE_SECONDS = 4; // 测速窗口长度（滚动）
const PART_STALL_SECONDS = 15; // 单连接静默上限：掐掉重连、断点续传
const IDLE_SECONDS = 30; // 全部连接整体无数据的静默上限：防止死链挂死整个更新
const PART_MAX_BLIND_RETRIES = 4; // 单片连续零进展重试上限，超过判该源失败

/** GitHub 加速镜像（URL 前缀代理）。环境变量 ICPC_UPDATE_MIRRORS 可覆盖
 *  （逗号分隔），镜像失效时无需发版即可替换。 */
const DEFAULT_MIRRORS = ['https://ghfast.top', 'https://gh-proxy.com'];

export function mirrorPrefixes(env = process.env.ICPC_UPDATE_MIRRORS): string[] {
  const raw = (env ?? '').trim();
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_MIRRORS;
  return list.map((s) => s.replace(/\/+$/, ''));
}

/** 候选下载源：直连优先（不经第三方），过慢才依次尝试镜像前缀。 */
export function candidateUrls(url: string): string[] {
  return [url, ...mirrorPrefixes().map((p) => `${p}/${url}`)];
}

/** 把 [0, total) 均分为 parts 段，末段吃尾差；total 非正时返回空（退单流）。 */
export function buildRanges(total: number, parts: number): Array<[number, number]> {
  if (total <= 0) return [];
  const size = Math.ceil(total / parts);
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < total; start += size) {
    ranges.push([start, Math.min(start + size, total) - 1]);
  }
  return ranges;
}

/** 速度试测未达标：带测得速度，供 downloadFile 挑「最快的慢源」收尾。 */
class TooSlowError extends Error {
  constructor(
    readonly speed: number,
  ) {
    super(`下载速度过慢（${Math.round(speed / 1024)} KB/s）`);
  }
}

/** 产物哈希与校验文件不符（典型：镜像缓存了旧版本）。 */
class HashMismatchError extends Error {
  constructor(name: string) {
    super(`${name} SHA256 校验不通过`);
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk as Buffer))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

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
    // 校验文件先行（小文件直连 GitHub）：既当完整性基准，也让每个候选源的
    // 下载结果能逐文件校验，镜像给了过期缓存时自动换源而不是整体失败
    const checksums = await fetchText(urls.checksums);
    const map = parseChecksums(checksums);
    let done = 0;
    for (const [url, name] of [
      [urls.shell, SHELL_NAME],
      [urls.core, CORE_NAME],
    ] as const) {
      const expected = map.get(name.toLowerCase());
      if (!expected) throw new Error(`校验文件缺少 ${name} 的哈希`);
      await downloadFile(url, path.join(stagingDir, name), name, expected, done);
      done += fs.statSync(path.join(stagingDir, name)).size;
    }
    state.phase = 'verifying';
    verifyChecksums(checksums, stagingDir, [SHELL_NAME, CORE_NAME]);
    state.phase = 'staged';
  } catch (e) {
    state.phase = 'error';
    state.error = e instanceof Error ? e.message : String(e);
  }
}

interface OnceHooks {
  gate: boolean;
  onProgress: (delta: number) => void;
  onTotal: (total: number) => void;
}

/**
 * 单源一次下载尝试：探测响应 206 则分片并行、200 则单流。
 * 单连接静默超过 PART_STALL_SECONDS 即掐掉重连、从断点续传（连接级限速/掉线
 * 不拖垮整个源）；滚动窗口均速低于门槛（候选源）或死链下限（兜底源）时中止
 * 整个尝试，由调用方换源。
 */
async function downloadOnce(url: string, dest: string, hooks: OnceHooks): Promise<void> {
  const fh = await fs.promises.open(dest, 'w');
  const global = new AbortController();
  const startedAt = Date.now();
  let abortReason: 'slow' | 'idle' | 'fail' | null = null;
  let bytes = 0;
  let windowBytes = 0;
  let windowStart = startedAt;
  let lastBytes = 0;
  let lastProgressAt = startedAt;
  const failures: unknown[] = [];
  const speed = (): number => bytes / Math.max(0.5, (Date.now() - startedAt) / 1000);

  const timer = setInterval(() => {
    const now = Date.now();
    if (bytes !== lastBytes) {
      lastBytes = bytes;
      lastProgressAt = now;
    }
    if (abortReason) return;
    // 滚动窗口测速：源被限速/掐断时持续低于门槛即换源；兜底源只防死链
    if (now - windowStart >= PROBE_SECONDS * 1000) {
      const windowSpeed = windowBytes / ((now - windowStart) / 1000);
      if (windowSpeed < (hooks.gate ? SPEED_GATE : STALL_FLOOR)) {
        abortReason = 'slow';
        global.abort();
        return;
      }
      windowBytes = 0;
      windowStart = now;
    }
    if (now - lastProgressAt > IDLE_SECONDS * 1000) {
      abortReason = 'idle';
      global.abort();
    }
  }, 1000);
  timer.unref();

  /**
   * 一路分片：start/end 为写入区间（end=Infinity 表示总长未知，读到 EOF 为止），
   * firstRes 为已建立的探测响应（仅第 0 片首次使用）。连接中断/静默超时都从
   * 断点续传，只有连续多次零进展才判该源失败。
   */
  const runPart = async (start: number, end: number, firstRes: Response | null, resumable: boolean): Promise<void> => {
    const bounded = end !== Number.POSITIVE_INFINITY;
    let pos = start;
    let noProgress = 0;
    for (;;) {
      if (pos > end || global.signal.aborted) return;
      const prev = pos;
      const partCtl = new AbortController();
      const onGlobal = (): void => partCtl.abort();
      global.signal.addEventListener('abort', onGlobal, { once: true });
      let lastByteAt = Date.now();
      const stall = setInterval(() => {
        if (Date.now() - lastByteAt > PART_STALL_SECONDS * 1000) partCtl.abort();
      }, 1000);
      stall.unref();
      let eof = false; // 服务器主动关流：无界片视为下完，有界片视为提前断开
      let fatal: Error | null = null;
      try {
        const res = firstRes ?? (await fetch(url, {
          headers: { ...UA_HEADERS, Range: bounded ? `bytes=${pos}-${end}` : `bytes=${pos}-` },
          redirect: 'follow',
          signal: partCtl.signal,
        }));
        firstRes = null;
        if (!res.ok || !res.body) {
          const err = new Error(`下载失败：HTTP ${res.status}`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) fatal = err; // 4xx 重试无意义
          throw err;
        }
        const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
        for await (const chunk of source) {
          if (pos > end) {
            source.destroy(); // 探测响应可能越界，按分片边界截断
            break;
          }
          const buf = chunk as Buffer;
          await fh.write(buf, 0, buf.length, pos);
          pos += buf.length;
          bytes += buf.length;
          windowBytes += buf.length;
          lastByteAt = Date.now();
          hooks.onProgress(buf.length);
        }
        eof = true;
      } catch {
        /* 连接被掐断/限速/静默超时：断点续传重试 */
      } finally {
        clearInterval(stall);
        global.signal.removeEventListener('abort', onGlobal);
      }
      if (fatal) {
        failures.push(fatal);
        if (!abortReason) {
          abortReason = 'fail';
          global.abort();
        }
        return;
      }
      const done = pos > end || (eof && !bounded);
      if (done || global.signal.aborted) return;
      noProgress = pos > prev ? 0 : noProgress + 1;
      if (!resumable || noProgress >= PART_MAX_BLIND_RETRIES) {
        failures.push(new Error(bounded ? `分片 ${start}-${end} 下载中断（已到 ${pos}）` : '下载中断（服务器不支持断点续传）'));
        if (!abortReason) {
          abortReason = 'fail';
          global.abort();
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 300 * noProgress)); // 小退避再续传
    }
  };

  try {
    // 探测请求：206 = 支持 Range（content-range 带总长，可分片并行）；200 = 退单流
    let probe: Response;
    try {
      probe = await fetch(url, {
        headers: { ...UA_HEADERS, Range: 'bytes=0-' },
        redirect: 'follow',
        signal: global.signal,
      });
    } catch (e) {
      if (abortReason === 'slow') throw new TooSlowError(speed());
      if (abortReason === 'idle') throw new Error('下载连接超时无数据');
      throw e;
    }
    if (!probe.ok || !probe.body) throw new Error(`下载失败：HTTP ${probe.status}`);

    let expectedTotal = 0;
    if (probe.status === 206) {
      expectedTotal = Number(/\/(\d+)\s*$/.exec(probe.headers.get('content-range') ?? '')?.[1] ?? 0);
    } else {
      expectedTotal = Number(probe.headers.get('content-length') ?? 0);
    }
    if (expectedTotal > 0) hooks.onTotal(expectedTotal);

    if (probe.status === 206 && expectedTotal > 0) {
      const ranges = buildRanges(expectedTotal, PARALLEL_PARTS);
      const rest = ranges.slice(1).map(([s, e]) => runPart(s, e, null, true));
      await runPart(ranges[0][0], ranges[0][1], probe, true); // 探测响应即第 0 片，读到片界截断
      await Promise.all(rest);
    } else if (probe.status === 206) {
      await runPart(0, Number.POSITIVE_INFINITY, probe, true); // 206 但拿不到总长：单流，可续传
    } else {
      await runPart(0, Number.POSITIVE_INFINITY, probe, false); // 不支持 Range：单流，不可续传
    }

    if (abortReason === 'slow') {
      throw hooks.gate ? new TooSlowError(speed()) : new Error('下载速度过低，疑似连接失效');
    }
    if (abortReason === 'idle') throw new Error('下载连接超时无数据');
    if (failures.length > 0) {
      throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
    }
    if (expectedTotal > 0) {
      const size = (await fh.stat()).size;
      if (size !== expectedTotal) throw new Error(`下载不完整（${size}/${expectedTotal} 字节）`);
    }
  } finally {
    clearInterval(timer);
    await fh.close().catch(() => {});
  }
}

/** 单文件收货检查：体积下限 + SHA256（镜像可能给出过期缓存，逐文件校验以便换源重试）。 */
async function checkDownloaded(dest: string, minSize: number, expectedSha256: string | null, name: string): Promise<void> {
  const size = fs.statSync(dest).size;
  if (size < minSize) throw new Error(`下载不完整（${size} 字节，小于合理体积下限）`);
  if (!expectedSha256) return;
  const actual = await sha256File(dest);
  if (actual !== expectedSha256) throw new HashMismatchError(name);
}

/** 逐候选源下载：试速换源 → 最快慢源不限速收尾 → Windows PowerShell 兜底。 */
async function downloadFile(
  url: string,
  dest: string,
  name: string,
  expectedSha256: string | null,
  baseBytes: number,
): Promise<void> {
  const min = MIN_SIZE[name] ?? 0;
  let fileBytes = 0;
  const onProgress = (delta: number): void => {
    fileBytes += delta;
    state.received = baseBytes + fileBytes;
  };
  const onTotal = (total: number): void => {
    if (total > 0) state.total = baseBytes + total;
  };
  const receive = async (source: string, gate: boolean): Promise<void> => {
    fileBytes = 0;
    state.received = baseBytes;
    fs.rmSync(dest, { force: true });
    await downloadOnce(source, dest, { gate, onProgress, onTotal });
    await checkDownloaded(dest, min, expectedSha256, name);
  };

  let lastError: unknown = null;
  let bestSlow: { url: string; speed: number } | null = null;
  for (const cand of candidateUrls(url)) {
    try {
      await receive(cand, true);
      return;
    } catch (e) {
      lastError = e;
      if (e instanceof TooSlowError && (!bestSlow || e.speed > bestSlow.speed)) {
        bestSlow = { url: cand, speed: e.speed };
      }
    }
  }
  // 所有源都不达标：用测得最快的源不限速下完（慢总比失败好）
  try {
    await receive(bestSlow?.url ?? url, false);
    return;
  } catch (e) {
    lastError = e;
  }
  // 企业网/安全软件 TLS 拦截时 Node 内置 CA 校验会失败（与更新检查同一问题），
  // Windows 上最后回退 PowerShell（.NET 网络栈，走系统证书库）
  if (process.platform === 'win32') {
    fs.rmSync(dest, { force: true });
    await downloadViaPowerShell(url, dest);
    fileBytes = fs.statSync(dest).size;
    state.received = baseBytes + fileBytes;
    await checkDownloaded(dest, min, expectedSha256, name);
    return;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

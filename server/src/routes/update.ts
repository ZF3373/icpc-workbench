import { execFile } from 'node:child_process';
import { Router } from 'express';
import { applyUpdate, startDownload, updateState, cleanupOldFiles } from '../updater.ts';
import type { AppConfig } from '../config.ts';

/**
 * 软件更新检查：以 GitHub Releases 为更新源，双通道：
 * - 稳定通道：releases/latest（正式 tag，如 v0.4.1），按语义版本比较
 * - 提交通道：tag 为 "nightly" 的 prerelease，由 CI 在每次 push master 时
 *   自动构建发布；以构建时注入的 BUILD_COMMIT（短 SHA）与 nightly 的
 *   target_commitish（或标题中的短 SHA）比对，感知未打 tag 的新提交
 *
 * 版本号 APP_VERSION / BUILD_COMMIT 由 build-exe.mjs 打包时通过 esbuild
 * define 注入；源码开发运行均为 "dev"，视为永远最新。
 *
 * 自更新（一键更新）：/download 把所选通道的 icpc-workbench.exe 与
 * icpc-core.exe 下载到 data/update-staging 并做 SHA256 校验；/apply 用
 * 「改名旧文件 → 拷入新文件」的方式原地替换（Windows 允许改名运行中的
 * exe），完成后用户重启软件即生效。
 *
 * 网络通道：原生 fetch 优先；失败时 Windows 上用 PowerShell（.NET 网络栈，
 * 走 Windows 系统证书库）兜底——企业网/安全软件做 TLS 拦截时 Node 内置
 * Mozilla CA 集校验会失败，而 PowerShell 仍可正常访问。
 */

export const APP_VERSION: string = process.env.APP_VERSION ?? 'dev';
export const BUILD_COMMIT: string = process.env.BUILD_COMMIT ?? 'dev';

export const GITHUB_REPO = 'ZF3373/icpc-workbench';
export const NIGHTLY_TAG = 'nightly';

const SHELL_NAME = 'icpc-workbench.exe';
const CORE_NAME = 'icpc-core.exe';
const CHECKSUMS_NAME = 'checksums.sha256';

export interface DownloadUrls {
  shell: string;
  core: string;
  checksums: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  date: string;
  page: string;
}

export interface UpdateInfo {
  ok: boolean;
  current: string;
  buildCommit: string;
  latest: string | null;
  hasUpdate: boolean;
  releasePage: string | null;
  notes: string | null;
  /** 最新提交构建（nightly）；无 CI 构建时为 null */
  commit: CommitInfo | null;
  hasCommitUpdate: boolean;
  /** 推荐更新通道：稳定版优先，其次提交构建 */
  channel: 'stable' | 'commit' | null;
  /** 推荐通道的产物下载地址（自更新用） */
  download: DownloadUrls | null;
  message?: string;
}

interface GithubAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  name?: string;
  prerelease?: boolean;
  target_commitish?: string;
  assets?: GithubAsset[];
}

/** "v0.2.1" → [0,2,1]；无法解析返回 null。前缀 v 可省，prerelease 后缀忽略。 */
export function parseVersion(tag: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a<b 返回 -1，a>b 返回 1，相等返回 0；无法解析按 [0,0,0] 处理。 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a) ?? [0, 0, 0];
  const vb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function emptyInfo(current: string, buildCommit: string): UpdateInfo {
  return {
    ok: true,
    current,
    buildCommit,
    latest: null,
    hasUpdate: false,
    releasePage: null,
    notes: null,
    commit: null,
    hasCommitUpdate: false,
    channel: null,
    download: null,
  };
}

function failed(current: string, buildCommit: string, message: string): UpdateInfo {
  return { ...emptyInfo(current, buildCommit), ok: false, message };
}

/** 从 release 里按文件名找下载地址。 */
function assetUrl(rel: GithubRelease | null, name: string): string | null {
  return rel?.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
}

/**
 * 提交构建的源 commit：优先 target_commitish（CI 用 --target 创建 tag 时
 * GitHub 会回填），否则从标题/说明里抓 7-40 位十六进制短 SHA。
 */
export function nightlyCommitSha(rel: GithubRelease | null): string | null {
  if (!rel) return null;
  const sha = (rel.target_commitish ?? '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.toLowerCase();
  const text = `${rel.name ?? ''}\n${rel.body ?? ''}`;
  const m = /\b([0-9a-f]{7,40})\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 纯函数：由当前版本/构建 commit 与两个通道的 release 信息，推导更新结论。
 * 稳定通道优先（版本更高直接推荐稳定版），否则提交通道（构建 commit 与
 * nightly 不一致即视为有新提交）。
 */
export function resolveUpdate(
  current: string,
  buildCommit: string,
  stable: GithubRelease | null,
  nightly: GithubRelease | null,
): UpdateInfo {
  const info = emptyInfo(current, buildCommit);
  const latest = stable?.tag_name ?? null;
  if (latest) {
    info.latest = latest;
    info.releasePage = stable?.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`;
    info.notes = stable?.body ? stable.body.slice(0, 4000) : null;
    info.hasUpdate = compareVersions(current, latest) < 0;
  }

  const sha = nightlyCommitSha(nightly);
  if (sha && buildCommit !== 'dev' && !sha.startsWith(buildCommit.toLowerCase())) {
    const page =
      nightly?.html_url ?? `https://github.com/${GITHUB_REPO}/actions/workflows`;
    info.commit = {
      sha,
      shortSha: sha.slice(0, 7),
      message: (nightly?.name ?? nightly?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      date: '',
      page,
    };
    info.hasCommitUpdate = true;
  }

  if (info.hasUpdate) {
    info.channel = 'stable';
  } else if (info.hasCommitUpdate) {
    info.channel = 'commit';
  } else {
    return info;
  }

  const source = info.channel === 'stable' ? stable : nightly;
  const download: DownloadUrls = {
    shell: assetUrl(source, SHELL_NAME) ?? '',
    core: assetUrl(source, CORE_NAME) ?? '',
    checksums: assetUrl(source, CHECKSUMS_NAME) ?? '',
  };
  // 产物齐全才允许自更新；缺资源时 download 置空，前端回退「前往下载页」
  info.download = download.shell && download.core && download.checksums ? download : null;
  return info;
}

async function fetchRelease(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; rel: GithubRelease | null }> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'icpc-workbench', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return { status: 404, rel: null };
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  return { status: 200, rel: (await res.json()) as GithubRelease };
}

/**
 * 查询 GitHub 两个通道并与当前构建比较。
 * 断网 / 限流 / 无 Release 一律返回 ok:false（前端静默或提示重试），不抛错。
 * fetchImpl 可注入，便于测试（注入时不会走 PowerShell 兜底）。
 */
export async function checkForUpdate(
  current: string,
  repo: string = GITHUB_REPO,
  fetchImpl: typeof fetch = fetch,
  buildCommit: string = BUILD_COMMIT,
): Promise<UpdateInfo> {
  if (current === 'dev') return failed(current, buildCommit, '开发模式，不检查更新');
  const base = `https://api.github.com/repos/${repo}`;
  try {
    let stable: GithubRelease | null = null;
    let stableSeen = false;
    try {
      const r = await fetchRelease(`${base}/releases/latest`, fetchImpl, 5000);
      stable = r.rel;
      stableSeen = r.status === 200;
    } catch (e) {
      // 稳定通道失败属致命（大概率整体断网），抛给 PowerShell 兜底
      if (fetchImpl !== fetch) {
        return failed(current, buildCommit, e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
    // 提交通道失败不致命（仓库未配 CI / 无 nightly 时 404 属正常）
    let nightly: GithubRelease | null = null;
    try {
      nightly = (await fetchRelease(`${base}/releases/tags/${NIGHTLY_TAG}`, fetchImpl, 5000)).rel;
    } catch {
      nightly = null;
    }
    if (!stableSeen && !nightly) return failed(current, buildCommit, '暂无发布版本');
    return resolveUpdate(current, buildCommit, stable, nightly);
  } catch (e) {
    const message = `检查失败：${e instanceof Error ? e.message : String(e)}`;
    if (process.platform === 'win32' && fetchImpl === fetch) {
      return checkViaPowerShell(current, buildCommit, repo);
    }
    return failed(current, buildCommit, message);
  }
}

/** Windows 兜底通道：PowerShell Invoke-RestMethod（系统证书库，可穿透 TLS 拦截）。 */
function checkViaPowerShell(current: string, buildCommit: string, repo: string): Promise<UpdateInfo> {
  return new Promise((resolve) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      resolve(failed(current, buildCommit, '仓库名格式非法'));
      return;
    }
    const base = `https://api.github.com/repos/${repo}`;
    // repo 已通过白名单校验后才拼入命令，避免注入
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$h = @{ \'User-Agent\' = \'icpc-workbench\' }',
      'function Get-Rel($u) { try { Invoke-RestMethod -Uri $u -Headers $h -TimeoutSec 10 } catch { $null } }',
      `$s = Get-Rel '${base}/releases/latest'`,
      `$n = Get-Rel '${base}/releases/tags/${NIGHTLY_TAG}'`,
      '@{ stable = $s; nightly = $n } | ConvertTo-Json -Depth 5',
    ].join('\n');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(failed(current, buildCommit, `网络受限，检查失败（${err.message.slice(0, 120)}）`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { stable: GithubRelease | null; nightly: GithubRelease | null };
          const info = resolveUpdate(current, buildCommit, parsed.stable, parsed.nightly);
          if (!info.latest && !info.commit) {
            resolve(failed(current, buildCommit, '暂无发布版本'));
            return;
          }
          resolve(info);
        } catch {
          resolve(failed(current, buildCommit, '更新信息解析失败'));
        }
      },
    );
  });
}

/** 桌面生产环境（SEA 打包 + Windows）才允许原地自更新。 */
function canSelfUpdate(): boolean {
  return process.platform === 'win32' && APP_VERSION !== 'dev' && BUILD_COMMIT !== 'dev';
}

/** GET /check、GET /progress、POST /download、POST /apply（永 200，失败信息在 body） */
export function updateRoutes(config: AppConfig): Router {
  const r = Router();
  const stagingDir = `${config.dataDir}/update-staging`;
  if (canSelfUpdate()) cleanupOldFiles(); // 清理上次更新遗留的 *.exe.old
  r.get('/check', async (_req, res) => {
    const info = await checkForUpdate(APP_VERSION, GITHUB_REPO, fetch, BUILD_COMMIT);
    res.json({ ...info, canSelfUpdate: canSelfUpdate() && info.download !== null });
  });
  r.get('/progress', (_req, res) => {
    res.json(updateState());
  });
  r.post('/download', async (_req, res) => {
    if (!canSelfUpdate()) {
      res.json({ ok: false, message: '当前环境不支持一键更新（开发模式或非 Windows），请手动下载替换' });
      return;
    }
    const info = await checkForUpdate(APP_VERSION, GITHUB_REPO, fetch, BUILD_COMMIT);
    if (!info.ok || !info.download) {
      res.json({ ok: false, message: info.message ?? '未获取到可下载的更新产物' });
      return;
    }
    res.json(startDownload(info.download, stagingDir));
  });
  r.post('/apply', (_req, res) => {
    if (!canSelfUpdate()) {
      res.json({ ok: false, message: '当前环境不支持一键更新' });
      return;
    }
    res.json(applyUpdate(stagingDir));
  });
  return r;
}

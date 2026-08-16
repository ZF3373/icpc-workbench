import { execFile } from 'node:child_process';
import { Router } from 'express';

/**
 * 软件更新检查：以 GitHub Releases 为更新源。
 *
 * 版本号 APP_VERSION 由 build-exe.mjs 打包时通过 esbuild define 注入
 * （取最近一个 git tag，如 "v0.2.1"）；源码开发运行为 "dev"，视为永远最新。
 *
 * 网络通道：原生 fetch 优先；失败时 Windows 上用 PowerShell（.NET 网络栈，
 * 走 Windows 系统证书库）兜底——企业网/安全软件做 TLS 拦截时 Node 内置
 * Mozilla CA 集校验会失败，而 PowerShell 仍可正常访问。
 */

export const APP_VERSION: string = process.env.APP_VERSION ?? 'dev';

export const GITHUB_REPO = 'ZF3373/icpc-workbench';

export interface UpdateInfo {
  ok: boolean;
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releasePage: string | null;
  notes: string | null;
  message?: string;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
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

function failed(current: string, message: string): UpdateInfo {
  return { ok: false, current, latest: null, hasUpdate: false, releasePage: null, notes: null, message };
}

function toUpdateInfo(current: string, rel: GithubRelease): UpdateInfo {
  const latest = rel.tag_name ?? null;
  if (!latest) return failed(current, 'Release 响应缺少 tag_name');
  return {
    ok: true,
    current,
    latest,
    hasUpdate: compareVersions(current, latest) < 0,
    releasePage: rel.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
    notes: rel.body ? rel.body.slice(0, 4000) : null,
  };
}

/**
 * 查询 GitHub 最新 Release 并与当前版本比较。
 * 断网 / 限流 / 无 Release 一律返回 ok:false（前端静默或提示重试），不抛错。
 * fetchImpl 可注入，便于测试（注入时不会走 PowerShell 兜底）。
 */
export async function checkForUpdate(
  current: string,
  repo: string = GITHUB_REPO,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateInfo> {
  if (current === 'dev') return failed(current, '开发模式，不检查更新');
  let info: UpdateInfo;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'icpc-workbench', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return failed(current, '暂无发布版本');
    if (!res.ok) return failed(current, `GitHub API 返回 ${res.status}`);
    info = toUpdateInfo(current, (await res.json()) as GithubRelease);
  } catch (e) {
    info = failed(current, `检查失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!info.ok && process.platform === 'win32' && fetchImpl === fetch) {
    return checkViaPowerShell(current, repo);
  }
  return info;
}

/** Windows 兜底通道：PowerShell Invoke-RestMethod（系统证书库，可穿透 TLS 拦截）。 */
function checkViaPowerShell(current: string, repo: string): Promise<UpdateInfo> {
  return new Promise((resolve) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      resolve(failed(current, '仓库名格式非法'));
      return;
    }
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    // repo 已通过白名单校验后才拼入命令，避免注入
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $r = Invoke-RestMethod -Uri '${url}' -Headers @{ 'User-Agent' = 'icpc-workbench' } -TimeoutSec 10`,
      "  @{ tag_name = $r.tag_name; html_url = $r.html_url; body = $r.body } | ConvertTo-Json",
      '} catch { exit 2 }',
    ].join('\n');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(failed(current, `网络受限，检查失败（${err.message.slice(0, 120)}）`));
          return;
        }
        try {
          resolve(toUpdateInfo(current, JSON.parse(stdout) as GithubRelease));
        } catch {
          resolve(failed(current, '更新信息解析失败'));
        }
      },
    );
  });
}

/** GET /api/update/check → UpdateInfo（永 200，失败信息在 body） */
export function updateRoutes(): Router {
  const r = Router();
  r.get('/check', async (_req, res) => {
    res.json(await checkForUpdate(APP_VERSION));
  });
  return r;
}

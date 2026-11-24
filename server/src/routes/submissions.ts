import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { effectiveCredentials } from '../adapters/accountCreds.ts';
import { getAdapter } from '../adapters/registry.ts';
import { submissionUrlOf } from '../adapters/submissionUrl.ts';
import { extractSourceFromHtml, SOURCE_FETCH_MIN_INTERVAL_MS } from '../submissions/source.ts';

/**
 * 单次提交的「链接」与「源码」（issue #69）。
 *
 * 三层设计，对应 issue 的三条要求：
 * 1. 链接：同步时就落到 submissions.submission_url（不访问详情页），这里只读；
 *    老行没落列的话按 (platform, external_id) 现算。
 * 2. 源码按需拉取：只有用户点「查看代码」（或 agent 显式查询）时才访问提交详情页，
 *    拉到的源码落 submission_sources 永久缓存 —— 某次提交的源码不会变；
 * 3. 拉取速度：每平台一个最小间隔（见 SOURCE_FETCH_MIN_INTERVAL_MS），
 *    同一平台短时间内重复请求直接 429 + Retry-After，别把 OJ 当免费 API。
 *
 * 刻意不做批量接口：一次点开十几条提交会把风控引到自己身上，
 * 复盘场景也只需对比两条（赛时 WA vs 赛后 AC）。
 */

interface SubmissionRow {
  id: number;
  platform: PlatformId;
  account: string;
  external_id: string | null;
  submission_url: string | null;
  problem_key: string;
  title: string;
  verdict: string;
  language: string | null;
  submitted_at: string;
}

interface SourceRow {
  source: string;
  language: string | null;
  source_url: string | null;
  fetched_at: string;
}

/** 各平台最后一次拉源码的时刻（进程内）：跨进程意义不大，重启后允许重新开始 */
const lastFetchAt = new Map<PlatformId, number>();

export function submissionRoutes(db: Db, fetchFn: typeof fetch = globalThis.fetch): Router {
  const r = Router();

  const findSubmission = (id: number): SubmissionRow | undefined =>
    db.prepare(
      `SELECT s.id, s.platform, s.account, s.external_id, s.submission_url,
              p.problem_key, p.title, s.verdict, s.language, s.submitted_at
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.id = ? AND s.user_id = ?`,
    ).get(id, DEFAULT_USER_ID) as SubmissionRow | undefined;

  /** 详情页地址：库内列优先，老行现算（与 /api/history 的 toSubmissionItem 同口径） */
  const urlOf = (row: SubmissionRow): string | null =>
    row.submission_url ?? (row.external_id ? submissionUrlOf(row.platform, row.external_id) : null);

  /**
   * GET /api/submissions/:id/source
   * 返回该次提交的源码（首次访问详情页拉取并落库，之后直接读缓存）。
   * ?refresh=1 强制重拉（平台改版后修好解析、或怀疑缓存是错的）。
   */
  r.get('/:id/source', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id 非法' });
    const row = findSubmission(id);
    if (!row) return res.status(404).json({ error: '提交记录不存在' });
    const url = urlOf(row);
    if (!url) return res.status(404).json({ error: `无法生成 ${row.platform} 的提交详情链接（该平台路由未知或为手动导入）` });

    const refresh = req.query.refresh === '1';
    const cached = db.prepare(
      `SELECT source, language, source_url, fetched_at FROM submission_sources
        WHERE platform = ? AND account = ? AND external_id = ?`,
    ).get(row.platform, row.account, row.external_id ?? '') as SourceRow | undefined;
    if (cached && !refresh) {
      return res.json({
        submissionId: row.id,
        submissionUrl: url,
        source: cached.source,
        language: cached.language ?? row.language,
        fetchedAt: cached.fetched_at,
        cached: true,
      });
    }

    // 拉取速度限制：同平台两次拉取之间至少隔一个平台下限
    const minGap = SOURCE_FETCH_MIN_INTERVAL_MS[row.platform] ?? 1500;
    const last = lastFetchAt.get(row.platform) ?? 0;
    const waitMs = last + minGap - Date.now();
    if (waitMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
      return res.status(429).json({
        error: `请求过于频繁：${row.platform} 的源码拉取至少间隔 ${Math.ceil(minGap / 1000)} 秒`,
        retryAfterMs: waitMs,
      });
    }

    const adapter = getAdapter(row.platform);
    const creds = effectiveCredentials(db, row.platform, row.account);
    lastFetchAt.set(row.platform, Date.now());
    let html: string;
    try {
      const resp = await fetchFn(url, {
        headers: {
          ...(creds.cookie ? { cookie: creds.cookie } : {}),
          ...(creds.ua ? { 'user-agent': creds.ua } : {}),
          accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
      if (!resp.ok) {
        return res.status(502).json({ error: `平台返回 HTTP ${resp.status}（可能需在设置里补该平台的 Cookie）`, submissionUrl: url });
      }
      html = await resp.text();
    } catch (e) {
      return res.status(502).json({ error: `抓取提交详情页失败：${(e as Error).message}`, submissionUrl: url });
    }

    const extracted = extractSourceFromHtml(row.platform, html);
    if (!extracted) {
      // 拿不到就说清是哪一种「拿不到」，别让用户对着空白猜
      const hint = adapter
        ? '可能是该平台需要登录（请在设置里补 Cookie），或提交详情页结构有变化'
        : '该平台暂不支持自动取源码，可点「打开提交页」手动查看';
      return res.status(422).json({ error: `未能从提交页解析出源码：${hint}`, submissionUrl: url });
    }

    db.prepare(
      `INSERT INTO submission_sources (platform, account, external_id, source, language, source_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, account, external_id) DO UPDATE SET
         source = excluded.source, language = excluded.language,
         source_url = excluded.source_url, fetched_at = excluded.fetched_at`,
    ).run(
      row.platform,
      row.account,
      row.external_id ?? '',
      extracted.source,
      extracted.language ?? row.language,
      url,
      new Date().toISOString(),
    );

    return res.json({
      submissionId: row.id,
      submissionUrl: url,
      source: extracted.source,
      language: extracted.language ?? row.language,
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
  }));

  /** GET /api/submissions/:id → 单条提交元信息（含详情页链接），MCP 与前端共用 */
  r.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id 非法' });
    const row = findSubmission(id);
    if (!row) return res.status(404).json({ error: '提交记录不存在' });
    res.json({
      id: row.id,
      platform: row.platform,
      platformName: PLATFORMS.find((p) => p.id === row.platform)?.name ?? row.platform,
      account: row.account,
      problemKey: row.problem_key,
      title: row.title,
      verdict: row.verdict,
      language: row.language,
      submittedAt: row.submitted_at,
      externalId: row.external_id,
      submissionUrl: urlOf(row),
    });
  });

  return r;
}

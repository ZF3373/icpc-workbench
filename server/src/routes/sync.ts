import { Router } from 'express';
import type { PlatformId, PlatformSyncStatus, SyncRun } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { syncPlatform } from '../adapters/sync.ts';
import { cancelAutoContinue, listAutoContinue } from '../adapters/syncScheduler.ts';
import {
  beginBatch,
  completeBatchItem,
  endBatch,
  snapshot as syncProgressSnapshot,
} from '../adapters/syncProgress.ts';

interface SyncRunRow {
  id: number;
  platform: string;
  handle: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  imported: number;
  skipped: number;
  truncated: number;
  waited_ms: number;
  mode: SyncRun['mode'];
  status: SyncRun['status'];
  error_code: string | null;
  error_message: string | null;
  triggered_by: string;
  next_suggested_sync_at: string | null;
}

function toSyncRun(r: SyncRunRow): SyncRun {
  return {
    id: r.id,
    platform: r.platform as PlatformId,
    handle: r.handle,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    imported: r.imported,
    skipped: r.skipped,
    truncated: r.truncated,
    waitedMs: r.waited_ms,
    mode: r.mode,
    status: r.status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    triggeredBy: r.triggered_by,
    nextSuggestedSyncAt: r.next_suggested_sync_at,
  };
}

/** 按最近一次同步结果推导平台健康状态（同步中心徽章） */
function deriveStatus(latest: SyncRun | undefined): PlatformSyncStatus {
  if (!latest) return 'never';
  if (latest.status === 'ok') return 'healthy';
  switch (latest.errorCode) {
    case 'auth_expired': return 'auth_expired';
    case 'rate_limited': return 'rate_limited';
    case 'schema_changed': return 'schema_changed';
    case 'manual_required': return 'manual_required';
    default: return 'degraded';
  }
}

export function syncRoutes(db: Db): Router {
  const r = Router();

  // GET /api/sync/runs?limit=50 → 同步任务历史（新→旧），供同步中心表格展示
  r.get('/runs', (req, res) => {
    const n = Number(req.query.limit);
    const limit = Number.isInteger(n) ? Math.min(200, Math.max(1, n)) : 50;
    const rows = db
      .prepare(
        `SELECT * FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(DEFAULT_USER_ID, limit) as unknown as SyncRunRow[];
    res.json(rows.map(toSyncRun));
  });

  // GET /api/sync/status → 每个绑定平台的健康状态、最近一次同步摘要与后台续拉状态
  // autoContinue：该平台的待执行续拉（round/maxRounds/nextAt/running），无排期时为 null
  // 多账号（v0.8）：accounts 列出该平台全部绑定（handle/enabled/lastSyncAt）；
  // handle/lastSyncAt 字段保留为第一个启用账号的值，兼容旧前端。
  r.get('/status', (_req, res) => {
    const accounts = db
      .prepare(
        'SELECT platform, handle, last_sync_at, enabled FROM platform_accounts WHERE user_id = ? ORDER BY platform, id',
      )
      .all(DEFAULT_USER_ID) as Array<{ platform: string; handle: string; last_sync_at: string | null; enabled: number }>;
    const latestStmt = db.prepare(
      'SELECT * FROM sync_runs WHERE user_id = ? AND platform = ? ORDER BY started_at DESC, id DESC LIMIT 1',
    );
    const autoContinues = listAutoContinue();
    const statuses = PLATFORMS
      .filter((p) => accounts.some((a) => a.platform === p.id))
      .map((p) => {
        // 从未同步过的平台没有 sync_runs 行：`get()` 返回 undefined，必须先判空再转换，
        // 否则 toSyncRun(undefined) 直接抛异常 → 整个 /status 变成 500（前端同步中心白屏）
        const latestRow = latestStmt.get(DEFAULT_USER_ID, p.id) as unknown as SyncRunRow | undefined;
        const latest = latestRow === undefined ? null : toSyncRun(latestRow);
        const platformAccounts = accounts.filter((a) => a.platform === p.id);
        const primary = platformAccounts.find((a) => a.enabled === 1) ?? platformAccounts[0]!;
        return {
          platform: p.id,
          platformName: p.name,
          enabled: platformAccounts.some((a) => a.enabled === 1),
          handle: primary.handle,
          lastSyncAt: primary.last_sync_at ?? null,
          accounts: platformAccounts.map((a) => ({
            handle: a.handle,
            enabled: a.enabled === 1,
            lastSyncAt: a.last_sync_at,
          })),
          status: deriveStatus(latest ?? undefined),
          latestRun: latest,
          autoContinue: autoContinues.find((s) => s.platform === p.id) ?? null,
        };
      });
    res.json({ statuses });
  });

  // GET /api/sync/progress → 进行中的同步（平台/阶段/已用时/站点请求数/最后一次请求距今）
  // 与「一键同步」整批进度。只读、进程内、无同步时 jobs 为空（前端据此自停轮询）。
  // 为什么需要：单次同步是限速的长请求（几十秒到几分钟）且中途无响应，
  // 前端靠这里的真实请求计数证明「还在动」，避免用户误以为卡住而退出。
  r.get('/progress', (_req, res) => {
    res.json(syncProgressSnapshot());
  });

  // GET /api/sync/diagnostics → 纯文本诊断报告（附件下载）。
  // 只包含平台配置状态与最近同步历史，不含任何 Cookie / API Key 原文。
  r.get('/diagnostics', (_req, res) => {
    const accounts = db
      .prepare('SELECT platform, handle, last_sync_at, enabled, sync_truncated, backfill_page FROM platform_accounts WHERE user_id = ? ORDER BY platform')
      .all(DEFAULT_USER_ID) as Array<{ platform: string; handle: string; last_sync_at: string | null; enabled: number; sync_truncated: number; backfill_page: number | null }>;
    const runs = db
      .prepare('SELECT * FROM sync_runs WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT 50')
      .all(DEFAULT_USER_ID) as unknown as SyncRunRow[];
    const adapterEnabled = db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'adapter.%.enabled'")
      .all() as Array<{ key: string; value: string }>;
    const lines: string[] = [
      'ICPC Workbench 同步诊断报告',
      `生成时间：${new Date().toISOString()}`,
      '',
      '== 平台账号 ==',
      ...accounts.map((a) =>
        `- ${a.platform}: handle=${a.handle} enabled=${a.enabled} last_sync_at=${a.last_sync_at ?? '从未'} sync_truncated=${a.sync_truncated} backfill_page=${a.backfill_page ?? '-'}`),
      '',
      '== 适配器开关 ==',
      ...adapterEnabled.map((a) => `- ${a.key} = ${a.value}`),
      '',
      '== 最近 50 次同步（新→旧） ==',
      ...runs.map((r) =>
        `- [${r.started_at}] ${r.platform} (${r.handle}) mode=${r.mode} status=${r.status}` +
        ` imported=${r.imported} skipped=${r.skipped} waited=${r.waited_ms}ms duration=${r.duration_ms}ms` +
        (r.error_code ? ` error=${r.error_code}: ${r.error_message ?? ''}` : '')),
    ];
    const body = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sync-diagnostics.txt"');
    res.send(body);
  });

  // POST /api/sync/all → 一键同步所有已绑定的启用账号（顺序执行，避免同时打多个平台接口）。
  // 多账号（v0.8）：同一平台的多个启用账号依次同步（平台级互斥锁天然串行），
  // 结果按平台聚合（imported/errors 求和合并），批量进度仍以平台为粒度。
  // 每个账号沿用自身增量策略：AtCoder from_second / 牛客 since 截断 / CF·洛谷 已知提交号提前终止。
  // 未绑定账号的平台直接跳过；单平台失败不影响其余平台。
  r.post('/all', asyncHandler(async (_req, res) => {
    const accounts = db
      .prepare(
        'SELECT platform, handle FROM platform_accounts WHERE user_id = ? AND enabled = 1 ORDER BY platform, id',
      )
      .all(DEFAULT_USER_ID) as Array<{ platform: PlatformId; handle: string }>;
    const platforms = [...new Set(accounts.map((a) => a.platform))];
    const results = [];
    // 整批进度：前端据此画出「待同步 / 同步中 / 已完成 +N 条 / 失败」的完整队列，
    // 而不是只知道「当前是谁」。finally 里收尾，异常路径也不留幽灵批次。
    beginBatch(platforms);
    try {
      for (const platform of platforms) {
        const started = Date.now();
        const accountsOfPlatform = accounts.filter((a) => a.platform === platform);
        const aggregate = {
          platform,
          handle: accountsOfPlatform.map((a) => a.handle).join(','),
          imported: 0,
          skipped: 0,
          errors: [] as string[],
          truncated: false,
          incremental: false,
          accounts: [] as Array<{ handle: string; imported: number; skipped: number; errors: string[] }>,
        };
        for (const acc of accountsOfPlatform) {
          const result = await syncPlatform(db, platform, acc.handle, { triggeredBy: 'all' });
          aggregate.imported += result.imported;
          aggregate.skipped += result.skipped;
          aggregate.truncated = aggregate.truncated || result.truncated === true;
          aggregate.incremental = aggregate.incremental || result.incremental === true;
          aggregate.errors.push(...result.errors);
          aggregate.accounts.push({ handle: acc.handle, imported: result.imported, skipped: result.skipped, errors: result.errors });
        }
        completeBatchItem(platform, {
          status: aggregate.errors.length > 0 ? 'failed' : 'ok',
          imported: aggregate.imported,
          ...(aggregate.errors.length > 0 ? { error: aggregate.errors[0]! } : {}),
        });
        results.push({ ...aggregate, durationMs: Date.now() - started });
      }
    } finally {
      endBatch();
    }
    res.json({ results });
  }));

  // POST /api/sync/auto-continue/cancel  body: { platform }
  // 取消该平台的后台续拉（用户手动同步抢占、或明确不想再等），幂等：无排期时 cancelled=false。
  // 必须注册在 POST /:platform 之前（否则会被当成 platform='auto-continue' 的单段路径处理）。
  r.post('/auto-continue/cancel', (req, res) => {
    const { platform } = req.body ?? {};
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    res.json({ ok: true, cancelled: cancelAutoContinue(platform as PlatformId) });
  });

  // POST /api/sync/:platform  body: { handle?, days?, retry? }
  // handle 省略（多账号 v0.8）：顺序同步该平台**全部启用账号**，结果按平台聚合
  // （imported/skipped/errors 求和合并，accounts 带每个账号的明细）。
  // days 为正整数时走「仅同步最近 N 天」窗口模式：补充拉取漏掉的历史，不改账号同步状态。
  // retry=true（同步中心/结果抽屉的「重试」按钮）：语义与手动同步相同，只把 triggered_by
  // 记为 retry，便于在历史里区分"用户主动重试失败平台"与"日常点同步"。
  r.post('/:platform', asyncHandler(async (req, res) => {
    const { platform } = req.params;
    const { handle, days, retry } = req.body ?? {};
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    if (handle !== undefined && (typeof handle !== 'string' || handle.trim() === '')) {
      return res.status(400).json({ error: 'handle 需为非空字符串（省略则同步该平台全部启用账号）' });
    }
    if (retry !== undefined && typeof retry !== 'boolean') {
      return res.status(400).json({ error: 'retry 需为布尔值（省略即普通手动同步）' });
    }
    const daysN = Number(days);
    const opts = Number.isInteger(daysN) && daysN > 0
      ? { days: Math.min(365, daysN), triggeredBy: 'days' as const }
      : { triggeredBy: retry === true ? ('retry' as const) : ('manual' as const) };
    // 指定 handle：只同步该账号；省略：该平台全部启用账号依次同步（平台级互斥锁保证串行）
    const accounts = typeof handle === 'string'
      ? [{ platform: platform as PlatformId, handle: handle.trim() }]
      : (db
          .prepare('SELECT platform, handle FROM platform_accounts WHERE user_id = ? AND platform = ? AND enabled = 1 ORDER BY id')
          .all(DEFAULT_USER_ID, platform) as Array<{ platform: PlatformId; handle: string }>);
    if (accounts.length === 0) {
      return res.status(400).json({ error: '该平台没有已启用的账号绑定，请先到设置页绑定' });
    }
    const aggregate = {
      platform,
      handle: accounts.map((a) => a.handle).join(','),
      imported: 0,
      skipped: 0,
      errors: [] as string[],
      accounts: [] as Array<{ handle: string; imported: number; skipped: number; errors: string[] }>,
    };
    for (const acc of accounts) {
      const result = await syncPlatform(db, acc.platform, acc.handle, opts);
      aggregate.imported += result.imported;
      aggregate.skipped += result.skipped;
      aggregate.errors.push(...result.errors);
      aggregate.accounts.push({ handle: acc.handle, imported: result.imported, skipped: result.skipped, errors: result.errors });
    }
    // 平台无公开 API 等受限情况返回 200 + errors 引导（非致命）
    res.json(aggregate);
  }));

  return r;
}

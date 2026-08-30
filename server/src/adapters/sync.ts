import type {
  PlatformId,
  SyncResult,
} from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { insertNormalized } from '../import/importService.ts';
import { getAdapter } from './registry.ts';
import { ManualImportRequiredError } from './types.ts';

export interface SyncOptions {
  userId?: number;
}

/** 库中该平台已有的平台侧提交号（适配器提前终止分页用） */
function loadKnownExternalIds(
  db: Db,
  userId: number,
  platform: PlatformId,
): Set<string> {
  const rows = db
    .prepare('SELECT external_id FROM submissions WHERE user_id = ? AND platform = ?')
    .all(userId, platform) as Array<{ external_id: string }>;
  return new Set(rows.map((r) => r.external_id));
}

/**
 * 同步某个平台账号的刷题记录：
 * 1. 检查平台开关（settings.adapter.<platform>.enabled，缺省启用）
 * 2. 读取 platform_accounts.last_sync_at 做增量（适配器支持时）
 * 3. 适配器拉取 → insertNormalized 事务入库（problems upsert + submissions 去重）
 * 4. 更新 last_sync_at 与账号信息
 * 平台无公开 API（ManualImportRequiredError）→ 转为引导提示而非失败。
 */
export async function syncPlatform(
  db: Db,
  platform: PlatformId,
  handle: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const userId = opts.userId ?? DEFAULT_USER_ID;
  const result: SyncResult = { platform, handle, imported: 0, skipped: 0, errors: [] };

  const adapter = getAdapter(platform);
  if (!adapter) {
    result.errors.push(`未注册适配器: ${platform}`);
    return result;
  }
  const enabledRaw = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`adapter.${platform}.enabled`) as { value: string } | undefined;
  if (enabledRaw?.value === 'false') {
    result.errors.push(`平台 ${platform} 已禁用（可在设置中开启）`);
    return result;
  }

  const account = db
    .prepare('SELECT handle, last_sync_at FROM platform_accounts WHERE user_id = ? AND platform = ?')
    .get(userId, platform) as { handle: string; last_sync_at: string | null } | undefined;
  // 换账号判定：handle 不同，或从未成功同步过（last_sync_at 为空，如设置页改绑后）。
  // 两种情况都要求全量重拉 + 清空该平台旧数据，避免跨账号数据混入或增量起点错乱。
  // 注意：同 handle 首次成功同步时也会清空该平台旧数据（含手动导入记录）——
  // 语义是"同步以平台数据为准"，手动导入数据会被平台数据取代。
  const handleChanged =
    account !== undefined &&
    (account.handle !== handle || !account.last_sync_at);

  try {
    // 换账号/未成功同步过：全量重拉（不沿用可能属于旧账号的增量起点）
    const since =
      !handleChanged && account?.last_sync_at ? account.last_sync_at : undefined;
    // 声明支持已知提交号过滤的适配器（CF/洛谷，拉取按新到旧排序）：
    // 注入库中已有提交号，适配器整页已知即提前终止分页，实现真实增量
    const knownExternalIds =
      !handleChanged && adapter.knownIdsFilter
        ? loadKnownExternalIds(db, userId, platform)
        : undefined;
    // 需登录平台：从 settings 读取 Cookie / CSRF 注入适配器
    const readSetting = (key: string): string | undefined => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    };
    const cookie = readSetting(`cookie.${platform}`);
    const csrf = readSetting(`csrf.${platform}`);
    const rows = await adapter.fetchUserSubmissions(handle, {
      ...(since ? { since } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { csrf } : {}),
      ...(knownExternalIds ? { knownExternalIds } : {}),
    });

    // 换账号：全量重拉，并在同一事务内清空该平台旧提交再写入新数据
    const r = insertNormalized(db, userId, rows, {
      clearPlatform: handleChanged ? platform : undefined,
    });
    result.imported = r.imported;
    result.skipped = r.skipped;
    if (!handleChanged && (since || (knownExternalIds && knownExternalIds.size > 0))) {
      result.incremental = true;
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         handle = excluded.handle,
         last_sync_at = excluded.last_sync_at,
         enabled = 1`,
    ).run(userId, platform, handle, now);
  } catch (e) {
    if (e instanceof ManualImportRequiredError) {
      result.errors.push(e.message);
    } else {
      result.errors.push((e as Error).message);
    }
  }
  return result;
}

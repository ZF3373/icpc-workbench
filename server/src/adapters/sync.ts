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

  try {
    // 换 handle 时全量重拉（不沿用旧账号的增量起点，避免跨账号数据混入）
    const since =
      account && account.handle === handle && account.last_sync_at
        ? account.last_sync_at
        : undefined;
    const rows = await adapter.fetchUserSubmissions(handle, since ? { since } : undefined);
    const r = insertNormalized(db, userId, rows);
    result.imported = r.imported;
    result.skipped = r.skipped;

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

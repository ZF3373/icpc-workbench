/**
 * 账号级凭据（多账号）：Cookie 类平台的每个绑定账号使用**自己**的登录凭据。
 *
 * 演进：凭据最早只有平台级一份（settings 键 cookie.<platform>），多账号共用；后来账号可
 * 单独保存并逐字段回退平台级。现行口径（v0.9）：**平台级 Cookie 不再作为同步/检测的回退**，
 * 每个账号只用自己槽位里的 Cookie——谁过期就续谁，互不牵连。没配置的账号同步会明确报
 * 「未配置 Cookie」，而不是静默借用别的账号的登录态。
 *
 * - 账号存储：settings 键 `accountCreds.<platform>` = JSON { [handle]: { cookie: 拼装好的 Cookie 头 } }
 * - `cookie.<platform>` 降级为**影子值**：不再有 UI，仅供题库爬取、赛事参与同步、QOJ 榜单等
 *   非账号功能读取「任一有效登录」；保存账号凭据时自动镜像刷新（见 routes/settings.ts），
 *   启动时由 migratePlatformCookieToAccounts 从旧平台级值播种（每平台一次的台账式迁移）。
 * - `ua.<platform>`（QOJ 浏览器 UA）与 `csrf.<platform>`（遗留）仍为平台级：UA 属浏览器属性，
 *   与账号无关，在 QOJ 卡片的共用输入框维护。
 */

import { COOKIE_FIELDS, type PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

/** 单个账号的凭据槽位（cookie 为拼装后的 Cookie 头；csrf 等遗留键不在账号级存储） */
export interface AccountCredSlot {
  cookie?: string;
}

function accountCredsKey(platform: PlatformId): string {
  return `accountCreds.${platform}`;
}

/** 读取某平台全部账号凭据槽位（键缺失 / JSON 损坏一律回退空表，不抛错） */
export function readAccountCreds(db: Db, platform: PlatformId): Record<string, AccountCredSlot> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(accountCredsKey(platform)) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, AccountCredSlot> = {};
    for (const [handle, slot] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof slot !== 'object' || slot === null) continue;
      const cookie = (slot as AccountCredSlot).cookie;
      if (typeof cookie === 'string' && cookie.trim()) out[handle] = { cookie };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写回某平台全部账号凭据槽位（空表时删除设置键，避免残留空 JSON） */
export function writeAccountCreds(db: Db, platform: PlatformId, slots: Record<string, AccountCredSlot>): void {
  const key = accountCredsKey(platform);
  const entries = Object.entries(slots).filter(([, s]) => typeof s.cookie === 'string' && s.cookie.trim() !== '');
  if (entries.length === 0) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(Object.fromEntries(entries)));
}

/** 删除单个账号的凭据槽位（删号时联动调用；槽位不存在为幂等 no-op） */
export function removeAccountCreds(db: Db, platform: PlatformId, handle: string): void {
  const slots = readAccountCreds(db, platform);
  if (!(handle in slots)) return;
  delete slots[handle];
  writeAccountCreds(db, platform, slots);
}

export interface EffectiveCredentials {
  cookie?: string;
  csrf?: string;
  ua?: string;
}

/**
 * 某账号同步 / 检测时的生效凭据（全服务端唯一口径）：
 * - cookie：**只用该账号自己槽位里的**（没配置就是没配置，不回退平台级影子值）；
 * - csrf / ua：平台级遗留键（会话类平台 csrftoken 在 Cookie 头内；UA 属浏览器级，与账号无关）。
 */
export function effectiveCredentials(db: Db, platform: PlatformId, handle: string): EffectiveCredentials {
  const readSetting = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const slot = readAccountCreds(db, platform)[handle];
  const cookie = slot?.cookie ?? '';
  const ua = readSetting(`ua.${platform}`);
  const csrf = readSetting(`csrf.${platform}`);
  return {
    ...(cookie ? { cookie } : {}),
    ...(csrf ? { csrf } : {}),
    ...(ua ? { ua } : {}),
  };
}

/**
 * 启动期一次性迁移（幂等）：旧版只有平台级 Cookie 时，把它复制给该平台每个还没有自己槽位的
 * 绑定账号，保证升级后各账号同步不中断。平台级键不删除——它随即转为影子值供非账号功能读取。
 *
 * 每平台只执行一次（settings 键 `accountCreds.migrated.<platform>` 台账）：没有台账的话，
 * 每次启动都会把影子值播种给「所有尚无槽位」的账号——用户显式清空的账号、新绑定还没配
 * Cookie 的账号，重启后都会被复活成影子值（即最后保存凭据那个账号的登录态），正是本模块
 * 要消灭的「静默借用他人登录态」。升级当刻已绑定、还没自己槽位的账号拿到的就是升级前实际
 * 共用的平台级 Cookie——这才是迁移的本意；此后的新账号与清空动作一律尊重现状。
 *
 * 台账**无条件**落（该平台首启时哪怕还没有影子值也记上）：影子值是运行期才写入的
 * （保存任一账号凭据时由 routes/settings.ts 镜像刷新），若「没有影子值就不落账」，
 * 全新安装/从未配过平台级 Cookie 的用户会在日后某次重启被这条迁移重新武装，
 * 把那时最后保存凭据的账号 Cookie 播种给所有无槽位账号（同一类静默借登录态）。
 * 台账与播种同事务：写槽位失败则台账一并回滚，下次启动重试，不会留下「记了没做」的残局。
 * @returns 是否发生了实际迁移（用于启动日志）
 */
export function migratePlatformCookieToAccounts(db: Db): boolean {
  const readSetting = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const setFlag = (key: string): void => {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, '1');
  };
  let migratedAny = false;
  for (const platform of Object.keys(COOKIE_FIELDS) as PlatformId[]) {
    const markerKey = `accountCreds.migrated.${platform}`;
    if (readSetting(markerKey)) continue;
    const legacy = readSetting(`cookie.${platform}`)?.trim();
    const accounts = legacy
      ? (db
          .prepare('SELECT handle FROM platform_accounts WHERE user_id = ? AND platform = ?')
          .all(DEFAULT_USER_ID, platform) as Array<{ handle: string }>)
      : [];
    const slots = legacy ? readAccountCreds(db, platform) : {};
    let changed = false;
    if (legacy) {
      for (const { handle } of accounts) {
        if (slots[handle]) continue;
        slots[handle] = { cookie: legacy };
        changed = true;
      }
    }
    // 台账无条件落（每平台一次），且与播种同一个事务：台账在前，是为了「本次没有账号可迁」
    // （比如升级时还没绑定过账号）也视为已迁移——否则该平台日后的新账号仍会吃影子值。
    // 但**不能**让台账在播种失败（磁盘满等）时单独留下：那会导致「已记已迁移、实际没播种」
    // 且永不重试，故两者同事务，写槽位失败则台账一并回滚、下次启动重来。
    db.exec('BEGIN');
    try {
      setFlag(markerKey);
      if (changed) writeAccountCreds(db, platform, slots);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (changed) migratedAny = true;
  }
  return migratedAny;
}

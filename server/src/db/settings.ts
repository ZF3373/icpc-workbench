/**
 * settings 小表的整表读取快照。
 *
 * `GET /api/settings` 一次要读十几个键（AI 配置、平台开关、Cookie、提醒、同步设置），
 * 原先每处都 `db.prepare('SELECT value FROM settings WHERE key = ?')` 再逐 key 查询：
 * 一次请求 15+ 次同名查询，且每次调用都重新编译同一条语句。settings 只有几十行，
 * 一条 `SELECT key, value` 建 Map 复用，语义完全等价。
 *
 * **刻意不做模块级缓存**：settings 会被同步调度、凭据保存、导入、备份恢复等多条路径随时
 * 改写，进程级缓存一旦失效不及时，就会出现「刚保存的设置读不回来」。这里只做**请求内快照**：
 * 调用方在读取开始时取一次、整段复用；任何写操作之后都必须重新取快照（或走即时查询）。
 */
import type { Db } from './index.ts';

/** 单个 key 的读取函数：快照与即时查询同签名，调用方可互换。 */
export type SettingLookup = (key: string) => string | undefined;

/** 一次 `SELECT key, value FROM settings` 的整表快照（值均为 TEXT，与表结构一致）。 */
export function readSettingsSnapshot(db: Db): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** 把快照包装成读取函数（缺省返回 undefined，与 `row?.value` 同口径）。 */
export function snapshotLookup(snapshot: ReadonlyMap<string, string>): SettingLookup {
  return (key) => snapshot.get(key);
}

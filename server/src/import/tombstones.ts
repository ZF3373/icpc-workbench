import type { Db } from '../db/index.ts';

/**
 * 删除墓碑（deleted_problems）判定，提交同步与题库入库共用一份口径。
 *
 * 墓碑要挡两件事：① 用户删掉的题被下次同步/题库播种原样复活（issue #27）；
 * ② 等价类（同平台、同标题、题号只差空格与大小写）用变体键绕回同一道题，再造一行重复
 * —— 所以匹配按 normalized_key 而非原始键，删掉 '1a' 后下发 '1A' 也挡得住。
 *
 * 但 clean-tags 去重给被删重复行记的墓碑，与**保留行**天生同属一个等价类：只看等价类会把
 * 保留行此后所有的同步提交与题库更新一起永久挡掉（表现为「这道题同步多少次都不涨」）。
 * 故加一条放行：写入的题号在库中已有完全相同的行时放行 —— 那是更新保留行，
 * 既不会复活已删的那一行，也不会新增等价类里的第二行。
 */
export interface TombstoneMatcher {
  isDeleted(platform: string, problemKey: string): boolean;
  /** 题目行有新增 / 墓碑被清掉（手动导入显式找回、换账号重置）后让该平台缓存失效 */
  forget(platform: string): void;
}

/**
 * 与 SQL `LOWER(REPLACE(x, ' ', ''))` 同口径：SQLite 的 LOWER 只对 ASCII 生效，
 * 这里也只做 ASCII 折叠，否则同一题号会在两侧算出不同的键。
 */
function normalizedKey(problemKey: string): string {
  return problemKey.replace(/ /g, '').replace(/[A-Z]/g, (c) => c.toLowerCase());
}

interface PlatformTombstones {
  /** 墓碑记录的原始题号（精确同键） */
  exact: Set<string>;
  /** 墓碑记录的归一化键 */
  classes: Set<string>;
  /** 库中现存题目的原始题号：命中即「更新已有行」，不属于复活/重建 */
  liveKeys: Set<string>;
}

export function createTombstoneMatcher(db: Db): TombstoneMatcher {
  const cache = new Map<string, PlatformTombstones>();

  const load = (platform: string): PlatformTombstones => {
    const hit = cache.get(platform);
    if (hit) return hit;
    const tombstones = db
      .prepare('SELECT problem_key, normalized_key FROM deleted_problems WHERE platform = ?')
      .all(platform) as Array<{ problem_key: string; normalized_key: string }>;
    const live = db.prepare('SELECT problem_key FROM problems WHERE platform = ?').all(platform) as Array<{
      problem_key: string;
    }>;
    const loaded: PlatformTombstones = {
      exact: new Set(tombstones.map((t) => t.problem_key)),
      classes: new Set(tombstones.map((t) => t.normalized_key)),
      liveKeys: new Set(live.map((r) => r.problem_key)),
    };
    cache.set(platform, loaded);
    return loaded;
  };

  return {
    isDeleted(platform, problemKey) {
      const t = load(platform);
      if (t.liveKeys.has(problemKey)) return false;
      return t.exact.has(problemKey) || t.classes.has(normalizedKey(problemKey));
    },
    forget(platform) {
      cache.delete(platform);
    },
  };
}

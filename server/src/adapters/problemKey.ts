/**
 * 平台题号（problem_key）的**形态判定与归一候选**——只做纯字符串处理，不碰网络与数据库。
 *
 * 为什么单独一个模块：这份规则同时被三处使用，必须是同一份真源 ——
 *   ① 回填查询侧（`analysis/difficultyBackfill.ts` 按候选逐个查整表）；
 *   ② 「整表查不到 = 上游没有」的**定论形态校验**（`absenceIsDefinitive`）；
 *   ③ 老库数据修复迁移（`db/index.ts` 作废旧判据写下的定论）。
 * 放在 db 层或某个适配器里都会让另外两处要么依赖倒置、要么各写一份规则。
 */
import type { PlatformId } from '../../../shared/src/index.ts';

// ---------- AtCoder（kenkoooo） ----------

/**
 * kenkoooo 题号 = `${contest_id}_${problem_index}`；本正则把它拆成「比赛前缀 + 题号后缀」。
 *
 * 后缀形态来自实测：单字母（a…h）、双字母（`ex`）、字母+数字（`f2`）、纯数字（`practice_1`、
 * JOI 的 `joi2011ho1`）。前缀里的下划线可选 —— 正因为**存在原生就没有下划线的题号**
 * （2026-09-28 实测 kenkoooo problems.json 9597 条里有 20 条无下划线，全是 `joi20NNhoN`），
 * 所以「没有下划线」本身不能当作「形态不对」的判据。
 */
const ATCODER_ID_TAIL = /^(.*?)(?:_)?([a-z]{1,2}[0-9]?|\d{1,2})$/;

/** 拆解 AtCoder 题号为「比赛前缀 + 题号后缀」；无法拆解（空串/异形）返回 null */
export function splitAtcoderProblemId(raw: string): { prefix: string; index: string } | null {
  const key = raw.trim().toLowerCase();
  if (key === '') return null;
  const m = ATCODER_ID_TAIL.exec(key);
  if (!m || m[1] === '' || m[2] === '') return null;
  return { prefix: m[1], index: m[2] };
}

/**
 * 比赛前缀（`abc300_a` / `abc300a` / `abc308i` → `abc300` / `abc300` / `abc308`）。
 * 用途：整表形态校验 —— 「前缀在整表里存在」说明库内题号的**比赛部分是真实存在的**，
 * 此时「整表查无此题」才可信（见 difficultyBackfill 的 absenceIsDefinitive）。
 */
export function atcoderContestPrefix(raw: string): string | null {
  return splitAtcoderProblemId(raw)?.prefix ?? null;
}

/**
 * 查询 kenkoooo 整表时的**候选题号**（原样优先，其次补下划线的规范形态）。
 *
 * 起因（2026-09-28 取证）：库内有一批题号是**展示形态** `abc300a`，而 kenkoooo 是 `abc300_a`
 * → 整表查不到；atcoder 又属于「单次响应即完整题库」（ABSENCE_IS_DEFINITIVE），
 * 这个 miss 被当成定论写下 30 天负缓存 → 90 行永久「无官方难度」且不再重查
 * （本机 demo 库实测：100 行里 10 行直接命中、64 行补一个下划线即命中、26 行两形态都不在整表）。
 *
 * 原样优先（而不是只试规范形态）的原因：`joi2011ho1` 这类题号**本身就是规范的**，
 * 补下划线反而会查不到 —— 候选表必须保序且以库内原键打头。
 * 写库仍按库内原键（不动数据、不需要迁移），与牛客的 `NC20000 → 20000` 归一同一策略。
 */
export function atcoderProblemIdCandidates(raw: string): string[] {
  const key = raw.trim().toLowerCase();
  if (key === '') return [];
  const out = [key];
  if (!key.includes('_')) {
    const split = splitAtcoderProblemId(key);
    if (split !== null) {
      const canonical = `${split.prefix}_${split.index}`;
      if (canonical !== key) out.push(canonical);
    }
  }
  return out;
}

// ---------- 形态校验（写定论前的最后一道闸） ----------

/**
 * 库内题号的形态是否**有可能**是整表键 —— 只排除明显不可能的异形键。
 *
 * 这是「整表查不到 = 上游没有」这条定论的**前置条件**（见 analysis/difficultyBackfill.ts 的
 * absenceIsDefinitive）：形态本身不可信时，「查不到」什么都证明不了，写 30 天负缓存就会把
 * 拼写/形态差异固化成「平台无公开难度」（2026-09-28 AtCoder 展示形态那个真 bug 的成因）。
 *
 * 各平台判据与各自的保守度：
 * - atcoder：必须能拆成「比赛前缀 + 题号后缀」（动态那一步 —— 前缀是否真在整表里 ——
 *   由调用方拿整表再判，这里只做便宜的静态排除）。
 * - codeforces：整表键是 `${contestId}${index}`（大小写不敏感，查表前已大写归一），
 *   故只要求「数字开头、后面至少再跟一个字母或数字」。
 *   **刻意保守**：CF 实测存在纯数字题号（如 `92101` = 比赛 921 + 题号 `01`），
 *   静态规则无法把「纯数字的合法键」与「手滑写短的键」分开 —— 这里宁可不拦，
 *   拦错了只会让本可定论的行每轮重查一次（整表平台重查不额外发逐题请求）。
 */
export function isPlausibleProblemKey(platform: PlatformId, raw: string): boolean {
  const key = raw.trim();
  if (key === '') return false;
  if (platform === 'atcoder') return splitAtcoderProblemId(key) !== null;
  if (platform === 'codeforces') return /^\d+[A-Z0-9]+$/.test(key.toUpperCase());
  return true; // 未登记的平台不做限制（调用方另有 ABSENCE_IS_DEFINITIVE 白名单）
}

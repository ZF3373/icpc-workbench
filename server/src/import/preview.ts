import type { NormalizedSubmission } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { createTombstoneMatcher } from './tombstones.ts';

/**
 * 导入变更预览：不写库，按 insertNormalized 的去重规则对每行做分类，
 * 供客户端在真正导入前展示「新增 / 跳过 / 题目变化 / 非法行」。
 */
export interface ImportPreview {
  /** 将新增的提交记录数（external_id 未见过，且不命中手动协调/墓碑跳过规则） */
  newSubmissions: number;
  /** 同账号下 external_id 已存在 → 插入被 UNIQUE(user,platform,account,external_id) 拦截，跳过 */
  duplicateSkips: number;
  /** manual: 前缀行且「同平台同题同结果」已存在 → 协调规则跳过 */
  manualSkips: number;
  /** 命中删除墓碑且非 manual: 前缀 → insertNormalized 会静默丢弃（题与提交都不入库） */
  tombstoneSkips: number;
  /** 将新创建的题目数 */
  problemCreates: number;
  /** 已存在、导入时会补充/更新元信息的题目数 */
  problemUpdates: number;
}

export function previewImport(
  db: Db,
  userId: number,
  subs: NormalizedSubmission[],
  opts: { account?: string | null } = {},
): ImportPreview {
  // 与 insertNormalized 同一口径：account 缺省 ''（手动导入等无账号来源）。
  // ⚠ 去重必须按 account 分桶：submissions 的唯一键是 (user_id, platform, account, external_id)。
  // 漏掉 account 时，只要**别的账号**已有同一提交号，预览就会把它算成「重复跳过」，
  // 而真实导入（account=''）根本不冲突、照常插入 —— 预览谎报「新增 0 条」。
  const account = opts.account ?? '';
  const externalIdExists = db.prepare(
    'SELECT 1 FROM submissions WHERE user_id = ? AND platform = ? AND account = ? AND external_id = ? LIMIT 1',
  );
  // 与 insertNormalized 的 manualDup 同一规则：同平台同题同结果已存在 → 跳过
  const manualDup = db.prepare(
    `SELECT 1 FROM submissions s JOIN problems p ON s.problem_id = p.id
     WHERE s.user_id = ? AND s.platform = ? AND p.problem_key = ? AND s.verdict = ?
     LIMIT 1`,
  );
  const problemOf = db.prepare(
    'SELECT id, title, difficulty, url FROM problems WHERE platform = ? AND problem_key = ?',
  );
  // 与 insertNormalized 同一口径的墓碑判定：命中墓碑的非 manual 行整个不入库
  const tombstones = createTombstoneMatcher(db);

  const preview: ImportPreview = {
    newSubmissions: 0,
    duplicateSkips: 0,
    manualSkips: 0,
    tombstoneSkips: 0,
    problemCreates: 0,
    problemUpdates: 0,
  };
  // 每个题目键的行级分类：insertNormalized 对**非墓碑行**都会 upsert 题目行（提交重复的行
  // 也会刷新标题/标签等元数据），故题目级「新建/更新」的门槛是至少一行非墓碑
  const problems = new Map<string, { upserted: boolean; exists: boolean }>();
  // manual 行命中墓碑 = 用户显式找回（insertNormalized 会清墓碑）：同键的后续行要放行。
  // 只记精确同键——等价类变体键维持保守（预览仍按墓碑跳过计），混合来源文件里属罕见边角
  const clearedKeys = new Set<string>();

  for (const s of subs) {
    const isManual = String(s.externalId).startsWith('manual:');
    const pKey = `${s.problem.platform}:${s.problem.problemKey}`;
    let entry = problems.get(pKey);
    if (!entry) {
      entry = {
        upserted: false,
        exists: problemOf.get(s.problem.platform, s.problem.problemKey) !== undefined,
      };
      problems.set(pKey, entry);
    }

    // 提交级分类：分支顺序必须与 insertNormalized 一致（墓碑 → manual 协调 → external_id 去重）。
    // insertNormalized 先判 manualDup、再走 INSERT OR IGNORE，所以同一条 manual 行**同时**命中
    // 「同题同结果已存在」与「提交号已存在」时，实际归因是前者；预览若把 external_id 去重放前面，
    // 就会把同一行报成「重复跳过」——两处口径一旦漂移，预览的明细就与真实导入的规则不符
    const tombstoned =
      !clearedKeys.has(pKey) && tombstones.isDeleted(s.problem.platform, s.problem.problemKey);
    if (tombstoned && isManual) clearedKeys.add(pKey);
    if (tombstoned && !isManual) {
      preview.tombstoneSkips += 1;
      continue;
    }
    entry.upserted = true;
    let written = true;
    if (isManual) {
      const dup = manualDup.get(userId, s.problem.platform, s.problem.problemKey, s.verdict);
      if (dup) {
        preview.manualSkips += 1;
        written = false;
      }
    }
    if (written && externalIdExists.get(userId, s.problem.platform, account, s.externalId)) {
      preview.duplicateSkips += 1;
      written = false;
    }
    preview.newSubmissions += written ? 1 : 0;
  }

  // 题目级分类：只有至少一行非墓碑的题目才会被 upsert
  for (const entry of problems.values()) {
    if (!entry.upserted) continue;
    if (entry.exists) preview.problemUpdates += 1;
    else preview.problemCreates += 1;
  }
  return preview;
}

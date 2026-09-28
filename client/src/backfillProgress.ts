/**
 * 难度回填的状态文案纯函数（组件只负责取值与渲染，口径在这里定死、可单测）。
 *
 * 为什么值得单独抽出来：这几句话决定用户对三件事的判断 ——
 *   1. 现在跑到哪了（`progressText`：哪个平台、第几题 / 共几题，本轮共几题）；
 *   2. 「停止」是否生效（`stopping` → 「正在停止…」）；
 *   3. 停完之后还剩多少、怎么继续（`resultText` 首句「已停止」+ 「再点一次继续」）。
 * 与 client/src/syncStatus.ts 同款做法（文案是稳定契约，不能散落在 JSX 里）。
 */

/** `GET /api/problems/backfill-difficulty/run` 的 run 字段（与 server 的 BackfillRunStatus 对应） */
export interface BackfillRunStatus {
  running: boolean;
  stopping: boolean;
  startedAt: string | null;
  platform: string | null;
  platformDone: number;
  platformTotal: number;
  done: number;
  total: number;
}

/** 单平台回填结果（与 server 的 PlatformBackfillResult 对应；details 在界面上不展示） */
export interface BackfillPlatformResult {
  platform: string;
  scanned: number;
  filled: number;
  nativeFilled: number;
  repaired: number;
  missing: number;
  /** 上游明确拒绝提供该题（401/403：已删除/私有）的题数；旧服务端不返回该字段（可选） */
  denied?: number;
  failed: number;
  capped: number;
  deferred: number;
  cached: number;
  stopped?: boolean;
}

/** `POST /api/problems/backfill-difficulty` 的响应体 */
export interface BackfillResponse {
  ok: boolean;
  /** 本轮被用户停止（results 只覆盖已处理的部分） */
  stopped?: boolean;
  results: BackfillPlatformResult[];
  unknownLeft: number;
}

/**
 * 「回填进行中」那行字；未运行时返回空串（按钮回到「一键回填」语义）。
 * @param nameOf 平台 id → 中文名（组件传 platformName，纯函数不依赖 UI 层）
 */
export function progressText(run: BackfillRunStatus | null, nameOf: (platform: string) => string): string {
  if (run === null || run.running !== true) return '';
  if (run.stopping) return '正在停止…（在途请求立即中断，已落库的保留）';
  // 平台与规模都还没定：首批目标正在分组（不编数字）
  if (run.platform === null || run.total === 0) return '正在准备…';
  return `正在处理 ${nameOf(run.platform)} ${run.platformDone}/${run.platformTotal}（本轮共 ${run.total} 题）`;
}

/**
 * 回填结束后的一句话汇总。
 * 被停止时首句必须是「已停止」——不能让用户以为整轮跑完了（那样会以为「没有缺的题了」）。
 */
export function resultText(r: BackfillResponse, nameOf: (platform: string) => string): string {
  const parts = r.results.map((x) => {
    const name = nameOf(x.platform);
    // QOJ 平台自身没有难度字段（靠 ICPC/CCPC 公开榜单推导）：`missing` 的含义是**推不出来**
    // （题号映射缺失 / 榜单源不可用 / 本轮上限），不是「上游未评级」——两个说法对用户完全不同
    const missing = x.missing
      ? x.platform === 'qoj'
        ? `、推不出难度 ${x.missing} 题（公开榜单未匹配）`
        : `、官方无难度 ${x.missing} 题`
      : '';
    // denied（上游明确拒绝：已删除/私有）与 missing（题还在、只是没评级）分开说 ——
    // 前者意味着「再等也不会有难度」，后者是「平台就没给这道题评级」，用户要做的事不同
    return `${name}：补难度 ${x.filled} 题、补原生难度 ${x.nativeFilled} 题、修标题/标签/难度值 ${x.repaired} 题${missing}${x.denied ? `、无公开来源 ${x.denied} 题（上游已下架/私有）` : ''}${x.cached ? `、${x.cached} 题维持「无官方难度」（已问过上游，不再重复查询）` : ''}${x.failed ? `、失败 ${x.failed} 题` : ''}${x.deferred ? `、跳过 ${x.deferred} 题（难度已有、仅缺原生值）` : ''}${x.capped ? `、本次上限外还有 ${x.capped} 题（再点一次继续）` : ''}`;
  });
  if (parts.length === 0) {
    return r.stopped === true
      ? `已停止（还没轮到任何平台）。全库剩余未知难度 ${r.unknownLeft} 题，再点一次继续`
      : '库内没有待回填难度的题';
  }
  const head = r.stopped === true ? '已停止（已落库的成果不受影响）：' : '';
  const tail = r.stopped === true ? '（再点一次继续补剩下的题）' : '';
  return `${head}${parts.join('；')}。全库剩余未知难度 ${r.unknownLeft} 题${tail}`;
}

/**
 * 难度回填的**进程内**运行状态：供「停止回填」与「回填进行中 N/M」查询使用。
 *
 * 为什么需要它（用户反馈：一次回填要几十分钟，中途只能干等）：
 * - 回填是**一个同步 HTTP 请求**里跑完的（见 routes/problems.ts），关掉页面 / 刷新页面时
 *   服务端并不会停 —— 前端只靠自己的 `busy` 状态判断，刷新后就完全不知道后台还在跑。
 *   把运行状态放在服务端，`GET /run` 就能让刷新后的页面继续显示进度并给出停止入口。
 * - 「停止」必须是**服务端**动作：前端 abort 只会让界面不再刷新，服务端仍会继续写库。
 *   这里持有本次运行的 `AbortController`，由 `POST /stop` 触发；中止信号一路传到每次上游请求
 *   （见 difficultyBackfill 的 withAbortSignal），在途请求立即失败，已提交批次留在库里。
 *
 * 边界（有意不做的事）：
 * - **不跨进程持久化**：服务重启后运行状态必然丢失（本来就会中断回填）。已落库的成果由
 *   分批提交保证，重启后重新点击即从库里剩下的缺口继续 —— 这正是「可分多次回填」。
 * - **只允许一个回填在跑**（`beginBackfillRun` 返回 null = 已在运行）：并发跑两轮会同时打同一
 *   批上游、互相抢写同一批行，除了更快触发风控没有任何好处。
 */

/** 一次回填的实时状态（`GET /api/problems/backfill-difficulty/run` 的响应体） */
export interface BackfillRunStatus {
  /** 是否有回填在跑（`stopping` 期间仍为 true，直到运行真正收尾） */
  running: boolean;
  /** 已受理停止请求、正在收尾（界面显示「正在停止…」） */
  stopping: boolean;
  /** 本次运行开始时刻（ISO；未运行时为 null） */
  startedAt: string | null;
  /** 当前平台；尚未确定（首批目标还没分组完）为 null */
  platform: string | null;
  /** 当前平台已处理题数 / 该平台本轮目标数 */
  platformDone: number;
  platformTotal: number;
  /** 本轮累计已处理题数 / 本轮目标总数（跨平台） */
  done: number;
  total: number;
}

/** `onProgress` 回调的入参（字段与 BackfillRunStatus 的进度部分一致） */
export interface BackfillProgress {
  platform: string;
  platformDone: number;
  platformTotal: number;
  done: number;
  total: number;
}

interface ActiveRun {
  controller: AbortController;
  startedAt: string;
  stopping: boolean;
  platform: string | null;
  platformDone: number;
  platformTotal: number;
  done: number;
  total: number;
}

/** 当前运行（null = 没有回填在跑）；同一时刻最多一个 */
let active: ActiveRun | null = null;

/** 停止时传给上游请求的中止原因（错误消息会出现在日志/结果说明里，写清楚是谁停的） */
export function backfillStopReason(): Error {
  return new Error('回填已被用户停止');
}

/**
 * 开始一次回填；**已在运行则返回 null**（调用方据此回 409，不并发跑第二轮）。
 * 返回的 signal 要一路传到 `backfillDifficulties`：它中止时在途请求立即失败、循环退出。
 */
export function beginBackfillRun(): AbortSignal | null {
  if (active !== null) return null;
  active = {
    controller: new AbortController(),
    startedAt: new Date().toISOString(),
    stopping: false,
    platform: null,
    platformDone: 0,
    platformTotal: 0,
    done: 0,
    total: 0,
  };
  return active.controller.signal;
}

/** 请求停止当前回填；没有在跑则返回 false（幂等：连点两次不会出错） */
export function requestBackfillStop(): boolean {
  if (active === null) return false;
  active.stopping = true;
  if (!active.controller.signal.aborted) active.controller.abort(backfillStopReason());
  return true;
}

/** 上报进度（由 backfillDifficulties 在每个平台开始与每处理完一题时调用） */
export function setBackfillProgress(p: BackfillProgress): void {
  if (active === null) return;
  active.platform = p.platform;
  active.platformDone = p.platformDone;
  active.platformTotal = p.platformTotal;
  active.done = p.done;
  active.total = p.total;
}

/** 收尾：**必须在 finally 里调用**（成功 / 失败 / 被停止都要走到），否则后续点击会一直撞 409 */
export function finishBackfillRun(): void {
  active = null;
}

/** 当前状态快照（未运行时返回全 false / null，前端据此回到「一键回填」语义） */
export function currentBackfillRun(): BackfillRunStatus {
  if (active === null) {
    return {
      running: false,
      stopping: false,
      startedAt: null,
      platform: null,
      platformDone: 0,
      platformTotal: 0,
      done: 0,
      total: 0,
    };
  }
  return {
    running: true,
    stopping: active.stopping,
    startedAt: active.startedAt,
    platform: active.platform,
    platformDone: active.platformDone,
    platformTotal: active.platformTotal,
    done: active.done,
    total: active.total,
  };
}

/** 测试用：清空运行状态（用例之间互不污染；生产路径只经 begin/finish） */
export function __resetBackfillRunForTest(): void {
  active = null;
}

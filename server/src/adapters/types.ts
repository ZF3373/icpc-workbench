import type { NormalizedSubmission, PlatformId } from '../../../shared/src/index.ts';

/**
 * 平台无公开提交 API 或反爬拦截时抛出。
 * 同步层识别该错误后，在结果中给出"引导手动导入"提示，而非视为同步失败。
 */
export class ManualImportRequiredError extends Error {
  readonly code = 'MANUAL_REQUIRED' as const;
  constructor(platform: string, reason: string) {
    super(`[${platform}] ${reason}`);
    this.name = 'ManualImportRequiredError';
  }
}

export interface FetchOptions {
  /** 增量同步起点（ISO8601 UTC，平台支持时使用；不支持则忽略） */
  since?: string;
  /** 平台登录 Cookie（洛谷/牛客等需登录平台使用） */
  cookie?: string;
  /** 平台 CSRF token（历史遗留；同步请求均为 GET，无需用户提供） */
  csrf?: string;
  /**
   * 库中已有的平台提交号集合（同步层注入）。
   * 拉取结果按新到旧排序的适配器可用它提前终止分页（整页已知 → 更旧的都在库中），
   * 并跳过已知条目，实现真实增量拉取。
   */
  knownExternalIds?: Set<string>;
  /** 分页间隔（毫秒），仅测试用：传 0 跳过限速 sleep，缺省由适配器自定（洛谷 300ms） */
  pageDelayMs?: number;
  /**
   * 单次同步最多拉取的「新增」提交数（同步层注入，默认 1000）。
   * 适配器在新增条目达到该值时停止翻页，并通过 truncated 回传信号，
   * 同步层据此将本次标记为分批截断——下次同步自动进入补全模式继续拉取更早的历史，
   * 从而把原本一次性的全量拉取拆成多次小批量，避免触发平台风控封号。
   */
  maxSubmissions?: number;
  /**
   * 补全模式（同步层注入：上次同步被 truncated 时为 true）。
   * 为 true 时，适配器不应在「整页已知」处提前终止，而应跳过已知页继续向更旧翻页，
   * 以补全上次未拉完的早期历史；为 false/缺省时维持原增量早停行为。
   */
  backfill?: boolean;
  /**
   * 【适配器 → 同步层 回传】本次是否因触及 maxSubmissions 上限而提前停止。
   * 适配器在停止时置 true；同步层读取后决定是否推进 last_sync_at / 置 sync_truncated。
   * 作为 FetchOptions 上的可变 out 字段实现，避免改动 fetchUserSubmissions 的返回类型。
   */
  truncated?: boolean;
  /**
   * 补全续拉游标（同步层注入：platform_accounts.backfill_page）。
   * 页码型平台（洛谷/牛客/力扣/代码源）补全时从该页续拉更早历史，避免从头重扫已知页；
   * 缺省/1 表示从最新页开始。CF 用 from 偏移、AtCoder 用 since（升序续拉），不读此字段。
   */
  backfillFromPage?: number;
  /**
   * 【适配器 → 同步层 回传】本次补全拉到的最深页码，同步层存入 backfill_page 供下次续拉。
   * 仅页码型平台在补全模式下回写；自然结束时同步层会清空 backfill_page。
   */
  backfillReachedPage?: number;
}

/**
 * 平台适配器统一接口。
 * 新增平台只需实现本接口并在 adapters/index.ts 注册。
 */
export interface PlatformAdapter {
  readonly platform: PlatformId;

  /** 声明支持 knownExternalIds 提前终止（同步层才会注入该参数） */
  readonly knownIdsFilter?: boolean;

  /**
   * 拉取用户在平台上的提交记录（含题目信息），输出统一结构。
   * @param handle 平台用户名 / uid
   * @param opts.since / opts.cookie / opts.csrf 同步参数（同步层从 settings 注入）
   * @param opts.maxSubmissions 单次拉取新增上限（分批防封号）；触及上限时置 opts.truncated=true
   * @param opts.backfill 补全模式：跳过已知页继续向更旧翻页，不因整页已知而提前终止
   */
  fetchUserSubmissions(
    handle: string,
    opts?: FetchOptions,
  ): Promise<NormalizedSubmission[]>;

  /** 构造题目跳转链接（桌面挂件 / 计划任务跳转使用）。 */
  problemUrl(problem: {
    problemKey: string;
    [k: string]: unknown;
  }): string;

  /**
   * 校验登录凭据（需登录平台实现；公开 API 平台无需实现）。
   * 设置页「检测 Cookie」按钮调用，用于在同步前发现 Cookie 过期。
   * @param opts.handle 已绑定账号的用户名/uid（设置页注入）：检测需访问"自己的"数据页时使用
   */
  checkAuth?(opts: {
    cookie: string;
    csrf?: string;
    handle?: string;
  }): Promise<{ ok: boolean; message: string }>;
}

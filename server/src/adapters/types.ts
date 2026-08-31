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
   */
  checkAuth?(opts: { cookie: string; csrf?: string }): Promise<{ ok: boolean; message: string }>;
}

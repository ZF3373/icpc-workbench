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

/**
 * 平台适配器统一接口。
 * 新增平台只需实现本接口并在 adapters/index.ts 注册。
 */
export interface PlatformAdapter {
  readonly platform: PlatformId;

  /**
   * 拉取用户在平台上的提交记录（含题目信息），输出统一结构。
   * @param handle 平台用户名 / uid
   * @param opts.since 增量同步起点（ISO8601 UTC，平台支持时使用；不支持则忽略）
   */
  fetchUserSubmissions(
    handle: string,
    opts?: { since?: string },
  ): Promise<NormalizedSubmission[]>;

  /** 构造题目跳转链接（桌面挂件 / 计划任务跳转使用）。 */
  problemUrl(problem: {
    problemKey: string;
    [k: string]: unknown;
  }): string;
}

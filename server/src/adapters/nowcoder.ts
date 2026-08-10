import type { NormalizedSubmission } from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';
import { ManualImportRequiredError } from './types.ts';

/**
 * 牛客适配器（受限）：牛客 ACM 无公开提交记录 API（需登录）。
 * 同洛谷：明确抛出 ManualImportRequiredError，引导手动导入。
 */
export function createNowcoderAdapter(): PlatformAdapter {
  return {
    platform: 'nowcoder',

    async fetchUserSubmissions(): Promise<NormalizedSubmission[]> {
      throw new ManualImportRequiredError(
        'nowcoder',
        '牛客无公开提交记录 API（需登录），请使用手动导入（JSON/CSV 上传或表单录入）',
      );
    },

    problemUrl({ problemKey }) {
      return `https://ac.nowcoder.com/acm/problem/${String(problemKey)}`;
    },
  };
}

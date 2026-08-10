import type { NormalizedSubmission } from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';
import { ManualImportRequiredError } from './types.ts';

/**
 * 洛谷适配器（受限）：洛谷无公开提交记录 API（需登录 + 强反爬）。
 * fetchUserSubmissions 明确抛出 ManualImportRequiredError，
 * 同步层将其转为"引导手动导入"提示；题目链接正常提供。
 */
export function createLuoguAdapter(): PlatformAdapter {
  return {
    platform: 'luogu',

    async fetchUserSubmissions(): Promise<NormalizedSubmission[]> {
      throw new ManualImportRequiredError(
        'luogu',
        '洛谷无公开提交记录 API（需登录且反爬较强），请使用手动导入（JSON/CSV 上传或表单录入）',
      );
    },

    problemUrl({ problemKey }) {
      return `https://www.luogu.com.cn/problem/${String(problemKey)}`;
    },
  };
}

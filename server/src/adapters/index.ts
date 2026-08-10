import { createAtcoderAdapter } from './atcoder.ts';
import { createCodeforcesAdapter } from './codeforces.ts';
import { createLuoguAdapter } from './luogu.ts';
import { createNowcoderAdapter } from './nowcoder.ts';
import { register } from './registry.ts';

// 各平台适配器统一在此注册；平台级开关（enabled）由同步 API 按 settings 过滤。
let initialized = false;

/** 在 server 启动时调用一次，传入 dataDir 供适配器做资源缓存。 */
export function initAdapters(dataDir?: string): void {
  if (initialized) return;
  initialized = true;
  register(createCodeforcesAdapter());
  register(createAtcoderAdapter(dataDir));
  register(createLuoguAdapter());
  register(createNowcoderAdapter());
}

export * from './registry.ts';
export type { PlatformAdapter } from './types.ts';

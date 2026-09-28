/**
 * QOJ 专属传输层（**单例**）：HTTP/1.1 + 按域名节流。
 *
 * 两个理由必须共用同一个实例：
 * 1. **HTTP/1.1**：qoj.ac 前置 Cloudflare 对 HTTP/2 请求恒定下发托管挑战（403 + `cf-mitigated`），
 *    换 1.1 即放行（见 adapters/http1.ts 的实测说明）；
 * 2. **同一个节奏桶**：提交同步（adapters/qoj.ts）与难度回填（analysis/icpcBoard.ts 读比赛页）
 *    都会打 qoj.ac。若各自 `createHostThrottle`，两个桶互不知情，实际频率会翻倍
 *    —— 正是本项目要避免的风控来源。因此这里收敛成一个惰性单例，两处都取它。
 */
import { createHttp1Fetch } from '../adapters/http1.ts';
import {
  createHostThrottle,
  DEFAULT_HOST_MIN_INTERVAL_MS,
  HOST_MIN_INTERVAL_MS,
} from './hostThrottle.ts';

let transport: typeof fetch | null = null;

/** 取共享的 QOJ 传输层（首次调用时创建；间隔表与全局节流一致，受「拉取速度」倍率影响） */
export function qojTransportFetch(): typeof fetch {
  transport ??= createHostThrottle(createHttp1Fetch({ timeoutMs: 30_000 }), {
    minIntervalMs: HOST_MIN_INTERVAL_MS,
    defaultMinIntervalMs: DEFAULT_HOST_MIN_INTERVAL_MS,
  }).fetch;
  return transport;
}

/**
 * WebView 同源代理通道（多平台）。
 *
 * 背景（2026-10-11 实测 QOJ，2026-11 实测 VJudge 同类）：站点前置的 Cloudflare 把
 * 通行凭据绑定到**签发客户端的指纹**（TLS/JA3 + UA 组合）——WebView2 签发的 Cookie
 * 拿到 Node（OpenSSL TLS）里重放，无论 UA 是否逐字节一致、无论 Cookie 多新鲜，一律
 * 403 挑战。VJudge 更甚：连无需登录的公开记录接口也对 Node 指纹恒定下挑战（curl 的
 * Schannel 指纹可过、Node 的 OpenSSL 指纹必拦），Cookie 重放路线彻底失效。
 *
 * 唯一稳健的通道：让桌面壳的内嵌 WebView **自己**去取——在目标站页面上下文里发同源
 * fetch（完美指纹 + 真实登录态，Cloudflare 无法区分），把响应体交回服务器解析。
 * 流程：适配器 fetchPageViaAgent 入队（按平台）→ 壳注入的守护脚本（各自域名下自轮询）
 * GET /next?platform=X 领任务 → 页面内 fetch → POST /result 回传 → 入队侧 Promise 兑现。
 * 解析 / 去重 / 同步编排零改动（只是传输层换了）。
 *
 * 安全：/next 只向外发任务（内部 URL）；/result 只接受**有 pending 任务**的 id
 * （resolveJob 校验，未知 id 拒绝），且 CORS 限定各平台自己的源——其他页面既读不到
 * 任务也注入不了结果。任务只在用户触发同步/检测时存在。
 */

/** 接入同源代理的平台（各自一个隐藏助手窗口 + 守护脚本） */
export type AgentPlatform = 'qoj' | 'vjudge';

const PLATFORM_LABEL: Record<AgentPlatform, string> = { qoj: 'QOJ', vjudge: 'VJudge' };

/** 一页抓取的结果（status 为页面响应码；登录跳转经 follow 后由 finalUrl/登录页特征判定） */
export interface AgentPageResult {
  status: number;
  body: string;
  finalUrl?: string;
}

interface PendingJob {
  resolve: (r: AgentPageResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  platform: AgentPlatform;
}

let nextJobId = 1;
const queue: Array<{ id: number; url: string; platform: AgentPlatform }> = [];
const pending = new Map<number, PendingJob>();
const agentSeenAt: Record<AgentPlatform, number> = { qoj: 0, vjudge: 0 };

/** 守护脚本活跃判定窗口（脚本空闲轮询间隔 4s，容忍 5 拍丢失） */
const ALIVE_WINDOW_MS = 20_000;
/** 单页抓取默认超时（页面加载 + 可能的 Cloudflare 静默质询） */
export const DEFAULT_AGENT_TIMEOUT_MS = 30_000;
/** 结果体上限（提交列表页远小于此；防异常页面撑爆内存） */
const MAX_BODY_CHARS = 2_000_000;

/** 守护脚本不在线时的引导文案（按平台） */
function notReadyMessage(platform: AgentPlatform): string {
  const label = PLATFORM_LABEL[platform];
  return platform === 'qoj'
    ? 'QOJ 助手窗口未就绪：桌面版启动约 90 秒后自动就绪（保持软件打开即可）；也可在设置页点「在应用内登录 QOJ」立即打开，稍后重试同步。'
    : `${label} 助手窗口未就绪：桌面版启动后自动就绪（保持软件打开即可）；也可在设置页点「刷新 ${label} 助手窗口」立即打开，稍后重试同步。`;
}

/**
 * 经 WebView 同源代理抓取一页。队列按平台 FIFO，守护脚本一次取一单。
 * 守护脚本未就绪时先等它上线（壳启动后自动创建窗口），再入队计时。
 */
export async function fetchPageViaAgent(
  url: string,
  timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
  platform: AgentPlatform = 'qoj',
): Promise<AgentPageResult> {
  // 守护脚本不在线：等它上线（壳自愈窗口约 15-90 秒），最多等 20 秒
  const waitStart = Date.now();
  while (!agentAlive(platform)) {
    if (Date.now() - waitStart >= 20_000) {
      throw new Error(notReadyMessage(platform));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const id = nextJobId++;
  const result = new Promise<AgentPageResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(
          new Error(
            platform === 'qoj'
              ? 'QOJ 助手窗口抓取超时：请确认窗口保持打开且已登录 qoj.ac，稍后重试同步。'
              : `${PLATFORM_LABEL[platform]} 助手窗口抓取超时：请确认窗口保持打开，稍后重试同步。`,
          ),
        );
      }
    }, timeoutMs);
    // ⚠ 刻意不 unref：挂起任务的超时定时器必须撑住事件循环——
    // 否则测试等场景下循环被清空，pending Promise 会随进程一起被取消（CI 实测）
    pending.set(id, { resolve, reject, timer, platform });
  });
  queue.push({ id, url, platform });
  return result;
}

/** 守护脚本领取一个本平台任务（pop 语义）；空队列返回 null。顺带刷新本平台活跃时间。 */
export function popJob(platform: AgentPlatform = 'qoj'): { id: number; url: string } | null {
  agentSeenAt[platform] = Date.now();
  const idx = queue.findIndex((j) => j.platform === platform);
  if (idx < 0) return null;
  const [job] = queue.splice(idx, 1);
  return { id: job.id, url: job.url };
}

/** 某挂起任务所属平台（/result 据此校验回传源是否匹配）；未知 id 返回 undefined。 */
export function jobPlatform(id: number): AgentPlatform | undefined {
  return pending.get(id)?.platform;
}

/** 守护脚本回传结果：只接受有 pending 任务的 id（防伪造注入）。返回是否已兑现。 */
export function resolveJob(
  id: number,
  status: number,
  body: string,
  finalUrl?: string,
): boolean {
  const job = pending.get(id);
  if (!job) return false;
  pending.delete(id);
  clearTimeout(job.timer);
  job.resolve({ status, body: body.slice(0, MAX_BODY_CHARS), ...(finalUrl ? { finalUrl } : {}) });
  return true;
}

/** 守护脚本是否活跃（近期有轮询） */
export function agentAlive(platform: AgentPlatform = 'qoj'): boolean {
  return Date.now() - agentSeenAt[platform] < ALIVE_WINDOW_MS;
}

/** 测试辅助：清空全部状态（队列/等待方/活跃时间） */
export function resetAgentForTests(): void {
  for (const [, job] of pending) {
    clearTimeout(job.timer);
    job.reject(new Error('测试重置'));
  }
  pending.clear();
  queue.length = 0;
  agentSeenAt.qoj = 0;
  agentSeenAt.vjudge = 0;
  nextJobId = 1;
}
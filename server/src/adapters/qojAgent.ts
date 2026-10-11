/**
 * QOJ 页面抓取的「WebView 同源代理」通道。
 *
 * 背景（2026-10-11 实测）：qoj.ac 的 Cloudflare 已把 cf_clearance 绑定到**签发客户端的
 * 指纹**（TLS/JA3 + UA 组合）——WebView2 签发的 Cookie 拿到 Node（OpenSSL TLS）里重放，
 * 无论 UA 是否逐字节一致、无论 Cookie 多新鲜，一律 403 挑战。Cookie 重放路线对 qoj.ac
 * 已死（手动粘贴同样失效）。
 *
 * 唯一稳健的通道：让桌面壳的内嵌 WebView **自己**去取——在 qoj.ac 页面上下文里发同源
 * fetch（完美指纹 + 真实登录态，Cloudflare 无法区分），把 HTML 交回服务器解析。
 * 流程：适配器 fetchPageViaAgent 入队 → 壳注入的守护脚本（qoj_auth 域名下自轮询）
 * GET /next 领任务 → 页面内 fetch → POST /result 回传 → 入队侧 Promise 兑现。
 * 解析 / 去重 / 同步编排零改动（只是传输层换了）。
 *
 * 安全：/next 只向外发任务（内部 URL）；/result 只接受**有 pending 任务**的 id
 * （resolveJob 校验，未知 id 拒绝），且 CORS 限定 https://qoj.ac 源——其他页面既读不到
 * 任务也注入不了结果。任务只在用户触发同步/检测时存在。
 */

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
}

let nextJobId = 1;
const queue: Array<{ id: number; url: string }> = [];
const pending = new Map<number, PendingJob>();
let agentSeenAt = 0;

/** 守护脚本活跃判定窗口（脚本空闲轮询间隔 4s，容忍 5 拍丢失） */
const ALIVE_WINDOW_MS = 20_000;
/** 单页抓取默认超时（页面加载 + 可能的 Cloudflare 静默质询） */
export const DEFAULT_AGENT_TIMEOUT_MS = 30_000;
/** 结果体上限（提交列表页远小于此；防异常页面撑爆内存） */
const MAX_BODY_CHARS = 2_000_000;

/**
 * 经 WebView 同源代理抓取一页。队列 FIFO，守护脚本一次取一单。
 * 守护脚本未就绪时先等它上线（壳启动约 90 秒后自动创建窗口），再入队计时。
 */
export async function fetchPageViaAgent(
  url: string,
  timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
): Promise<AgentPageResult> {
  // 守护脚本不在线：等它上线（壳自愈窗口约 15-90 秒），最多等 20 秒
  const waitStart = Date.now();
  while (!agentAlive()) {
    if (Date.now() - waitStart >= 20_000) {
      throw new Error(
        'QOJ 助手窗口未就绪：桌面版启动约 90 秒后自动就绪（保持软件打开即可）；也可在设置页点「在应用内登录 QOJ」立即打开，稍后重试同步。',
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const id = nextJobId++;
  const result = new Promise<AgentPageResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error('QOJ 助手窗口抓取超时：请确认窗口保持打开且已登录 qoj.ac，稍后重试同步。'));
      }
    }, timeoutMs);
    // ⚠ 刻意不 unref：挂起任务的超时定时器必须撑住事件循环——
    // 否则测试等场景下循环被清空，pending Promise 会随进程一起被取消（CI 实测）
    pending.set(id, { resolve, reject, timer });
  });
  queue.push({ id, url });
  return result;
}

/** 守护脚本领取一个任务（pop 语义）；空队列返回 null。顺带刷新活跃时间。 */
export function popJob(): { id: number; url: string } | null {
  agentSeenAt = Date.now();
  return queue.shift() ?? null;
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
export function agentAlive(): boolean {
  return Date.now() - agentSeenAt < ALIVE_WINDOW_MS;
}

/** 测试辅助：清空全部状态（队列/等待方/活跃时间） */
export function resetAgentForTests(): void {
  for (const [, job] of pending) {
    clearTimeout(job.timer);
    job.reject(new Error('测试重置'));
  }
  pending.clear();
  queue.length = 0;
  agentSeenAt = 0;
  nextJobId = 1;
}

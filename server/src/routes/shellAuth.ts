import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { COOKIE_FIELDS, PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

/**
 * 桌面壳凭据桥：桌面壳（Tauri 内嵌 WebView）⇄ 核心（本服务）的中转站，纯内存、无落库。
 *
 * 背景：Cookie 类平台（QOJ/洛谷/LeetCode/计蒜客/代码源/AtCoder）的登录凭据靠用户 F12
 * 手工复制极易出错，且 QOJ 的 cf_clearance 约 30 分钟过期（站点 Challenge Passage 默认值，
 * 客户端无法延长）。桌面壳用内嵌 WebView 让用户像普通浏览器一样「输账号密码登录」，
 * 登录完成后把 Cookie 原样抓回推给本服务；QOJ 额外由壳周期静默续签。
 * 这条链路**不走 Tauri IPC**——远程页面（http://127.0.0.1:port）的 IPC 请求在 WebView2
 * 上被 ACL 判为不可匹配的 origin，remote capability 也放行不了（widget 壳
 * capabilities/remote-drag.json 的实测结论）。因此：
 *
 *   前端（设置页按钮，可带 platform / handle）
 *     → POST /request          交一个动作（login = 弹该平台登录窗；pull = QOJ 后台静默续签）
 *     ← { id }
 *   桌面壳（本桥的唯一消费方，3s 轮询）
 *     → GET  /pending          取走请求（pop 语义，取走即清除）
 *     → 开窗/读 Cookie → POST /api/settings/cookies 推送（带 handle = 只写该账号槽位）
 *     → POST /status           回报执行结果（带同一 id）
 *   前端
 *     → GET  /status           按 id 轮询结果；顺带用最近心跳判定「桌面壳在线」
 *
 * 网页版（无桌面壳）没有消费方：/request 会一直 pending 无人取走，前端靠
 * /status 里的 shell=false 判定降级为手动粘贴流程，不会误报「正在处理」。
 * 请求不持久化：壳取走后崩溃则本次动作丢失，前端重按按钮即可（无需可靠性语义）。
 */

/** 壳回报的状态（Rust 侧以同构 JSON 发送，字段全集见 POST /status 校验） */
export interface ShellAuthStatus {
  kind: 'heartbeat' | 'login' | 'pull' | 'keepalive';
  /** 前端动作关联 id（login/pull 有；heartbeat/keepalive 无） */
  id?: number;
  ok: boolean;
  /** login 结果：各凭据字段是否抓到（含义随平台，仅供界面提示） */
  hasSessid?: boolean;
  hasClearance?: boolean;
  pushed?: boolean;
  message?: string;
  /** 壳发送时刻（Unix 秒）；在线判定用本服务的接收时刻，不受双方时钟偏差影响 */
  at: number;
}

/** 壳待执行的动作（login 的 platform/handle 由前端指定，决定开哪个窗、推送写到哪） */
export interface ShellAuthRequest {
  id: number;
  action: 'login' | 'pull';
  platform: PlatformId;
  /** 带该字段 = 只把抓到的 Cookie 写入这个账号的凭据槽位（多账号按账号分别抓取） */
  handle?: string;
}

/** 心跳多少毫秒没来就认定桌面壳离线（壳 60s 一跳，容忍 2 拍丢失） */
const HEARTBEAT_STALE_MS = 3 * 60_000;
/** message 只用于界面展示，截断防壳侧意外超长 */
const MESSAGE_MAX = 512;

/** 需要凭据的平台（与 shared COOKIE_FIELDS 同口径）；纯公开 API 平台没有登录窗意义 */
function isCookiePlatform(p: string): p is PlatformId {
  return (COOKIE_FIELDS[p as PlatformId] ?? []).length > 0;
}

export function shellAuthRoutes(db: Db): Router {
  const r = Router();
  let pending: ShellAuthRequest | null = null;
  let last: ShellAuthStatus | null = null;
  let lastHeartbeatAt = 0;

  // POST /api/settings/shell-auth/request  body: { action, platform?, handle? }
  // 前端发起动作。同一时刻只保留最后一个请求（后按覆盖先按——窗口/续签都幂等，覆盖无碍）。
  // pull（静默续签）目前只有 QOJ 需要（cf_clearance 30 分钟过期）；其余平台会话长效，
  // 登录一次即可，没有续签语义。
  r.post('/request', (req, res) => {
    const { action, platform, handle } = req.body ?? {};
    if (action !== 'login' && action !== 'pull') {
      return res.status(400).json({ error: "action 需为 'login' 或 'pull'" });
    }
    const pid = typeof platform === 'string' && platform !== '' ? platform : 'qoj';
    if (!isCookiePlatform(pid)) {
      return res.status(400).json({ error: `平台 ${pid} 无需 Cookie 凭据，不支持登录抓取` });
    }
    if (action === 'pull' && pid !== 'qoj') {
      return res.status(400).json({ error: "pull（静默续签）仅支持 QOJ（唯一短时效凭据平台）" });
    }
    const rawHandle = typeof handle === 'string' ? handle.trim() : '';
    if (handle !== undefined && rawHandle === '') {
      return res.status(400).json({ error: 'handle 显式传入时不能为空' });
    }
    if (rawHandle) {
      // 与 POST /api/settings/cookies 的账号槽位守卫同口径：只对已绑定账号开放，
      // 避免拼错的 handle 让壳抓完 Cookie 却无处可写
      const bound = db
        .prepare('SELECT 1 AS ok FROM platform_accounts WHERE user_id = ? AND platform = ? AND handle = ?')
        .get(DEFAULT_USER_ID, pid, rawHandle);
      if (!bound) return res.status(404).json({ error: `账号 ${rawHandle} 未绑定，无法为其抓取凭据` });
    }
    const id = Date.now();
    pending = { id, action, platform: pid, ...(rawHandle ? { handle: rawHandle } : {}) };
    res.json({ ok: true, id });
  });

  // GET /api/settings/shell-auth/pending
  // 壳轮询取走请求（pop 语义）。无请求时 request 为 null——壳按「没有新动作」处理。
  r.get('/pending', (_req, res) => {
    const request = pending;
    pending = null;
    res.json({ request });
  });

  // POST /api/settings/shell-auth/status  body: ShellAuthStatus
  // 壳回报：动作结果（带 id）或保活/心跳（无 id）。只留最近一条（界面只需要最新状态）。
  r.post('/status', (req, res) => {
    const b = req.body;
    if (typeof b !== 'object' || b === null) {
      return res.status(400).json({ error: 'body 需为 JSON 对象' });
    }
    const kind = (b as { kind?: unknown }).kind;
    if (kind !== 'heartbeat' && kind !== 'login' && kind !== 'pull' && kind !== 'keepalive') {
      return res.status(400).json({ error: "status.kind 需为 'heartbeat' | 'login' | 'pull' | 'keepalive'" });
    }
    const at = (b as { at?: unknown }).at;
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      return res.status(400).json({ error: 'status.at 需为数字（Unix 秒）' });
    }
    const o = b as Record<string, unknown>;
    const st: ShellAuthStatus = { kind, ok: Boolean(o.ok), at };
    if (typeof o.id === 'number') st.id = o.id;
    if (typeof o.hasSessid === 'boolean') st.hasSessid = o.hasSessid;
    if (typeof o.hasClearance === 'boolean') st.hasClearance = o.hasClearance;
    if (typeof o.pushed === 'boolean') st.pushed = o.pushed;
    if (typeof o.message === 'string') st.message = o.message.slice(0, MESSAGE_MAX);
    last = st;
    if (kind === 'heartbeat') lastHeartbeatAt = Date.now();
    res.json({ ok: true });
  });

  // GET /api/settings/shell-auth/status
  // 前端轮询：shell = 桌面壳是否在线（决定设置页展示「一键登录」还是手动粘贴引导）；
  // last = 最近一条状态（前端按 id 匹配动作结果，kind=keepalive 用作保活时间线展示）。
  r.get('/status', (_req, res) => {
    res.json({ shell: Date.now() - lastHeartbeatAt < HEARTBEAT_STALE_MS, last });
  });

  // 供测试与文档对照：当前支持登录抓取的平台清单
  r.get('/platforms', (_req, res) => {
    res.json({ platforms: PLATFORMS.filter((p) => isCookiePlatform(p.id)).map((p) => p.id) });
  });

  return r;
}

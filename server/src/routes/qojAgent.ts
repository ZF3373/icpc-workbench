import { Router } from 'express';
import { popJob, resolveJob, agentAlive, jobPlatform, type AgentPlatform } from '../adapters/qojAgent.ts';

/**
 * WebView 同源代理的任务交换端点（消费方 = 壳注入到各平台页面的守护脚本）。
 *
 * 页面脚本：GET /next?platform=X 领任务（同源 fetch 任务 URL）→ POST /result 回传响应体。
 * 安全模型：
 * - CORS 只放行各平台自己的源（https://qoj.ac / https://vjudge.net），其他页面读不到任务、写不进结果；
 * - https 页面 → http://127.0.0.1 属「本地回环豁免」（Chromium 视 127.0.0.1 为安全上下文），
 *   但会触发 Private Network Access 预检，需回 `Access-Control-Allow-Private-Network: true`；
 * - /result 只接受**有 pending 任务**的 id（qojAgent.resolveJob 校验，未知 id 返回 ok:false），
 *   且回传源须与该任务所属平台的源一致；任务只在用户触发同步/检测时存在，恶意页面无从伪造有效任务。
 */

/** 各平台守护脚本所在的源（CORS 白名单 + /result 源校验同口径） */
const PLATFORM_ORIGIN: Record<AgentPlatform, string> = {
  qoj: 'https://qoj.ac',
  vjudge: 'https://vjudge.net',
};
const ALLOWED_ORIGINS = new Set(Object.values(PLATFORM_ORIGIN));

function platformOfQuery(v: unknown): AgentPlatform | null {
  if (v === undefined || v === '' || v === 'qoj') return 'qoj';
  if (v === 'vjudge') return 'vjudge';
  return null;
}

export function qojAgentRoutes(): Router {
  const r = Router();

  r.use((req, res, next) => {
    // 反射白名单内的请求源（守护脚本所在平台）；无 Origin（如服务端自检）回退默认源
    const origin = req.headers.origin;
    const allowed = typeof origin === 'string' && ALLOWED_ORIGINS.has(origin) ? origin : PLATFORM_ORIGIN.qoj;
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // GET /api/qoj-agent/next?platform=X → { job: { id, url } | null }
  // 守护脚本领取本平台任务（pop 语义）。空轮询即心跳：顺带刷新守护脚本活跃时间。
  r.get('/next', (req, res) => {
    const platform = platformOfQuery(req.query.platform);
    if (!platform) return res.status(400).json({ error: 'platform 需为 qoj 或 vjudge' });
    res.json({ job: popJob(platform) });
  });

  // GET /api/qoj-agent/alive?platform=X → { alive: boolean }
  // 壳刷新助手窗口后轮询这个端点，守护脚本一上线（开始领任务/空轮询）就提前返回，
  // 把「导航重建」造成的代理不可用窗口从 30 秒压到几秒
  r.get('/alive', (req, res) => {
    const platform = platformOfQuery(req.query.platform);
    if (!platform) return res.status(400).json({ error: 'platform 需为 qoj 或 vjudge' });
    res.json({ alive: agentAlive(platform) });
  });

  // POST /api/qoj-agent/result  body: { id, status, body, finalUrl? }
  r.post('/result', (req, res) => {
    const b = req.body;
    if (typeof b !== 'object' || b === null) {
      return res.status(400).json({ error: 'body 需为 JSON 对象' });
    }
    const { id, status, body, finalUrl } = b as Record<string, unknown>;
    if (typeof id !== 'number' || typeof status !== 'number' || typeof body !== 'string') {
      return res.status(400).json({ error: 'id/status 需为数字、body 需为字符串' });
    }
    // 回传源须与任务所属平台一致（浏览器守护脚本必带 Origin；无 Origin 的服务端自检放行）
    const origin = req.headers.origin;
    const expected = jobPlatform(id);
    if (typeof origin === 'string' && expected && origin !== PLATFORM_ORIGIN[expected]) {
      return res.json({ ok: false });
    }
    const ok = resolveJob(id, status, body, typeof finalUrl === 'string' ? finalUrl : undefined);
    res.json({ ok });
  });

  return r;
}
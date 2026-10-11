import { Router } from 'express';
import { popJob, resolveJob, agentAlive } from '../adapters/qojAgent.ts';

/**
 * QOJ WebView 同源代理的任务交换端点（消费方 = 壳注入到 qoj.ac 页面的守护脚本）。
 *
 * 页面脚本：GET /next 领任务（同源 fetch 任务 URL）→ POST /result 回传 HTML。
 * 安全模型：
 * - CORS 只放行 https://qoj.ac（守护脚本所在源），其他页面读不到任务、写不进结果；
 * - https 页面 → http://127.0.0.1 属「本地回环豁免」（Chromium 视 127.0.0.1 为安全上下文），
 *   但会触发 Private Network Access 预检，需回 `Access-Control-Allow-Private-Network: true`；
 * - /result 只接受**有 pending 任务**的 id（qojAgent.resolveJob 校验，未知 id 返回 ok:false），
 *   任务只在用户触发同步/检测时存在，恶意页面无从伪造有效任务。
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://qoj.ac',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
};

export function qojAgentRoutes(): Router {
  const r = Router();

  r.use((req, res, next) => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // GET /api/qoj-agent/next → { job: { id, url } | null }
  // 守护脚本领取任务（pop 语义）。空轮询即心跳：顺带刷新守护脚本活跃时间。
  r.get('/next', (_req, res) => {
    res.json({ job: popJob() });
  });

  // GET /api/qoj-agent/alive → { alive: boolean }
  // 壳刷新助手窗口后轮询这个端点，守护脚本一上线（开始领任务/空轮询）就提前返回，
  // 把「导航重建」造成的代理不可用窗口从 30 秒压到几秒
  r.get('/alive', (_req, res) => {
    res.json({ alive: agentAlive() });
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
    const ok = resolveJob(id, status, body, typeof finalUrl === 'string' ? finalUrl : undefined);
    res.json({ ok });
  });

  return r;
}

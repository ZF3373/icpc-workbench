import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * 基础安全响应头。本地单用户应用风险可控，但 widget 页面由 Express 直接服务，
 * 加上 nosniff / 同源框架等头成本极低，避免意外暴露面。
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** 回环主机名（IPv6 字面量保留方括号形式）：Host 头白名单的基准。 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 从 Host 头取出主机名：去掉端口，IPv6 保留 `[::1]` 形式。 */
export function hostnameOfHostHeader(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * Host 头校验（仅当服务绑定在回环地址时启用）。
 *
 * 本应用全站零鉴权，安全边界全靠「默认只绑 127.0.0.1」。但浏览器里的恶意页面可以用
 * DNS rebinding 绕过它：页面先由攻击者域名提供，随后该域名改解析到 127.0.0.1，于是
 * 脚本对 `http://攻击者域名:3001/...` 的请求在浏览器看来是「同源」，实际却打到了本机
 * 服务。服务端不看 Host 就区分不出这种请求，任何读接口都能被读走、写接口都能被调用。
 *
 * 绑定回环时因此只放行回环主机名；显式绑到非回环地址（Docker 的 HOST=0.0.0.0、反向
 * 代理）时**不校验**——那是操作者主动选择的暴露，Host 会是任意域名，校验只会误伤。
 * `ICPC_ALLOWED_HOSTS`（逗号分隔）可追加放行主机名，供自定义域名/代理场景使用。
 *
 * 放行按**主机名**而非「主机名:端口」：客户端(5173) 经 vite 代理转发时会保留原始
 * `Host: localhost:5173`，按端口匹配会把开发环境一起挡掉。
 */
export function hostGuard(boundHost: string, extraHosts = process.env.ICPC_ALLOWED_HOSTS): RequestHandler {
  const enforcing = LOOPBACK_HOSTNAMES.has(hostnameOfHostHeader(boundHost));
  const allowed = new Set(LOOPBACK_HOSTNAMES);
  for (const item of (extraHosts ?? '').split(',')) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed) allowed.add(hostnameOfHostHeader(trimmed));
  }
  return (req, res, next) => {
    if (!enforcing) return next();
    const host = req.headers.host;
    // 无 Host 头（HTTP/1.0 客户端、部分健康检查）不构成 rebinding 条件，放行以免误伤
    if (!host) return next();
    if (allowed.has(hostnameOfHostHeader(host))) return next();
    res.status(403).json({
      error: 'Host 头不受信任：本应用只接受回环地址访问（防止 DNS rebinding）。',
    });
  };
}

/**
 * 全局错误处理中间件：捕获 asyncHandler 转交的 rejection 与同步抛出，
 * 统一返回 JSON 错误响应，避免客户端挂起或收到 HTML 错误页。
 * 必须放在所有路由之后注册（Express 按注册顺序匹配，错误中间件需 4 个参数）。
 */
export function errorHandler(
  err: Error & { status?: number; type?: string },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  console.error('[server] unhandled error:', err);
  // 响应已开始发送（如流式 SSE 中途出错）：无法再改写状态码与响应体，转交 Express 默认
  // 错误处理器收尾（它会按已发头的情况销毁 socket / 结束响应），避免连接挂起直到超时。
  if (res.headersSent) return next(err);
  // body-parser 的「请求体超限」是客户端问题，不是服务器故障：报 500 用户只会看到
  // 「服务器内部错误」，既不知道是附件太大也不会去删附件。
  if (err.type === 'entity.too.large' || err.status === 413) {
    res
      .status(413)
      .json({ error: '请求体过大：文本附件单个上限 1 MiB、每条消息最多 8 个，请减少附件或压缩内容' });
    return;
  }
  // body-parser 的 JSON 解析失败同样是客户端问题（请求体不是合法 JSON），应回 400 而非 500。
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: '请求体不是合法 JSON' });
    return;
  }
  // 通用 500：只回模糊文案，具体错误原文留在服务端日志，避免向客户端泄露内部细节。
  res.status(500).json({ error: '服务器内部错误，请稍后重试或查看服务端日志' });
}

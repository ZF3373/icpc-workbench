import type { Request, Response, NextFunction } from 'express';

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

/**
 * 全局错误处理中间件：捕获 asyncHandler 转交的 rejection 与同步抛出，
 * 统一返回 JSON 错误响应，避免客户端挂起或收到 HTML 错误页。
 * 必须放在所有路由之后注册（Express 按注册顺序匹配，错误中间件需 4 个参数）。
 */
export function errorHandler(err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return; // 已开始发送响应，交给 Express 默认处理
  // body-parser 的「请求体超限」不是服务器故障：报 500 用户只会看到「服务器内部错误」，
  // 既不知道是附件太大也不会去删附件
  if (err.type === 'entity.too.large' || err.status === 413) {
    res
      .status(413)
      .json({ error: '请求体过大：文本附件单个上限 1 MiB、每条消息最多 8 个，请减少附件或压缩内容' });
    return;
  }
  res.status(500).json({ error: `服务器内部错误：${err.message}` });
}

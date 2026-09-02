import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * 包装 async 路由处理器，把未捕获的 Promise rejection 转交给 Express 错误中间件。
 * Express 4 不会自动捕获 async handler 的 rejection——不包装会导致客户端挂起。
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

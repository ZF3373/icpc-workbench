import type { Response } from 'express';

/**
 * 路由级错误响应的统一出口（优化计划 #4）：对用户可操作的错误保留原文，
 * 内部细节只进日志、客户端拿固定文案。
 *
 * 背景：题库拉取 / 模型列表 / 改名删号等路由曾把 `(e as Error).message` 原样回给
 * 客户端。同一条 catch 链路里可能混着三类错误：
 * - 上游 HTTP 状态（`HTTP 403` / `HTTP 429`）：可操作（风控 / 限流 / 未登录），保留；
 * - 路由自拼的输入校验文案（「第 N 行：平台不支持」）：可操作，保留；
 * - 引擎异常（TypeError `fetch failed`）、SQLite 错误码、文件系统 errno（消息常带
 *   绝对路径）：内部细节，与 errorHandler 500 的口径一致——原文只进服务端日志。
 *
 * 引擎异常靠 `err.name` 判定：undici 的网络失败是 `TypeError`，但 message 只有
 * `fetch failed`，不带类名前缀，必须看 name。
 */
const INTERNAL_ERROR_NAMES = new Set([
  'TypeError',
  'URIError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
]);
/** 消息里的内部细节特征：SQLite 错误码 / 文件系统 errno（出现时常伴随绝对路径）。 */
const INTERNAL_MESSAGE_RE = /\bSQLITE_\w+|\b(?:ENOENT|EACCES|EPERM|ENOSPC|EMFILE|EROFS|EISDIR)\b/;

export function sendRouteError(res: Response, status: number, e: unknown, fallback: string): void {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[route] → ${status}:`, err);
  const internal =
    INTERNAL_ERROR_NAMES.has(err.name) || INTERNAL_MESSAGE_RE.test(err.message);
  res.status(status).json({
    error: internal ? fallback : `${fallback}：${err.message}`,
  });
}

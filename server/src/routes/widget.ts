import express from 'express';
import { Router } from 'express';
import path from 'node:path';
import { SERVER_ROOT } from '../server-root.ts';

// 锚定 server 根而非模块目录：bundle 到 server/dist/sea.cjs 后，
// `__dirname/../public` 会指向 server/public（不存在），/widget 整页 404
let publicDir = path.join(SERVER_ROOT, 'src', 'public');

/**
 * 轻量 Web 挂件：GET /widget 由 Express 直接服务零依赖单页，
 * 页面轮询 /api/checkins/* 展示当天任务并可打卡。
 * 单文件分发（SEA exe）场景下 public 目录不存在于磁盘，
 * 由启动入口调用 setWidgetPublicDir 注入打包时内嵌的资源目录。
 */
export function setWidgetPublicDir(dir: string): void {
  publicDir = dir;
}

export function widgetRoutes(): Router {
  const r = Router();
  r.use('/', express.static(publicDir, { index: 'widget.html' }));
  return r;
}

import express from 'express';
import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * 轻量 Web 挂件：GET /widget 由 Express 直接服务零依赖单页，
 * 页面轮询 /api/checkins/* 展示当天任务并可打卡。
 * （透明置顶桌面挂件的 Electron/Tauri 版仍为后续扩展，后端 API 完全复用。）
 */
export function widgetRoutes(): Router {
  const r = Router();
  r.use('/', express.static(publicDir, { index: 'widget.html' }));
  return r;
}

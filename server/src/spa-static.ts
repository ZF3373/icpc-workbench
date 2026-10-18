import path from 'node:path';
import express, { Router } from 'express';

/**
 * 前端 dist 静态服务：桌面 SEA 版与 Docker 版共用（两者都走 sea.ts）。
 *
 * 缓存策略按「文件名是否带内容哈希」分流：
 * - Vite 产物落在 assets/ 下且文件名含 8 位内容哈希（如 index-D2S9hhDk.js），
 *   内容变则文件名变，可放心 `immutable` 缓存一年——远程访问时首屏之外不再回源；
 * - index.html 及其他未哈希文件（favicon.svg、public/ 拷贝物）必须 no-cache：
 *   否则升级后浏览器仍用旧入口，旧 HTML 指向的旧 chunk 已被新 dist 替换，
 *   用户会看到白屏/加载失败，且只能手动清缓存才能恢复。
 *
 * express.static 的 setHeaders 先于 send 写头执行，send 只在 Cache-Control 缺失时才
 * 自己补 `public, max-age=0`，所以这里设置的头不会被覆盖。
 */

/** `-A1b2C3d4.js` / `-HOLc17fK.woff2`：Vite 的 8 位 base64 内容哈希后缀 */
const HASHED_FILENAME = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

function isImmutableAsset(distDir: string, filePath: string): boolean {
  const rel = path.relative(distDir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const [top] = rel.split(path.sep);
  return top === 'assets' && HASHED_FILENAME.test(path.basename(filePath));
}

export function spaStaticRoutes(distDir: string): Router {
  const r = Router();
  r.use(
    express.static(distDir, {
      setHeaders: (res, filePath) => {
        res.setHeader(
          'Cache-Control',
          isImmutableAsset(distDir, filePath)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    }),
  );
  // BrowserRouter 刷新兜底：非 /api、/widget 的路径一律回 index.html
  // （sendFile 默认会补 max-age=0，这里显式 no-cache 统一口径）
  r.get(/^(?!\/api|\/widget).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'), {
      headers: { 'Cache-Control': 'no-cache' },
    });
  });
  return r;
}

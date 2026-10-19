import path from 'node:path';

/**
 * 服务端资源根目录（含 src/、vendor/、data/ 的那一层，即 server/）。
 *
 * 为什么单独抽一份：本模块既会以 tsx 直接运行（位于 `server/src/**`），也会被 esbuild
 * bundle 进 `server/dist/sea.cjs`（Docker 镜像入口）。两种形态下本模块都落在 `server/`
 * 的**一级子目录**里，所以「模块目录 · ..」在两种形态下都指向 server 根。
 *
 * 反过来，若各模块用自己的 `__dirname` 向上拼路径，bundle 后层级会整体平移
 * （`server/src/db` → `server/dist`），资源路径随之错位——Docker 版会读不到
 * schema.sql / 提示词 / widget.html / vendor/typst，直到运行时才报 ENOENT。
 */
export const SERVER_ROOT = path.resolve(import.meta.dirname, '..');

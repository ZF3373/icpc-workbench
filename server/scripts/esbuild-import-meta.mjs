/**
 * esbuild 插件：把源码里的 import.meta 改写成 CJS 可用的等价物。
 *
 * SEA 打包（build-exe.mjs）与 Docker 服务端 bundle（build-server-bundle.mjs）都以
 * CJS 输出单文件；而源码普遍在模块顶层用 fileURLToPath(import.meta.url) 定位资源，
 * CJS 下 import.meta 为空对象会当场抛错 —— 打包期重写为 __filename / __dirname。
 *
 * 两个打包入口共用同一份实现：任何一处漏改都会在打包后变成启动即崩，
 * 所以这里只保留一份，避免两份正则悄悄漂移。
 */
import fs from 'node:fs';

export const rewriteImportMetaPlugin = {
  name: 'rewrite-import-meta',
  setup(b) {
    b.onLoad({ filter: /\.(ts|tsx)$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      const rewritten = src
        .replace(/fileURLToPath\(import\.meta\.url\)/g, '__filename')
        .replace(/import\.meta\.dirname/g, '__dirname')
        .replace(/import\.meta\.url/g, 'pathToFileURL(__filename).href');
      return rewritten === src ? null : { contents: rewritten, loader: 'ts' };
    });
  },
};

/**
 * Docker 镜像用的服务端 bundle：node scripts/build-server-bundle.mjs
 *
 * 与 build-exe.mjs（桌面 SEA）共用同一套 esbuild 参数（CJS / node22 / minify /
 * node:* 外置 / import.meta 重写），区别是**不收集 SEA 资产**：
 * 非 SEA 分支的 sea.ts 会按磁盘相对路径读取 schema / 提示词 / 内置题库 / widget，
 * Dockerfile 只需把这几个文件按原相对路径拷进运行镜像。
 *
 * 产物 server/dist/sea.cjs 是唯一入口：node dist/sea.cjs，运行时不再需要 tsx，
 * 也不再携带任何 .ts 源码（esbuild 已把 server/src 与 shared/src 全部打进单文件）。
 *
 * 依赖处理：与 SEA 一致，只把 node:* 内置模块外置，其余 npm 依赖全部内联。
 * 因此运行镜像不需要 node_modules —— 镜像体积与依赖版本都由构建阶段锁定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { rewriteImportMetaPlugin } from './esbuild-import-meta.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(serverRoot, 'dist', 'sea.cjs');

fs.mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(serverRoot, 'src', 'sea.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile,
  external: ['node:*'],
  minify: true,
  // 不注入 APP_VERSION / BUILD_COMMIT（build-exe.mjs 才有）：容器内版本号保持
  // 「跟随 process.env，缺省 dev」，与 README 的部署说明一致（更新 = 换镜像）。
  plugins: [rewriteImportMetaPlugin],
});

const sizeMb = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
console.log(`完成: ${outfile} (${sizeMb} MB)`);

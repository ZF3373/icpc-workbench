import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Docker 运行镜像的资源清单守卫。
 *
 * 镜像里的服务端是 esbuild 打的单文件 bundle（server/dist/sea.cjs），运行阶段不装
 * node_modules、不带 TS 源码；schema.sql / 提示词 / 内置题库 / 知识点表 / widget.html
 * 全靠 Dockerfile 逐个 COPY 进 `/app/server/src/**` 的原相对路径。
 *
 * 漏拷任何一项都不会让构建失败或启动报错（读文件的代码都带 try/catch 或懒加载），
 * 只会在某个功能上静默失效——例如漏了 rules.json，知识点分类永远为空；漏了
 * widget.html，/widget 整页 404。本测试把「源码里按磁盘路径读取的资源」与
 * 「Dockerfile 的 COPY 清单」对齐，新增资源时两边都必须动。
 *
 * 同样的清单也决定了 typst 目录布局：vendor/typst 必须保持
 * `vendor/typst/<platform>-<arch>/v<version>/typst`，由 prepare-typst.mjs 生成。
 */

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

/** Dockerfile 里从构建上下文 COPY 的服务端资源路径（忽略 --from 阶段拷贝） */
function copiedPaths(): Set<string> {
  const paths = new Set<string>();
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(.+?)\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const sources = m[1]!.split(/\s+/).filter((s) => !s.startsWith('--from='));
    for (const src of sources) paths.add(src);
  }
  return paths;
}

const copies = copiedPaths();

/** Dockerfile 的 CMD 必须直接跑 bundle（不允许退回 tsx 即时转译） */
test('Dockerfile 运行入口是 node dist/sea.cjs，且镜像内不再安装 tsx', () => {
  assert.match(dockerfile, /CMD \["node",\s*"dist\/sea\.cjs"\]/, 'CMD 必须直接执行 bundle');
  assert.doesNotMatch(dockerfile, /npm install -g tsx/, '镜像内不应再全局安装 tsx');
  assert.doesNotMatch(dockerfile, /CMD \["tsx"/, 'CMD 不应再用 tsx 转译源码');
});

test('bundle 构建脚本存在且与 SEA 打包共用 import.meta 重写插件', () => {
  const bundleScript = path.join(serverRoot, 'scripts', 'build-server-bundle.mjs');
  assert.ok(fs.existsSync(bundleScript), '缺少 server/scripts/build-server-bundle.mjs');
  const src = fs.readFileSync(bundleScript, 'utf8');
  assert.match(src, /esbuild-import-meta\.mjs/, 'bundle 必须复用共享的 import.meta 重写插件');
  const exe = fs.readFileSync(path.join(serverRoot, 'scripts', 'build-exe.mjs'), 'utf8');
  assert.match(exe, /esbuild-import-meta\.mjs/, '桌面 SEA 打包也必须复用同一份插件');
});

/**
 * sea.ts 非 SEA 分支（Docker 入口）按 SERVER_ROOT 读取的磁盘资源。
 * 这些文件必须被 Dockerfile COPY 到镜像里的同一相对路径。
 */
const DOCKER_RESOURCES = [
  'server/src/db/schema.sql',
  'server/src/ai/plan-prompt.md',
  'server/src/ai/assistant-prompt.md',
  'server/src/ai/title-prompt.md',
  'server/src/data/bank-builtin.json',
  'server/src/knowledge/taxonomy.json',
  'server/src/knowledge/rules.json',
  'server/src/public/widget.html',
];

test('Dockerfile 拷入了 sea.ts 运行期读取的全部磁盘资源', () => {
  for (const res of DOCKER_RESOURCES) {
    assert.ok(fs.existsSync(path.join(repoRoot, res)), `源码里不存在 ${res}（清单过期）`);
    assert.ok(copies.has(res), `Dockerfile 未 COPY ${res} —— 镜像内该功能会静默失效`);
  }
});

test('Dockerfile 保留了 client/dist 与 typst vendor 目录布局', () => {
  assert.match(
    dockerfile,
    /COPY --from=web-build \/app\/client\/dist \.\/client\/dist/,
    'Dockerfile 未把 web-build 的 client/dist 拷进运行镜像',
  );
  assert.match(dockerfile, /COPY --from=typst \/app\/server\/vendor \.\/server\/vendor/);
});

/** 资源清单与源码双向对齐：新增的磁盘资源文件也必须进 Dockerfile */
test('server/src 下的静态资源类文件都在 Dockerfile 清单里', () => {
  const resourceDirs = ['server/src/db', 'server/src/ai', 'server/src/data', 'server/src/knowledge', 'server/src/public'];
  const skipExt = new Set(['.ts', '.tsx', '.map']);
  for (const dir of resourceDirs) {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (skipExt.has(ext)) continue;
      const rel = `${dir}/${entry.name}`;
      assert.ok(
        copies.has(rel),
        `${rel} 没有被 Dockerfile COPY —— 新增运行时资源时请同步镜像清单与本测试`,
      );
    }
  }
});

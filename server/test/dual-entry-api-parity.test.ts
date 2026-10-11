import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 双入口 API 装配一致性守卫。
 *
 * 服务器装配代码存在两份平行入口：`src/index.ts`（tsx 开发运行）与 `src/sea.ts`
 * （SEA 打包，桌面版 icpc-core.exe 的真实入口）。两者各自 import 路由并 app.use
 * 挂载——历史缺陷：新增路由只改了 index.ts，dev 下一切正常，打包出的桌面版却
 * 404（2026-10 的 shell-auth 凭据桥即中招：设置页按钮依赖的桥接口在桌面版上
 * Cannot GET，且壳心跳每分钟报「状态回报失败」）。本测试解析两个入口的挂载清单，
 * 强制 `/api/*` 与 /widget 完全一致——新增路由只改一处时会在这里红。
 */

const here = dirname(fileURLToPath(import.meta.url));

/** 从入口源码提取 app.use('xxx') 的挂载路径（非 API 的 express.static 等无字面量参数，天然不参与） */
function mountsOf(file: string): string[] {
  const src = readFileSync(join(here, '..', 'src', file), 'utf-8');
  return [...src.matchAll(/app\.use\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
}

test('双入口一致：index.ts 与 sea.ts 的 app.use 挂载清单完全相同', () => {
  const dev = mountsOf('index.ts');
  const sea = mountsOf('sea.ts');
  assert.ok(dev.length > 0, 'index.ts 未解析到任何挂载（解析器与源码形态脱节？）');
  assert.deepEqual(sea, dev);
});

test('双入口一致：/api/health 在两个入口都存在（探活/发现依赖）', () => {
  for (const file of ['index.ts', 'sea.ts']) {
    const src = readFileSync(join(here, '..', 'src', file), 'utf-8');
    assert.match(src, /app\.get\(\s*'\/api\/health'/, `${file} 缺少 /api/health`);
  }
});

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

/**
 * 安全中间件装配一致性。
 *
 * 上面的 mountsOf 只解析带字符串字面量的挂载（`app.use('/api/xxx', ...)`），对
 * `app.use(hostGuard(host))` 这类**无字面量参数**的中间件完全不可见。2026-10 的
 * Host 头校验（防 DNS rebinding）正因此漏装到 sea.ts：tsx 开发入口有这道防线，
 * 而打包版 icpc-core.exe（sea.ts 是 build-exe.mjs 的唯一 entryPoints）与 Docker
 * 的非 SEA 分支没有——攻击者可用 DNS rebinding 以「同源」身份读走全部配置、
 * 调用全部写接口（含把已存 API Key 的 baseURL 改到攻击者主机），而上面那条守卫
 * 仍报「双入口一致」。
 *
 * 这里只锁定**安全相关**的装配契约，不与 `express.static`（sea.ts 要服务 SPA 而
 * index.ts 不服务，是有意差异）之类做全量比对——那种比对会在正当改动上误报。
 * 新增安全中间件时把标识符补进 SECURITY_MIDDLEWARES。
 */

/** 两个入口都必须装配的安全中间件，按必需的先后顺序。 */
const SECURITY_MIDDLEWARES = ['hostGuard', 'securityHeaders'];

/** 取出一次 `app.use(...)` 的完整参数文本（按括号配平扫描，避免嵌套括号截断）。 */
function argsOfAppUse(src: string, openParenAt: number): string {
  let depth = 0;
  for (let i = openParenAt; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenAt + 1, i).trim();
    }
  }
  throw new Error('app.use( 括号未闭合——解析器与源码形态脱节？');
}

/**
 * 提取中间件装配清单（按出现顺序）。
 *
 * 判据：`app.use` 的参数**不以** `'` / `"` / 正则 `/` 起头，即为中间件而非路由挂载；
 * 清单元素取「首个标识符」（`hostGuard(host)` → `hostGuard`，`express.json({...})`
 * → `express.json`），这样表达式内部换个变量名不会误报。
 */
function middlewaresOf(file: string): string[] {
  const src = readFileSync(join(here, '..', 'src', file), 'utf-8');
  const found: string[] = [];
  for (const m of src.matchAll(/app\.use\(/g)) {
    const arg = argsOfAppUse(src, m.index + 'app.use('.length - 1);
    if (arg.startsWith("'") || arg.startsWith('"') || arg.startsWith('/')) continue;
    const ident = arg.match(/^[\w$.]+/);
    if (ident) found.push(ident[0]);
  }
  return found;
}

test('双入口一致：安全中间件在两个入口都装配，且先后顺序一致', () => {
  for (const file of ['index.ts', 'sea.ts']) {
    const installed = middlewaresOf(file);
    const positions = SECURITY_MIDDLEWARES.map((name) => installed.indexOf(name));
    for (const [i, name] of SECURITY_MIDDLEWARES.entries()) {
      assert.ok(
        positions[i]! >= 0,
        `${file} 未装配 ${name}——打包版 icpc-core.exe / Docker 部署会静默失去这道防线`,
      );
    }
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(
        positions[i]! > positions[i - 1]!,
        `${file}: 安全中间件顺序错位——${SECURITY_MIDDLEWARES[i - 1]} 必须早于 ${SECURITY_MIDDLEWARES[i]}`,
      );
    }
  }
});

test('双入口一致：Host 头校验装在路由之前（否则请求已进路由，校验形同虚设）', () => {
  for (const file of ['index.ts', 'sea.ts']) {
    const src = readFileSync(join(here, '..', 'src', file), 'utf-8');
    const guardAt = src.indexOf('app.use(hostGuard(');
    const firstRouteAt = src.search(/app\.use\(\s*'\/api\//);
    assert.ok(guardAt >= 0, `${file} 未装配 hostGuard——全站零鉴权，缺少防 DNS rebinding 的唯一防线`);
    assert.ok(
      firstRouteAt >= 0 && guardAt < firstRouteAt,
      `${file}: hostGuard 必须早于第一个 /api 路由挂载（当前 guardAt=${guardAt}, firstRouteAt=${firstRouteAt}）`,
    );
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 路由注册一致性：index.ts（tsx 开发）与 sea.ts（SEA 桌面打包）必须注册同一组 /api 前缀。
 * 曾因 sea.ts 漏注册 /api/ai、/api/lists 导致桌面版 AI 助手/题单整理 404（开发模式正常，
 * 测试未覆盖双入口，问题直到用户实测才暴露）——本测试从源头堵住这类遗漏。
 */
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function apiPrefixes(file: string): string[] {
  const code = fs.readFileSync(path.join(srcDir, file), 'utf8');
  return [...code.matchAll(/app\.use\('\/api\/([\w.-]+)'/g)].map((m) => m[1]).sort();
}

test('sea.ts registers the same /api prefixes as index.ts', () => {
  assert.deepEqual(apiPrefixes('sea.ts'), apiPrefixes('index.ts'));
});

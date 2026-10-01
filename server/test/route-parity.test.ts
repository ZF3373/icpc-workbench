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

/**
 * 启动副作用一致性：index.ts（tsx 开发）与 sea.ts（SEA 打包版；Docker 镜像的非 SEA 分支同样
 * 走这个入口）必须调用同一组「启动即生效」的副作用。sea.ts 曾漏掉其中 4 项——
 * applyPendingRestore（恢复点重启生效）、maybeDailyBackup（每日自动备份）、
 * configureSyncScheduler（截断同步的后台续拉）、setRequestIntervalScale（限速倍率下发）——
 * 开发模式一切正常、打包版静默失效。同一类遗漏由本用例从源头堵住。
 * 新增「启动即生效」的副作用时，把函数名补进这份清单（两个入口都要有）。
 */
const STARTUP_CALLS = [
  'applyPendingRestore(',
  'seedBuiltinBank(',
  'initAdapters(',
  'configureSyncScheduler(',
  'setRequestIntervalScale(',
  'initKnowledgeStore(',
  'maybeDailyBackup(',
  'purgeAiAnnotations(',
  'loadAnnotationsIntoDb(',
];

test('sea.ts runs the same startup side effects as index.ts', () => {
  const indexSrc = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  const seaSrc = fs.readFileSync(path.join(srcDir, 'sea.ts'), 'utf8');
  for (const call of STARTUP_CALLS) {
    assert.ok(indexSrc.includes(call), `index.ts 未调用 ${call}（清单过期，请同步维护）`);
    assert.ok(seaSrc.includes(call), `sea.ts 未调用 ${call}——打包版/Docker 会静默失效`);
  }
});

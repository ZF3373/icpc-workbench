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
  'migratePlatformCookieToAccounts(',
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

/**
 * 顺序也要一致（子串包含不够）：`applyPendingRestore` 必须早于 `createDb`（恢复点要先覆盖
 * 数据库文件）、迁移/播种必须早于 `initAdapters`/listen。只查「有没有出现」时，把调用挪到
 * 错误位置（甚至注释掉整行——注释里仍含同样的子串）都能通过。这里按清单顺序断言出现位置
 * 单调递增，两个入口各自校验；注释里的调用用「行首去注释后匹配」剔除。
 */
function callOrder(src: string): Array<{ call: string; at: number }> {
  const order: Array<{ call: string; at: number }> = [];
  for (const call of STARTUP_CALLS) {
    // 逐行扫描并跳过注释行（`//` 或 `*` 起头），避免「注释里的调用」被当成真实调用
    let at = -1;
    let offset = 0;
    for (const line of src.split('\n')) {
      const trimmed = line.trimStart();
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
      if (!isComment && line.includes(call)) {
        at = offset + line.indexOf(call);
        break;
      }
      offset += line.length + 1;
    }
    order.push({ call, at });
  }
  return order;
}

test('sea.ts 与 index.ts 的启动副作用顺序一致且都不是注释', () => {
  for (const file of ['index.ts', 'sea.ts']) {
    const order = callOrder(fs.readFileSync(path.join(srcDir, file), 'utf8'));
    for (const { call, at } of order) {
      assert.ok(at >= 0, `${file}: ${call} 只在注释里出现（或已删除）——启动副作用实际未执行`);
    }
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(
        order[i]!.at > order[i - 1]!.at,
        `${file}: 启动顺序错位——${order[i - 1]!.call} 必须早于 ${order[i]!.call}`,
      );
    }
  }
});

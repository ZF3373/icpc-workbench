/**
 * ruleEngine.ts 的 SEA（单文件 exe）安全回归测试。
 *
 * 背景 —— 真实事故（nightly af38ae8 启动即崩，GitHub issue #15）：
 * SEA 把 rules.json **内嵌**在 exe 里，磁盘上没有该文件，靠 `sea.ts` 调 `setRulesJson()` 注入；
 * 而模块加载（import 求值）必然早于注入语句。当时 `pipeline.ts` 在**模块加载期**计算
 * `PIPELINE_VERSION`，触发 `rulesVersion()` → 回落读磁盘 → `ENOENT: ...\rules.json` → 起不来。
 *
 * 本测试锁住两条不变量：
 *  1. 注入的内容是权威 —— 磁盘上有什么都不影响结果；
 *  2. `rulesVersion()` 不为「先读盘、后注入」留窗口（注入后不得再用磁盘结果）。
 *
 * ⚠️ 磁盘操作全部落在临时目录的 rules.json 副本上（`setRulesPathForTest` 重定向）：
 * 旧实现直接改写 src/knowledge/rules.json —— node --test 并发跑多个测试进程，
 * 「写成空规则/非法 JSON 再恢复」的窗口期会让并发读取该文件的知识点测试
 * （classifyTitle 等）随机拿到空规则或 SyntaxError，整条测试流水线假失败。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setRulesJson, setRulesPathForTest, rulesVersion, loadRules } from '../src/knowledge/ruleEngine.ts';

const REAL_RULES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'knowledge',
  'rules.json',
);

/** 真实文件的只读快照：作为临时副本的初始内容（对「磁盘」而言即正常的生产规则表） */
const realRulesJson = fs.readFileSync(REAL_RULES_PATH, 'utf8');

let tmpDir: string;
const diskRulesPath = (): string => path.join(tmpDir, 'rules.json');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sea-'));
  fs.writeFileSync(diskRulesPath(), realRulesJson, 'utf8');
  setRulesPathForTest(diskRulesPath());
  setRulesJson(null); // 从磁盘读取模式开始，与 SEA 故障现场（无注入）一致
});

afterEach(() => {
  setRulesJson(null); // 恢复磁盘读取模式，避免影响后续测试
  setRulesPathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('rulesVersion: 注入的内容优先于磁盘（SEA 下磁盘根本没有该文件）', () => {
  // 磁盘版本 1；注入版本 999 —— 结果必须是 999
  fs.writeFileSync(diskRulesPath(), JSON.stringify({ version: 1, rules: [] }), 'utf8');
  setRulesJson(JSON.stringify({ version: 999, rules: [] }));
  assert.equal(
    rulesVersion(),
    999,
    'rulesVersion() 读到了磁盘值，说明注入未生效 —— SEA 打包后此处会变成 ENOENT 崩溃',
  );
});

test('rulesVersion: 为「先读盘、后注入」不留窗口', () => {
  // 磁盘上放**非法 JSON**：正确实现根本不读它，读盘则抛错
  fs.writeFileSync(diskRulesPath(), '这不是 JSON', 'utf8');
  setRulesJson(JSON.stringify({ version: 7, rules: [] }));
  assert.equal(rulesVersion(), 7);
});

test('loadRules: 注入的规则优先于磁盘', () => {
  fs.writeFileSync(
    diskRulesPath(),
    JSON.stringify({ version: 1, rules: [{ id: 'x', pattern: '磁盘规则', code: 'basic.greedy', confidence: 0.9 }] }),
    'utf8',
  );
  setRulesJson(
    JSON.stringify({
      version: 2,
      rules: [{ id: 'y', pattern: '注入规则', code: 'misc.sorting', confidence: 1 }],
    }),
  );
  const rules = loadRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'y', 'loadRules() 读到了磁盘规则，注入未生效');
});

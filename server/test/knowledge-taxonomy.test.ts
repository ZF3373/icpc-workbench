import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy, isValidCode, allPoints } from '../src/knowledge/taxonomy.ts';
import { codeOfTag } from '../../shared/src/index.ts';

/** 本次新增的粗粒度概念：为高频无归属题源标签提供落点 */
const NEW_COARSE_CODES = [
  'math.general', 'misc.simulation', 'misc.construction', 'ds.general',
  'graph.general', 'tree.general', 'basic.brute-force', 'misc.array',
  'misc.counting', 'misc.stack', 'misc.interactive', 'basic.enumeration',
] as const;

test('粗粒度 code 全部存在于 taxonomy 且合法', () => {
  const tax = loadTaxonomy();
  // v4（2026-10）：对照 AlgoWiki tricks 补课，新增 16 个细粒度知识点（WQS 二分 / 决策单调性等）
  assert.equal(tax.version, 4);
  for (const code of NEW_COARSE_CODES) {
    assert.ok(isValidCode(code), `${code} 应在 taxonomy 中`);
  }
});

test('粗粒度 name 唯一（不得与既有细粒度概念重名）', () => {
  const names = allPoints().map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'taxonomy 内存在重名知识点');
});

test('高频题源标签能映射到粗粒度 code', () => {
  const cases: Array<[string, string]> = [
    ['数学', 'math.general'],
    ['模拟', 'misc.simulation'],
    ['构造', 'misc.construction'],
    ['数据结构', 'ds.general'],
    ['图论', 'graph.general'],
    ['树上算法', 'tree.general'],
    ['brute force', 'basic.brute-force'],
    ['array', 'misc.array'],
    ['counting', 'misc.counting'],
    ['stack', 'misc.stack'],
    ['交互', 'misc.interactive'],
    ['枚举', 'basic.enumeration'],
  ];
  for (const [tag, code] of cases) {
    assert.equal(codeOfTag(tag), code, `${tag} 应映射到 ${code}`);
  }
});

test('粗粒度同义组覆盖常见中英变体', () => {
  for (const tag of ['数学', '数论与组合数学', 'mathematics', 'math']) {
    assert.equal(codeOfTag(tag), 'math.general', `${tag} 应归入数学粗类`);
  }
  for (const tag of ['brute force', 'brute-force', '暴力', '暴力枚举']) {
    assert.equal(codeOfTag(tag), 'basic.brute-force', `${tag} 应归入暴力枚举`);
  }
});

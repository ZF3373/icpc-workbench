import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLuoguAdapter } from '../src/adapters/luogu.ts';
import { createNowcoderAdapter } from '../src/adapters/nowcoder.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

test('luogu: fetch throws ManualImportRequiredError, url works', async () => {
  const adapter = createLuoguAdapter();
  await assert.rejects(
    () => adapter.fetchUserSubmissions('uid'),
    ManualImportRequiredError,
  );
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://www.luogu.com.cn/problem/P1001',
  );
});

test('nowcoder: fetch throws ManualImportRequiredError, url works', async () => {
  const adapter = createNowcoderAdapter();
  await assert.rejects(
    () => adapter.fetchUserSubmissions('uid'),
    ManualImportRequiredError,
  );
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://ac.nowcoder.com/acm/problem/P1001',
  );
});

test('manual-required error carries code MANUAL_REQUIRED', () => {
  const e = new ManualImportRequiredError('luogu', '说明');
  assert.equal(e.code, 'MANUAL_REQUIRED');
  assert.match(e.message, /luogu/);
});

test('luogu/nowcoder registered in registry', () => {
  initAdapters();
  assert.ok(getAdapter('luogu'));
  assert.ok(getAdapter('nowcoder'));
});

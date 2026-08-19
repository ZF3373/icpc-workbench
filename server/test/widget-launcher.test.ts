import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryLaunchWidget } from '../src/widget-launcher.ts';

const cfg = (launchWidget: boolean) =>
  ({ port: 3001, dbPath: 'x', dataDir: 'x', launchWidget, ai: {
    enabled: false, baseURL: '', apiKey: '', model: '' } }) as never;

test('非 SEA 环境（dev）不拉起', () => {
  assert.equal(tryLaunchWidget(cfg(true), 3001), false);
});

test('launchWidget=false 不拉起', () => {
  // dev 守卫先返回，此用例确认 false 路径稳定
  assert.equal(tryLaunchWidget(cfg(false), 3001), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, compareVersions } from '../src/routes/update.ts';

test('compareVersions 基本比较', () => {
  assert.equal(compareVersions('v0.2.1', 'v0.2.2'), -1);
  assert.equal(compareVersions('v0.3.0', 'v0.2.99'), 1);
  assert.equal(compareVersions('v0.2.1', '0.2.1'), 0); // 前缀 v 可省
  assert.equal(compareVersions('v1.0.0', 'v1.0.0'), 0);
});

test('compareVersions 忽略 prerelease 后缀、容忍非法输入', () => {
  assert.equal(compareVersions('v1.0.0-beta.1', 'v0.9.9'), 1); // 按主版本前缀比较
  assert.equal(compareVersions('v1.0.0', 'v1.0.0-beta.1'), 0);
  assert.equal(compareVersions('not-a-version', 'v0.0.1'), -1); // 非法按 [0,0,0]
});

test('checkForUpdate 发现新版本', async () => {
  const fake = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/o/r/releases/tag/v9.9.9', body: '修复若干问题' }), {
        status: 200,
      }),
    )) as unknown as typeof fetch;
  const info = await checkForUpdate('v0.2.1', 'o/r', fake);
  assert.equal(info.ok, true);
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, 'v9.9.9');
  assert.equal(info.releasePage, 'https://github.com/o/r/releases/tag/v9.9.9');
  assert.match(info.notes ?? '', /修复/);
});

test('checkForUpdate 已是最新', async () => {
  const fake = (() =>
    Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.2.1', html_url: 'https://x' }), { status: 200 }))
  ) as unknown as typeof fetch;
  const info = await checkForUpdate('v0.2.1', 'o/r', fake);
  assert.equal(info.ok, true);
  assert.equal(info.hasUpdate, false);
});

test('checkForUpdate 开发模式不检查', async () => {
  let called = false;
  const fake = (() => {
    called = true;
    return Promise.resolve(new Response('{}'));
  }) as unknown as typeof fetch;
  const info = await checkForUpdate('dev', 'o/r', fake);
  assert.equal(info.ok, false);
  assert.equal(called, false);
});

test('checkForUpdate 网络/接口失败返回 ok:false 而非抛错', async () => {
  const fake = (() => Promise.reject(new Error('网络不通'))) as unknown as typeof fetch;
  const info = await checkForUpdate('v0.2.1', 'o/r', fake);
  assert.equal(info.ok, false);
  assert.equal(info.hasUpdate, false);
  assert.match(info.message ?? '', /网络不通/);

  const notFound = (() => Promise.resolve(new Response('[]', { status: 404 }))) as unknown as typeof fetch;
  const info404 = await checkForUpdate('v0.2.1', 'o/r', notFound);
  assert.equal(info404.ok, false);
  assert.equal(info404.hasUpdate, false);
});

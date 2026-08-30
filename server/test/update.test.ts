import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  checkForUpdate,
  compareVersions,
  nightlyCommitSha,
  resolveUpdate,
} from '../src/routes/update.ts';
import { parseChecksums, verifyChecksums } from '../src/updater.ts';

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

// ---------- 双通道：nightly 提交构建 ----------

const stableRelease = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  body: '正式版说明',
  prerelease: false,
  assets: [
    { name: 'icpc-workbench.exe', browser_download_url: `https://x/${tag}/icpc-workbench.exe` },
    { name: 'icpc-core.exe', browser_download_url: `https://x/${tag}/icpc-core.exe` },
    { name: 'checksums.sha256', browser_download_url: `https://x/${tag}/checksums.sha256` },
  ],
});

const nightlyRelease = (sha: string) => ({
  tag_name: 'nightly',
  name: `nightly · ${sha.slice(0, 7)}`,
  html_url: 'https://github.com/o/r/releases/tag/nightly',
  body: '自动构建',
  prerelease: true,
  target_commitish: sha,
  assets: [
    { name: 'icpc-workbench.exe', browser_download_url: `https://x/nightly/icpc-workbench.exe` },
    { name: 'icpc-core.exe', browser_download_url: `https://x/nightly/icpc-core.exe` },
    { name: 'checksums.sha256', browser_download_url: `https://x/nightly/checksums.sha256` },
  ],
});

test('nightlyCommitSha 取 target_commitish，回退标题/说明中的短 SHA', () => {
  assert.equal(nightlyCommitSha(nightlyRelease('a1b2c3d4e5')), 'a1b2c3d4e5');
  assert.equal(nightlyCommitSha({ name: 'nightly · deadbee', body: '' }), 'deadbee');
  assert.equal(nightlyCommitSha(null), null);
  assert.equal(nightlyCommitSha({ name: 'nightly', body: '没有哈希' }), null);
});

test('resolveUpdate：稳定版更新优先于提交通道', () => {
  const info = resolveUpdate('v0.4.0', 'aaa1111', stableRelease('v0.4.1'), nightlyRelease('bbb2222'));
  assert.equal(info.hasUpdate, true);
  assert.equal(info.channel, 'stable');
  assert.equal(info.latest, 'v0.4.1');
  assert.equal(info.download?.core, 'https://x/v0.4.1/icpc-core.exe');
});

test('resolveUpdate：版本一致但 nightly 提交更新 → 提交通道', () => {
  const info = resolveUpdate('v0.4.1', 'aaa1111', stableRelease('v0.4.1'), nightlyRelease('bbb2222333'));
  assert.equal(info.hasUpdate, false);
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.channel, 'commit');
  assert.equal(info.commit?.shortSha, 'bbb2222');
  assert.equal(info.download?.shell, 'https://x/nightly/icpc-workbench.exe');
});

test('resolveUpdate：已是同一构建则不提示', () => {
  const same = resolveUpdate('v0.4.1', 'bbb2222', stableRelease('v0.4.1'), nightlyRelease('bbb2222ffff'));
  assert.equal(same.hasUpdate, false);
  assert.equal(same.hasCommitUpdate, false);
  assert.equal(same.channel, null);
  assert.equal(same.download, null);
});

test('resolveUpdate：无 commit 构建信息（dev 构建/无 nightly）不提示提交更新', () => {
  assert.equal(resolveUpdate('v0.4.1', 'dev', stableRelease('v0.4.1'), nightlyRelease('bbb2222')).hasCommitUpdate, false);
  assert.equal(resolveUpdate('v0.4.1', 'aaa1111', stableRelease('v0.4.1'), null).hasCommitUpdate, false);
});

test('resolveUpdate：产物不全时 download 为 null（前端回退下载页）', () => {
  const incomplete = {
    tag_name: 'nightly',
    prerelease: true,
    target_commitish: 'bbb2222',
    assets: [{ name: 'icpc-core.exe', browser_download_url: 'https://x/core' }],
  };
  const info = resolveUpdate('v0.4.1', 'aaa1111', null, incomplete);
  assert.equal(info.channel, 'commit');
  assert.equal(info.download, null);
});

test('checkForUpdate：注入 fetch 同时覆盖两个通道', async () => {
  const calls: string[] = [];
  const fake = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    const url = String(input);
    const body = url.endsWith('/releases/latest') ? stableRelease('v9.9.9') : nightlyRelease('ccc3333');
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  const info = await checkForUpdate('v0.4.1', 'o/r', fake, 'ddd4444');
  assert.equal(info.ok, true);
  assert.equal(info.hasUpdate, true);
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.buildCommit, 'ddd4444');
  assert.ok(calls.some((u) => u.endsWith('/releases/tags/nightly')));
});

// ---------- 校验文件解析 ----------

test('parseChecksums / verifyChecksums', () => {
  const hash1 = 'a'.repeat(64);
  const hash2 = 'b'.repeat(64);
  const text = `${hash1}  icpc-workbench.exe\n${hash2}  icpc-core.exe\n`;
  const map = parseChecksums(text);
  assert.equal(map.get('icpc-workbench.exe'), hash1);
  assert.equal(map.get('icpc-core.exe'), hash2);

  // 内容一致 → 通过；不匹配 → 抛错
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  fs.writeFileSync(path.join(dir, 'icpc-core.exe'), Buffer.alloc(64, 7));
  const actual = createHash('sha256').update(fs.readFileSync(path.join(dir, 'icpc-core.exe'))).digest('hex');
  assert.doesNotThrow(() => verifyChecksums(`\n${actual}  icpc-core.exe\n`, dir, ['icpc-core.exe']));
  assert.throws(() => verifyChecksums(`${'0'.repeat(64)}  icpc-core.exe\n`, dir, ['icpc-core.exe']), /SHA256/);
  assert.throws(() => verifyChecksums('空文件\n', dir, ['icpc-core.exe']), /缺少/);
  fs.rmSync(dir, { recursive: true, force: true });
});

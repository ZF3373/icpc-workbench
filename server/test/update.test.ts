import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDb, type Db } from '../src/db/index.ts';
import { createBackup } from '../src/backup.ts';
import {
  checkForUpdate,
  compareVersions,
  applyStagedUpdate,
  nightlyCommitSha,
  resolveUpdate,
} from '../src/routes/update.ts';
import { parseChecksums, verifyChecksums, buildRanges, candidateUrls, mirrorPrefixes, replaceStagedFiles, applyUpdate, setCoreExitSchedulerForTests, setUpdatePhaseForTests, updateState } from '../src/updater.ts';

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

test('checkForUpdate：dev 构建照常检查（展示双通道状态但不支持自更新）', async () => {
  const fake = ((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith('/releases/latest') ? stableRelease('v0.4.1') : nightlyRelease('bbb2222');
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  const info = await checkForUpdate('dev', 'o/r', fake);
  // dev 按 0.0.0 比较：稳定通道恒有「新版本」；预览通道有构建即可看
  assert.equal(info.ok, true);
  assert.equal(info.hasUpdate, true);
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.stableDownload?.shell, 'https://x/v0.4.1/icpc-workbench.exe');
  assert.equal(info.commitDownload?.shell, 'https://x/nightly/icpc-workbench.exe');
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
  // 双通道产物：稳定版与预览版各自可用，前端按用户选择取用
  assert.equal(info.stableDownload?.shell, 'https://x/v0.4.1/icpc-workbench.exe');
  assert.equal(info.commitDownload?.shell, 'https://x/nightly/icpc-workbench.exe');
});

test('resolveUpdate：版本一致但 nightly 提交更新 → 提交通道', () => {
  const info = resolveUpdate('v0.4.1', 'aaa1111', stableRelease('v0.4.1'), nightlyRelease('bbb2222333'));
  assert.equal(info.hasUpdate, false);
  assert.equal(info.hasCommitUpdate, true);
  assert.equal(info.channel, 'commit');
  assert.equal(info.commit?.shortSha, 'bbb2222');
  assert.equal(info.download?.shell, 'https://x/nightly/icpc-workbench.exe');
  // 无稳定版更新：正式版通道不提供下载（不提供降级入口），预览版通道可用
  assert.equal(info.stableDownload, null);
  assert.equal(info.commitDownload?.core, 'https://x/nightly/icpc-core.exe');
});

test('resolveUpdate：已是同一构建则不提示', () => {
  const same = resolveUpdate('v0.4.1', 'bbb2222', stableRelease('v0.4.1'), nightlyRelease('bbb2222ffff'));
  assert.equal(same.hasUpdate, false);
  assert.equal(same.hasCommitUpdate, false);
  assert.equal(same.channel, null);
  assert.equal(same.download, null);
});

test('resolveUpdate：dev 构建无基线 commit，有 nightly 即视为有预览构建；无 nightly 不提示', () => {
  assert.equal(resolveUpdate('v0.4.1', 'dev', stableRelease('v0.4.1'), nightlyRelease('bbb2222')).hasCommitUpdate, true);
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
  // 不全的是预览通道：commitDownload 置 null，stableDownload 不受影响（无稳定版更新时本就为 null）
  assert.equal(info.commitDownload, null);
  assert.equal(info.stableDownload, null);
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

// ---------- 下载加速：分片与候选源 ----------

test('buildRanges 均分区间、末段吃尾差', () => {
  assert.deepEqual(buildRanges(100, 4), [[0, 24], [25, 49], [50, 74], [75, 99]]);
  assert.deepEqual(buildRanges(10, 4), [[0, 2], [3, 5], [6, 8], [9, 9]]);
  assert.deepEqual(buildRanges(3, 4), [[0, 0], [1, 1], [2, 2]]); // 片大小至少 1 字节
  assert.deepEqual(buildRanges(0, 4), []); // 总长未知：退单流
});

test('candidateUrls 直连优先，镜像拼为 URL 前缀', () => {
  const url = 'https://github.com/o/r/releases/download/v1/a.exe';
  const urls = candidateUrls(url);
  assert.equal(urls[0], url);
  assert.ok(urls.length >= 2);
  assert.ok(urls.slice(1).every((u) => /^https:\/\/[^/]+\/https:\/\/github\.com\//.test(u)));
});

test('mirrorPrefixes 可用环境变量覆盖，容忍尾斜杠与空值', () => {
  assert.deepEqual(mirrorPrefixes('https://a.cn/,https://b.cn/mirror//'), ['https://a.cn', 'https://b.cn/mirror']);
  assert.ok(mirrorPrefixes('').length >= 1); // 空值回默认镜像
  assert.ok(mirrorPrefixes().length >= 1);
});

// ---------- 原地替换的原子性（B19 回归） ----------

test('replaceStagedFiles：暂存文件缺失时预检失败，安装目录完全不动', () => {
  /**
   * 原实现逐个替换，只在**当前**文件拷贝失败时回滚该文件；之前已替换成功的保持新版本，
   * 实测会留下「新 shell.exe + 旧 core.exe」的半更新安装（壳与核心版本不一致可能起不来）。
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const staging = path.join(dir, 'staging');
  const exeDir = path.join(dir, 'exe');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, 'shell.exe'), 'OLD-SHELL');
  fs.writeFileSync(path.join(exeDir, 'core.exe'), 'OLD-CORE');
  fs.writeFileSync(path.join(staging, 'shell.exe'), 'NEW-SHELL');
  // core.exe 未暂存 → 预检必须直接失败
  assert.throws(() => replaceStagedFiles(staging, exeDir, ['shell.exe', 'core.exe']), /缺少|core\.exe/);
  assert.equal(fs.readFileSync(path.join(exeDir, 'shell.exe'), 'utf8'), 'OLD-SHELL', '第一个文件不得被替换');
  assert.equal(fs.readFileSync(path.join(exeDir, 'core.exe'), 'utf8'), 'OLD-CORE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceStagedFiles：中途拷贝失败时把本次已替换的文件全部还原', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd2-'));
  const staging = path.join(dir, 'staging');
  const exeDir = path.join(dir, 'exe');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, 'shell.exe'), 'OLD-SHELL');
  fs.writeFileSync(path.join(staging, 'shell.exe'), 'NEW-SHELL');
  fs.writeFileSync(path.join(staging, 'core.exe'), 'NEW-CORE');
  // core.exe 是**非空目录**：rename 走不通、copyFileSync 抛 EPERM —— 真实的中途失败
  fs.mkdirSync(path.join(exeDir, 'core.exe'));
  fs.writeFileSync(path.join(exeDir, 'core.exe', 'blocker'), 'x');
  fs.mkdirSync(path.join(exeDir, 'core.exe.old'));
  fs.writeFileSync(path.join(exeDir, 'core.exe.old', 'blocker'), 'y');

  assert.throws(() => replaceStagedFiles(staging, exeDir, ['shell.exe', 'core.exe']));
  assert.equal(
    fs.readFileSync(path.join(exeDir, 'shell.exe'), 'utf8'),
    'OLD-SHELL',
    '已替换的第一个文件必须被回滚，否则是半更新安装',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceStagedFiles：全部成功时两个文件都是新版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd3-'));
  const staging = path.join(dir, 'staging');
  const exeDir = path.join(dir, 'exe');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, 'shell.exe'), 'OLD-SHELL');
  fs.writeFileSync(path.join(exeDir, 'core.exe'), 'OLD-CORE');
  fs.writeFileSync(path.join(staging, 'shell.exe'), 'NEW-SHELL');
  fs.writeFileSync(path.join(staging, 'core.exe'), 'NEW-CORE');

  assert.doesNotThrow(() => replaceStagedFiles(staging, exeDir, ['shell.exe', 'core.exe']));
  assert.equal(fs.readFileSync(path.join(exeDir, 'shell.exe'), 'utf8'), 'NEW-SHELL');
  assert.equal(fs.readFileSync(path.join(exeDir, 'core.exe'), 'utf8'), 'NEW-CORE');
  // 旧版本留有 .old 备份（便于人工回退）
  assert.equal(fs.readFileSync(path.join(exeDir, 'shell.exe.old'), 'utf8'), 'OLD-SHELL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyUpdate：替换成功后调度核心自退，消息与 .old 备份齐全', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-apply-'));
  const exeDir = path.join(dir, 'install');
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(exeDir);
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(exeDir, 'icpc-workbench.exe'), 'OLD-SHELL');
  fs.writeFileSync(path.join(exeDir, 'icpc-core.exe'), 'OLD-CORE');
  fs.writeFileSync(path.join(staging, 'icpc-workbench.exe'), 'NEW-SHELL');
  fs.writeFileSync(path.join(staging, 'icpc-core.exe'), 'NEW-CORE');

  const exitCalls: number[] = [];
  setCoreExitSchedulerForTests((ms) => exitCalls.push(ms));
  setUpdatePhaseForTests('staged');

  const applied = applyUpdate(staging, exeDir);
  assert.equal(applied.ok, true);
  // 生效方式改为「核心自动重启、外壳下次手动重启更新」，不再是让用户手动关开
  assert.match(applied.message ?? '', /自动重启/);
  assert.match(applied.message ?? '', /外壳/);
  assert.deepEqual(exitCalls, [3000]);
  assert.equal(fs.readFileSync(path.join(exeDir, 'icpc-core.exe'), 'utf8'), 'NEW-CORE');
  assert.equal(fs.readFileSync(path.join(exeDir, 'icpc-core.exe.old'), 'utf8'), 'OLD-CORE');
  assert.equal(updateState().phase, 'idle');

  // 二次调用：phase 已回 idle，不再调度自退
  const again = applyUpdate(staging);
  assert.equal(again.ok, false);
  assert.deepEqual(exitCalls, [3000]);
  setUpdatePhaseForTests('idle');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- /apply：先校验 staged，再建升级前备份（P2-2 回归） ----------

/**
 * 造一个「生产布局」的数据目录：data/main.db（备份目录派生为 data/backups）。
 * 与 index.ts / sea.ts 注入的钩子一致：preUpgradeBackup = () => createBackup(db, 'pre-upgrade')。
 */
function openBackupHarness(): { dataDir: string; db: Db; backups: () => string[]; backup: () => void } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-apply-order-'));
  const db = createDb(path.join(dataDir, 'main.db'));
  const backupDir = path.join(dataDir, 'backups');
  const backups = (): string[] =>
    fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')) : [];
  return {
    dataDir,
    db,
    backups,
    backup: () => {
      createBackup(db, 'pre-upgrade');
    },
  };
}

test('applyStagedUpdate：无待更新时不创建升级前备份（备份目录文件数不变）', () => {
  /**
   * 原实现在校验 staged 之前就调用 preUpgradeBackup：无待更新时反复点「应用」
   * 会不断产生 pre-upgrade 备份（同 reason 只留 3 份），把真正的升级前恢复点挤出窗口。
   */
  const h = openBackupHarness();
  const staging = path.join(h.dataDir, 'update-staging');
  let applied = 0;
  setUpdatePhaseForTests('idle');
  try {
    for (let i = 0; i < 5; i += 1) {
      const r = applyStagedUpdate(staging, h.backup, () => {
        applied += 1;
        return { ok: true };
      });
      assert.equal(r.ok, false);
      assert.match(r.message ?? '', /没有已下载待应用的更新/);
    }
    assert.equal(h.backups().length, 0, '无 staged 时不得创建升级前备份（会把真实恢复点挤出窗口）');
    assert.equal(applied, 0, '校验失败时不得调用 apply');
  } finally {
    setUpdatePhaseForTests('idle');
    h.db.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('applyStagedUpdate：phase=staged 但暂存文件缺失时同样不建备份', () => {
  // 状态机与实际文件脱节（下载被中途删除 / 手工清理了 staging）：仍属「无更新可应用」
  const h = openBackupHarness();
  const staging = path.join(h.dataDir, 'update-staging');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'icpc-workbench.exe'), 'NEW-SHELL'); // core 缺失
  setUpdatePhaseForTests('staged');
  try {
    const r = applyStagedUpdate(staging, h.backup, () => {
      throw new Error('校验失败时不应调用 apply');
    });
    assert.equal(r.ok, false);
    assert.match(r.message ?? '', /icpc-core\.exe/);
    assert.equal(h.backups().length, 0);

    // 补全文件后即可正常应用，且此时才创建备份
    fs.writeFileSync(path.join(staging, 'icpc-core.exe'), 'NEW-CORE');
    const ok = applyStagedUpdate(staging, h.backup, (dirArg) => ({
      ok: true,
      message: `applied:${path.basename(dirArg)}`,
    }));
    assert.equal(ok.ok, true);
    assert.equal(ok.message, 'applied:update-staging');
    assert.equal(h.backups().length, 1, '有 staged 时应创建一次升级前备份');
    assert.match(h.backups()[0]!, /-pre-upgrade\.db$/);
  } finally {
    setUpdatePhaseForTests('idle');
    h.db.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

test('applyStagedUpdate：有 staged 时按顺序「先备份、再应用」，备份失败不阻塞更新', () => {
  const h = openBackupHarness();
  const staging = path.join(h.dataDir, 'update-staging');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'icpc-workbench.exe'), 'NEW-SHELL');
  fs.writeFileSync(path.join(staging, 'icpc-core.exe'), 'NEW-CORE');
  setUpdatePhaseForTests('staged');
  try {
    const order: string[] = [];
    const ok = applyStagedUpdate(
      staging,
      () => {
        order.push('backup');
        h.backup();
      },
      () => {
        order.push('apply');
        return { ok: true, message: '更新完成' };
      },
    );
    assert.equal(ok.ok, true);
    assert.deepEqual(order, ['backup', 'apply'], '升级前备份必须先于文件替换');
    assert.equal(h.backups().length, 1);

    // 备份失败（磁盘满等）：只记录，不阻塞更新
    setUpdatePhaseForTests('staged');
    const r = applyStagedUpdate(
      staging,
      () => {
        throw new Error('磁盘已满');
      },
      () => ({ ok: true, message: '更新完成' }),
    );
    assert.equal(r.ok, true, '升级前备份失败只记录，不阻塞更新');
    assert.equal(r.message, '更新完成');
  } finally {
    setUpdatePhaseForTests('idle');
    h.db.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  }
});

/**
 * 账号级凭据（多账号）测试：存储读写 + 生效口径（各账号**只用自己**的 Cookie，无平台级回退）
 * + 启动期迁移（旧平台级 Cookie 播种到无槽位账号）。
 * Cookie 合并逻辑复用 shared/credentials 的 mergeCookieFields / splitCookieFields。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { cookieOnlyFieldsOf, mergeCookieFields } from '../../shared/src/index.ts';
import {
  effectiveCredentials,
  migratePlatformCookieToAccounts,
  readAccountCreds,
  removeAccountCreds,
  writeAccountCreds,
} from '../src/adapters/accountCreds.ts';

function upsert(db: ReturnType<typeof createDb>, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function bindAccount(db: ReturnType<typeof createDb>, platform: string, handle: string): void {
  db.prepare(
    'INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (?, ?, ?, 1)',
  ).run(DEFAULT_USER_ID, platform, handle);
}

test('无任何凭据时生效凭据为空对象', () => {
  const db = createDb(':memory:');
  assert.deepEqual(effectiveCredentials(db, 'luogu', '1892580'), {});
});

test('账号无槽位时不再回退平台级 Cookie（各账号只用自己的）', () => {
  const db = createDb(':memory:');
  upsert(db, 'cookie.luogu', '_uid=AAA; __client_id=BBB');
  // 平台级 Cookie 存在，但账号没有自己的槽位 → 同步时不借用（影子值仅供非账号功能读取）
  assert.deepEqual(effectiveCredentials(db, 'luogu', '1892580'), {});
  // 账号有自己的槽位 → 只用槽位里的
  writeAccountCreds(db, 'luogu', { '1892580': { cookie: '_uid=OWN; __client_id=OWN2' } });
  assert.deepEqual(effectiveCredentials(db, 'luogu', '1892580'), {
    cookie: '_uid=OWN; __client_id=OWN2',
  });
});

test('QOJ 双账号各自独立：谁的槽位就是谁的，不继承平台级', () => {
  const db = createDb(':memory:');
  upsert(db, 'cookie.qoj', 'cf_clearance=CLR; UOJSESSID=PLATFORM');
  upsert(db, 'ua.qoj', 'Mozilla/5.0 UA');
  writeAccountCreds(db, 'qoj', {
    big: { cookie: 'UOJSESSID=BIG-SESSION' },
    small: { cookie: 'UOJSESSID=SMALL-SESSION' },
  });
  const big = effectiveCredentials(db, 'qoj', 'big');
  assert.equal(big.ua, 'Mozilla/5.0 UA', 'UA 仍为平台级（浏览器属性，与账号无关）');
  assert.equal(big.cookie, 'UOJSESSID=BIG-SESSION', '只用账号自己的 Cookie，不拼平台级字段');
  const small = effectiveCredentials(db, 'qoj', 'small');
  assert.equal(small.cookie, 'UOJSESSID=SMALL-SESSION');
  // 没有槽位的账号：没有任何 Cookie 可用（影子值不外借）
  assert.deepEqual(effectiveCredentials(db, 'qoj', 'legacy-handle'), { ua: 'Mozilla/5.0 UA' });
});

test('LeetCode 账号槽位缺 csrftoken 时同样不回退平台级', () => {
  const db = createDb(':memory:');
  upsert(db, 'cookie.leetcode', 'LEETCODE_SESSION=PLAT-SESS; csrftoken=PLAT-CSRF');
  writeAccountCreds(db, 'leetcode', { a: { cookie: 'LEETCODE_SESSION=OWN-SESS' } });
  const eff = effectiveCredentials(db, 'leetcode', 'a');
  assert.equal(eff.cookie, 'LEETCODE_SESSION=OWN-SESS');
  assert.ok(!eff.cookie!.includes('PLAT-CSRF'));
});

test('removeAccountCreds 幂等删除；槽位清空后设置键一并移除', () => {
  const db = createDb(':memory:');
  writeAccountCreds(db, 'jisuanke', { a: { cookie: 's=S1; JSKUSS=K1' } });
  removeAccountCreds(db, 'jisuanke', 'not-exist');
  assert.deepEqual(readAccountCreds(db, 'jisuanke'), { a: { cookie: 's=S1; JSKUSS=K1' } });
  removeAccountCreds(db, 'jisuanke', 'a');
  assert.deepEqual(readAccountCreds(db, 'jisuanke'), {});
  const row = db.prepare("SELECT value FROM settings WHERE key = 'accountCreds.jisuanke'").get();
  assert.equal(row, undefined);
});

test('损坏的 JSON / 非对象值安全回退为空表', () => {
  const db = createDb(':memory:');
  upsert(db, 'accountCreds.luogu', '{not json');
  assert.deepEqual(readAccountCreds(db, 'luogu'), {});
  upsert(db, 'accountCreds.luogu', '[1,2]');
  assert.deepEqual(readAccountCreds(db, 'luogu'), {});
  // 空串 cookie 的槽位视为不存在
  upsert(db, 'accountCreds.luogu', JSON.stringify({ a: { cookie: '   ' }, b: { cookie: '_uid=X' } }));
  assert.deepEqual(readAccountCreds(db, 'luogu'), { b: { cookie: '_uid=X' } });
});

test('启动迁移：平台级 Cookie 播种给无槽位账号，已有槽位的不覆盖；幂等', () => {
  const db = createDb(':memory:');
  bindAccount(db, 'luogu', '1892580');
  bindAccount(db, 'luogu', 'alt');
  writeAccountCreds(db, 'luogu', { alt: { cookie: '_uid=ALT-OWN' } }); // alt 已有自己的
  upsert(db, 'cookie.luogu', '_uid=LEGACY; __client_id=LEGACY2');

  assert.equal(migratePlatformCookieToAccounts(db), true);

  const slots = readAccountCreds(db, 'luogu');
  assert.equal(slots['1892580']?.cookie, '_uid=LEGACY; __client_id=LEGACY2', '无槽位账号获得播种');
  assert.equal(slots['alt']?.cookie, '_uid=ALT-OWN', '已有槽位不被覆盖');

  // 幂等：再跑一次不再有变更
  assert.equal(migratePlatformCookieToAccounts(db), false);
});

test('启动迁移：平台级无 Cookie 或平台无绑定账号时不动作', () => {
  const db = createDb(':memory:');
  assert.equal(migratePlatformCookieToAccounts(db), false);
  bindAccount(db, 'daimayuan', '5441'); // 无平台级 Cookie
  assert.equal(migratePlatformCookieToAccounts(db), false);
  assert.deepEqual(readAccountCreds(db, 'daimayuan'), {});
});

test('启动迁移：显式清空的账号重启后不再被影子值复活（台账式一次性迁移）', () => {
  const db = createDb(':memory:');
  bindAccount(db, 'luogu', 'a');
  bindAccount(db, 'luogu', 'b');
  upsert(db, 'cookie.luogu', '_uid=LEGACY');
  assert.equal(migratePlatformCookieToAccounts(db), true, '升级首启播种两个账号');
  assert.equal(readAccountCreds(db, 'luogu')['a']?.cookie, '_uid=LEGACY');

  // 复刻路由层「清空账号 Cookie」：删槽位、影子值保留（settings.ts 同口径）
  const slots = readAccountCreds(db, 'luogu');
  delete slots['a'];
  writeAccountCreds(db, 'luogu', slots);

  // 重启再迁移：不得把影子值重新播种给已清空的账号
  assert.equal(migratePlatformCookieToAccounts(db), false);
  assert.equal(readAccountCreds(db, 'luogu')['a'], undefined, '清空就是清空，不被复活');
  assert.equal(readAccountCreds(db, 'luogu')['b']?.cookie, '_uid=LEGACY', '未清空的账号不受影响');
});

test('启动迁移：迁移完成后新绑定的账号不被播种影子值', () => {
  const db = createDb(':memory:');
  bindAccount(db, 'luogu', 'old');
  upsert(db, 'cookie.luogu', '_uid=LEGACY');
  assert.equal(migratePlatformCookieToAccounts(db), true);

  bindAccount(db, 'luogu', 'new'); // 迁移之后才绑定的账号
  assert.equal(migratePlatformCookieToAccounts(db), false);
  assert.equal(readAccountCreds(db, 'luogu')['new'], undefined, '新账号要自己配 Cookie，不吃影子值');
  const eff = effectiveCredentials(db, 'luogu', 'new');
  assert.equal(eff.cookie, undefined, '生效口径同样拿不到影子值');
});

test('启动迁移：升级时还没绑定账号的平台也落台账，之后绑定不吃影子值', () => {
  const db = createDb(':memory:');
  upsert(db, 'cookie.luogu', '_uid=LEGACY');
  assert.equal(migratePlatformCookieToAccounts(db), false, '无账号可迁，无实际迁移');

  bindAccount(db, 'luogu', 'later');
  assert.equal(migratePlatformCookieToAccounts(db), false);
  assert.equal(readAccountCreds(db, 'luogu')['later'], undefined, '后绑账号不继承平台级旧值');
});

test('启动迁移：首启无影子值也落台账 —— 之后由「保存凭据」写入的影子值不再播种给他人（回归）', () => {
  // 真实时序：全新安装（无账号、无平台级 Cookie）首启 → 配好账号 A 的 Cookie（路由层顺手把
  // cookie.luogu 镜像成 A 的值）→ 再绑定还没配 Cookie 的账号 B → 重启。
  // 旧实现「没有影子值就不落台账」，重启时迁移被重新武装，B 被播种 A 的登录态
  //（正是本次修复要消灭的静默借用他人登录态）。
  const db = createDb(':memory:');
  assert.equal(migratePlatformCookieToAccounts(db), false, '首启无账号无影子值：无实际迁移');
  assert.equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'accountCreds.migrated.luogu'").get() as { value: string } | undefined)?.value,
    '1',
    '台账必须落（否则日后会被重新武装）',
  );

  // 用户配好账号 A 的凭据：槽位 + 影子值镜像刷新（routes/settings.ts 同口径）
  bindAccount(db, 'luogu', 'A');
  writeAccountCreds(db, 'luogu', { A: { cookie: '_uid=A-OWN' } });
  upsert(db, 'cookie.luogu', '_uid=A-OWN');
  // 之后才绑定、还没配 Cookie 的账号 B
  bindAccount(db, 'luogu', 'B');

  // 重启（再跑迁移）：B 不得继承 A 的登录态
  assert.equal(migratePlatformCookieToAccounts(db), false, '台账已落 → 不再播种');
  assert.equal(readAccountCreds(db, 'luogu')['B'], undefined, 'B 保持未配置');
  assert.equal(effectiveCredentials(db, 'luogu', 'B').cookie, undefined, '生效口径同样拿不到影子值');
  assert.equal(readAccountCreds(db, 'luogu')['A']?.cookie, '_uid=A-OWN', 'A 自己的槽位不受影响');
});

test('启动迁移：台账与播种同事务 —— 播种失败时台账一并回滚，下次启动重试', () => {
  const db = createDb(':memory:');
  bindAccount(db, 'luogu', 'a');
  upsert(db, 'cookie.luogu', '_uid=LEGACY');
  // 让 writeAccountCreds 的 upsert 失败（模拟磁盘满/锁失败）：临时把 settings 表改名
  db.exec('ALTER TABLE settings RENAME TO settings_hidden');
  assert.throws(() => migratePlatformCookieToAccounts(db), /settings/);
  db.exec('ALTER TABLE settings_hidden RENAME TO settings');
  // 台账未留下 → 下次启动重新迁移，不会出现「记了已迁移但实际没播种」
  assert.equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'accountCreds.migrated.luogu'").get() as { value: string } | undefined)?.value,
    undefined,
    '失败后台账必须回滚',
  );
  assert.equal(migratePlatformCookieToAccounts(db), true, '下次启动重试成功');
  assert.equal(readAccountCreds(db, 'luogu')['a']?.cookie, '_uid=LEGACY');
});

test('账号级保存路径（路由层语义）：以账号已存头为底合并，全空删槽', () => {
  // 直接复刻路由层对槽位的合并调用，避免起 HTTP：mergeCookieFields(stored, defs, patches)
  const db = createDb(':memory:');
  // 第一次：只填 UOJSESSID
  const slots1 = readAccountCreds(db, 'qoj');
  const merged1 = mergeCookieFields(slots1['h']?.cookie ?? '', cookieOnlyFieldsOf('qoj'), { uojsessid: 'SESS1' });
  slots1['h'] = { cookie: merged1 };
  writeAccountCreds(db, 'qoj', slots1);
  assert.ok(readAccountCreds(db, 'qoj')['h'].cookie!.includes('UOJSESSID=SESS1'));
  // 第二次：补填 cf_clearance，UOJSESSID 保留
  const slots2 = readAccountCreds(db, 'qoj');
  const merged2 = mergeCookieFields(slots2['h']?.cookie ?? '', cookieOnlyFieldsOf('qoj'), { clearance: 'CLR2' });
  slots2['h'] = { cookie: merged2 };
  writeAccountCreds(db, 'qoj', slots2);
  const saved = readAccountCreds(db, 'qoj')['h'].cookie!;
  assert.ok(saved.includes('UOJSESSID=SESS1'));
  assert.ok(saved.includes('cf_clearance=CLR2'));
  // 第三次：显式清空全部字段 → 槽位删除（该账号回到未配置状态）
  const slots3 = readAccountCreds(db, 'qoj');
  const merged3 = mergeCookieFields(slots3['h']?.cookie ?? '', cookieOnlyFieldsOf('qoj'), {
    uojsessid: '',
    clearance: '',
  });
  if (merged3 === '') delete slots3['h'];
  writeAccountCreds(db, 'qoj', slots3);
  assert.deepEqual(readAccountCreds(db, 'qoj'), {});
});

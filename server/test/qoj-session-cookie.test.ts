/**
 * QOJ 会话 Cookie 改名（`UOJSESSID` → `__Host-UOJSESSID`）的回归护栏。
 *
 * 背景（2026-10-02 实测）：qoj.ac 只读 `__Host-UOJSESSID`（响应 Set-Cookie 只下发这个名字）。
 * 用同一串值挂旧名请求 → 站点判未登录（302 跳 /login）→ 前端显示「凭据无效 / 已过期」，
 * **用户反复重新配置也无效**，因为值本身有效、只是名字不对。
 * 这里钉住三件事：发送前改名（原地，其余项逐字节不变）、提取兼容新旧两名、UA 引号净化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanUserAgent,
  cookieFieldValue,
  cookieOnlyFieldsOf,
  mergeCookieFields,
  splitCookieFields,
  withHardenedSessionCookie,
  COOKIE_FIELDS,
} from '../../shared/src/index.ts';

test('withHardenedSessionCookie: 旧名原地改成 __Host-UOJSESSID，其余项与顺序逐字节不变', () => {
  assert.equal(
    withHardenedSessionCookie('qoj', 'cf_clearance=cf; CF_VERIFIED_DEVICE_x=1; UOJSESSID=v1; uoj_locale=zh-cn'),
    'cf_clearance=cf; CF_VERIFIED_DEVICE_x=1; __Host-UOJSESSID=v1; uoj_locale=zh-cn',
    '只改会话项名字，不得重排或丢弃站点附加项',
  );
  assert.equal(
    withHardenedSessionCookie('qoj', 'UOJSESSID=v1; cf_clearance=cf'),
    '__Host-UOJSESSID=v1; cf_clearance=cf',
  );
});

test('withHardenedSessionCookie: 幂等、并存去重、无会话项与其他平台原样返回', () => {
  const hardened = '__Host-UOJSESSID=v1; cf_clearance=cf';
  assert.equal(withHardenedSessionCookie('qoj', hardened), hardened, '已改名时不得再次改动');
  assert.equal(
    withHardenedSessionCookie('qoj', '__Host-UOJSESSID=v2; UOJSESSID=v1; cf_clearance=cf'),
    '__Host-UOJSESSID=v2; cf_clearance=cf',
    '并存时旧名是历史残留，丢弃以免同名歧义',
  );
  assert.equal(withHardenedSessionCookie('qoj', 'cf_clearance=cf'), 'cf_clearance=cf');
  assert.equal(withHardenedSessionCookie('qoj', ''), '');
  assert.equal(withHardenedSessionCookie('luogu', 'UOJSESSID=v1'), 'UOJSESSID=v1', '其他平台不受影响');
});

test('提取与合并兼容 __Host- 硬化名（整段粘贴不得把会话丢掉）', () => {
  assert.equal(cookieFieldValue('__Host-UOJSESSID=abc; cf_clearance=x', 'UOJSESSID'), 'abc');
  assert.equal(cookieFieldValue('UOJSESSID=abc; cf_clearance=x', 'UOJSESSID'), 'abc');
  assert.equal(cookieFieldValue('cf_clearance=x', 'UOJSESSID'), '');
  // 修复前的缺陷：整段里只有硬化名时，uojsessid 取到空串 → 保存动作把会话清掉
  const pasted = '__Host-UOJSESSID=sess-abc; cf_clearance=cf-1';
  assert.equal(
    mergeCookieFields('', cookieOnlyFieldsOf('qoj'), { uojsessid: pasted, clearance: 'cf-1' }),
    'UOJSESSID=sess-abc; cf_clearance=cf-1',
  );
  assert.equal(
    mergeCookieFields(pasted, cookieOnlyFieldsOf('qoj'), { clearance: 'cf-2' }),
    'UOJSESSID=sess-abc; cf_clearance=cf-2',
    '只补 cf_clearance 时，已存的会话必须保留',
  );
  assert.deepEqual(splitCookieFields(pasted, COOKIE_FIELDS.qoj ?? []), {
    uojsessid: 'sess-abc',
    clearance: 'cf-1',
  });
});

test('cleanUserAgent: 剥掉 Console 粘贴带出的成对引号，单边引号不动', () => {
  assert.equal(cleanUserAgent("'Mozilla/5.0 (X) Edg/154.0.0.0'"), 'Mozilla/5.0 (X) Edg/154.0.0.0');
  assert.equal(cleanUserAgent('"Mozilla/5.0 (X)"'), 'Mozilla/5.0 (X)');
  assert.equal(cleanUserAgent('Mozilla/5.0 (X)'), 'Mozilla/5.0 (X)');
  assert.equal(cleanUserAgent("'Mozilla/5.0 (X)"), "'Mozilla/5.0 (X)");
  assert.equal(cleanUserAgent('  Mozilla/5.0 (X)  '), 'Mozilla/5.0 (X)');
});

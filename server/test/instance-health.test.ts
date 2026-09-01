import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeOurInstance } from '../src/instance-health.ts';

test('looksLikeOurInstance 只认 SEA 核心的 health 响应', () => {
  // 正常 SEA 核心：ok + platforms + sea:true
  assert.ok(
    looksLikeOurInstance({
      ok: true,
      time: '2026-09-01T00:00:00.000Z',
      platforms: ['codeforces', 'atcoder', 'luogu', 'nowcoder'],
      dbPath: 'D:\\icpc-workbench\\data\\icpc.db',
      version: 'v0.4.3',
      sea: true,
    }),
  );
  // dev server：ok + platforms 齐全但 sea:false —— 不可认作本程序实例，
  // 否则同机 dev server 会劫持重复启动检测与壳的端口发现
  assert.equal(
    looksLikeOurInstance({ ok: true, platforms: ['codeforces'], dbPath: '...', version: 'dev', sea: false }),
    false,
  );
  // 旧版响应缺 sea 字段：同样不认
  assert.equal(looksLikeOurInstance({ ok: true, platforms: ['codeforces'] }), false);
  // 异常载荷
  assert.equal(looksLikeOurInstance({ ok: false, platforms: [], sea: true }), false);
  assert.equal(looksLikeOurInstance(null), false);
  assert.equal(looksLikeOurInstance('ok'), false);
});

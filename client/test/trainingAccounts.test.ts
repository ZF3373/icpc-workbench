import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncTargets } from '../src/trainingAccounts'

test('同步全部保留同平台多账号，排除禁用账号，单账号选择不影响其它平台', () => {
  const accounts = [
    { platform: 'codeforces' as const, handle: 'main', enabled: 1 },
    { platform: 'codeforces' as const, handle: 'small', enabled: 1 },
    { platform: 'atcoder' as const, handle: 'main', enabled: 1 },
    { platform: 'codeforces' as const, handle: 'disabled', enabled: 0 },
  ]
  assert.deepEqual(syncTargets(accounts, '*', 'codeforces').map((a) => a.handle), ['main', 'small'])
  assert.deepEqual(syncTargets(accounts, 'codeforces:small').map((a) => a.handle), ['small'])
  assert.deepEqual(syncTargets(accounts, 'atcoder:main', 'codeforces'), [])
})

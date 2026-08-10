import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, listAdapters, register } from '../src/adapters/registry.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';

const fakeAdapter: PlatformAdapter = {
  platform: 'codeforces',
  async fetchUserSubmissions() {
    return [];
  },
  problemUrl({ problemKey }) {
    return `https://codeforces.com/problemset/problem/${String(problemKey)}`;
  },
};

test('registry: register / getAdapter / listAdapters', () => {
  register(fakeAdapter);
  assert.equal(getAdapter('codeforces'), fakeAdapter);
  assert.equal(listAdapters().length >= 1, true);
  assert.equal(getAdapter('luogu'), undefined);
});

test('adapter.problemUrl produces expected link', () => {
  assert.equal(
    fakeAdapter.problemUrl({ problemKey: '1919C' }),
    'https://codeforces.com/problemset/problem/1919C',
  );
});

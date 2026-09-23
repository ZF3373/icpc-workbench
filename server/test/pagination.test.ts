import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageBudget, pagedFetch } from '../src/adapters/pagination.ts';
import type { NormalizedSubmission, PlatformId } from '../../shared/src/index.ts';

function norm(id: string): NormalizedSubmission {
  return {
    problem: {
      platform: 'nowcoder' as PlatformId,
      problemKey: id,
      title: id,
      url: `https://x/${id}`,
      tags: [],
    },
    verdict: 'AC',
    submittedAt: '2024-01-01T00:00:00.000Z',
    externalId: id,
  };
}

test('pageBudget: defaults to perSyncMax when no maxSubmissions', () => {
  assert.equal(pageBudget(undefined, 20, 1000), 1000);
  assert.equal(pageBudget(0, 20, 1000), 1000);
});

test('pageBudget: caps at perSyncMax', () => {
  // maxSubmissions=100000 / pageSize=20 = 5000 页 ×2 = 10000，封顶 1000
  assert.equal(pageBudget(100000, 20, 1000), 1000);
});

test('pageBudget: scales with maxSubmissions (×2 headroom)', () => {
  // 1000 条 / 20 每页 = 50 页 ×2 = 100，未超 1000 上限
  assert.equal(pageBudget(1000, 20, 1000), 100);
});

test('pagedFetch: stops at maxSubmissions and sets truncated', async () => {
  // 每页 2 条，3 页后空；maxSubmissions=3 → 拉 2 页达上限
  const pages = [['a', 'b'], ['c', 'd'], ['e']];
  let callCount = 0;
  const opts: { maxSubmissions?: number; truncated?: boolean; backfillReachedPage?: number } = { maxSubmissions: 3 };
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async () => {
      const p = pages[callCount];
      callCount += 1;
      return p ?? [];
    },
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    maxSubmissions: 3,
    opts,
  });
  assert.equal(out.length, 3);
  assert.equal(opts.truncated, true);
  assert.equal(opts.backfillReachedPage, 2);
  assert.equal(callCount, 2); // 第 3 页未请求
});

test('pagedFetch: natural end (short page) does NOT truncate', async () => {
  const pages = [['a', 'b'], ['c']]; // 第 2 页不足 → 自然结束
  let callCount = 0;
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 10 };
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async () => pages[callCount++] ?? [],
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    maxSubmissions: 10,
    opts,
  });
  assert.equal(out.length, 3);
  assert.equal(opts.truncated, undefined);
});

test('pagedFetch: incremental early-stop on fully-known page (no backfill)', async () => {
  // 第 1 页全部已知 → 增量早停，不请求第 2 页
  const known = new Set(['a', 'b']);
  let callCount = 0;
  const pages = [['a', 'b'], ['c', 'd']];
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async () => pages[callCount++] ?? [],
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    knownExternalIds: known,
  });
  assert.equal(out.length, 0);
  assert.equal(callCount, 1); // 第 2 页未请求
});

test('pagedFetch: backfill skips fully-known page and continues to older', async () => {
  // 补全模式：第 1 页全部已知（跳过），第 2/3 页有新记录（第 3 页不足 → 自然结束）
  const known = new Set(['a', 'b']);
  let callCount = 0;
  const pages = [['a', 'b'], ['c', 'd'], ['e']];
  const opts: { backfill?: boolean; truncated?: boolean; backfillReachedPage?: number } = { backfill: true };
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async () => pages[callCount++] ?? [],
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    knownExternalIds: known,
    backfill: true,
    opts,
  });
  assert.deepEqual(out.map((r) => r.externalId), ['c', 'd', 'e']); // 跳过已知页后拉到的全部新记录
  assert.equal(callCount, 3);
  assert.equal(opts.truncated, undefined); // 自然结束，补全完成
});

test('pagedFetch: backfill from cursor starts at backfillFromPage', async () => {
  // 游标 = 3：从第 3 页续拉，不重扫第 1/2 页
  let callCount = 0;
  const requestedPages: number[] = [];
  const pages: Record<number, string[]> = { 3: ['x', 'y'], 4: ['z'] };
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async (page) => {
      callCount += 1;
      requestedPages.push(page);
      return pages[page] ?? [];
    },
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    backfill: true,
    backfillFromPage: 3,
  });
  assert.deepEqual(requestedPages, [3, 4]); // 从游标续拉
  assert.equal(out.length, 3);
  assert.equal(callCount, 2);
});

test('pagedFetch: backfill 连续 2 个整页已知 → 判定已补到尽头并早停（回归：曾空扫满预算）', async () => {
  // 实测场景：库中已有全部提交、没有更早历史可补。旧实现会一路 continue 到页数预算尽头
  // （牛客 60 次 / 洛谷 30 次请求，一条都不导入），现在应在第 2 页就收尾。
  const known = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  let callCount = 0;
  const pages = [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']];
  const opts: { backfill?: boolean; truncated?: boolean; backfillReachedPage?: number } = { backfill: true };
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async () => pages[callCount++] ?? ['x', 'y'],
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    knownExternalIds: known,
    backfill: true,
    opts,
  });
  assert.equal(out.length, 0);
  assert.equal(callCount, 2, '连续 2 个整页已知即停，不再继续翻页');
  assert.equal(opts.truncated, undefined, '补全到尽头不算截断（同步层据此清 sync_truncated）');
});

test('pagedFetch: backfill 中途出现新行则连续计数归零（不误判为已到尽头）', async () => {
  const known = new Set(['a', 'b']);
  let callCount = 0;
  // 已知页 → 新页 → 已知页 → 新页（不足一页，自然结束）
  const pages = [['a', 'b'], ['c', 'd'], ['a', 'b'], ['e']];
  const out = await pagedFetch<string>({
    pageSize: 2,
    perSyncMax: 100,
    fetchPage: async () => pages[callCount++] ?? [],
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    knownExternalIds: known,
    backfill: true,
  });
  assert.deepEqual(out.map((r) => r.externalId), ['c', 'd', 'e']);
  assert.equal(callCount, 4, '新行让计数归零，因此没有提前收尾');
});

test('pagedFetch: normalize returning null skips row (not known, not counted)', async () => {
  // 评测中行返回 null：不计入已知也不计入新增，但仍占页内位置
  const pages = [['a', 'skip', 'c']];
  let callCount = 0;
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 5 };
  const out = await pagedFetch<string>({
    pageSize: 3,
    perSyncMax: 100,
    fetchPage: async () => pages[callCount++] ?? [],
    externalIdOf: (s) => s,
    normalize: (s) => (s === 'skip' ? null : norm(s)),
    maxSubmissions: 5,
    opts,
  });
  assert.deepEqual(out.map((r) => r.externalId), ['a', 'c']);
  assert.equal(opts.truncated, undefined); // 不足一页 → 自然结束
});

test('pagedFetch: fetchPage 回传 rawCount 时按原始行数判短页（解析丢行不误判到底）', async () => {
  // 第 1 页实际有 3 行，但 1 行畸形被解析层丢弃：rows 2 条 + rawCount 3 → 不能判「最后一页」，
  // 否则更早历史被永久放弃（自然结束会清掉 sync_truncated）。第 2 页真短页 → 自然结束。
  let callCount = 0;
  const opts: { truncated?: boolean } = {};
  const out = await pagedFetch<string>({
    pageSize: 3,
    perSyncMax: 100,
    fetchPage: async () => {
      callCount += 1;
      if (callCount === 1) return { rows: ['a', 'b'], rawCount: 3 };
      if (callCount === 2) return { rows: ['c'], rawCount: 1 };
      return [];
    },
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    opts,
  });
  assert.deepEqual(out.map((r) => r.externalId), ['a', 'b', 'c']);
  assert.equal(opts.truncated, undefined); // 短页 = 自然结束，不截断
});

test('pagedFetch: rawCount 为 0（整页无数据行）仍判自然结束', async () => {
  let callCount = 0;
  const out = await pagedFetch<string>({
    pageSize: 3,
    perSyncMax: 100,
    fetchPage: async () => {
      callCount += 1;
      return { rows: [], rawCount: 2 }; // 只有表头等非数据行
    },
    externalIdOf: (s) => s,
    normalize: (s) => norm(s),
    opts: {},
  });
  assert.deepEqual(out, []);
  assert.equal(callCount, 1); // 空页即停
});

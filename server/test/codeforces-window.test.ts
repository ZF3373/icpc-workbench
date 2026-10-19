import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeforcesAdapter } from '../src/adapters/codeforces.ts';
import type { FetchOptions } from '../src/adapters/types.ts';
import { register } from '../src/adapters/registry.ts';
import { syncPlatform } from '../src/adapters/sync.ts';
import { createDb } from '../src/db/index.ts';

/**
 * 「仅同步最近 N 天」窗口在 CF 适配器上的语义（P2-B 回归）。
 *
 * 背景：`FetchOptions.windowSince` 由同步层只在 days 窗口模式注入，契约是「降序平台分页遇到
 * 早于该时间的提交时提前终止，且这种终止**不算截断**」（见 pagination.ts 的 pagedFetch 与
 * 洛谷/牛客/力扣/代码源的实现）。CF 适配器此前完全没读这个字段：窗口内一页页翻到底、
 * 要么白扫整个页数预算，要么把「预算耗尽」误判成截断，于是同步层给用户弹出
 * 「窗口内仍有未覆盖的记录」——而窗口内的提交其实早已全部拉到（谎报）。
 *
 * 实现要点（与任务书里「from 传 UNIX 秒」的方案不同，原因见下）：
 * CF 官方 API `user.status` 的 `from` 是「1-based index of the first submission to return」
 * （实测传 UNIX 秒直接被拒：`from: Field should be no more than 1000000000`），
 * 没有任何按时间过滤的参数。因此窗口只能靠**分页时逐行比较 creationTimeSeconds**实现：
 * 遇到早于窗口起点的行即停（该行及后续都更旧），并回写 `windowEnded` 让同步层知道
 * 「这是窗口到头，不是被上限截断」，不要报「仍有未覆盖的记录」。
 */

/** 构造一条 CF user.status 行：creationTimeSeconds 以「相对窗口起点的秒数」给，读起来直观 */
function sub(id: number, secondsFromWindowStart: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    contestId: 1919,
    problem: { contestId: 1919, index: 'C', name: 'Grouping Increases', rating: 2000, tags: ['greedy'] },
    verdict: 'OK',
    programmingLanguage: 'GNU C++17',
    creationTimeSeconds: WINDOW_START_SEC + secondsFromWindowStart,
    ...extra,
  };
}

const WINDOW_START_ISO = '2026-09-01T00:00:00.000Z';
const WINDOW_START_SEC = Date.parse(WINDOW_START_ISO) / 1000;

function cfRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test('windowSince: 分页遇到早于窗口起点的提交即停，窗口外旧提交不进结果', async () => {
  // 第 1 页：窗口内 3 条新的 + 1 条恰在窗口起点；第 2 页：全是窗口外旧提交（不应被请求）
  const pages: Array<Array<Record<string, unknown>>> = [
    [sub(5, 86_400), sub(4, 3_600), sub(3, 0), sub(2, -1)], // 最后一条早于窗口 1 秒
    [sub(1, -86_400)],
  ];
  const requestedFroms: number[] = [];
  const adapter = createCodeforcesAdapter(async (input) => {
    const from = Number(new URL(String(input)).searchParams.get('from'));
    requestedFroms.push(from);
    return cfRes({ status: 'OK', result: pages[requestedFroms.length - 1] ?? [] });
  });

  const opts: FetchOptions = { windowSince: WINDOW_START_ISO };
  const rows = await adapter.fetchUserSubmissions('u', opts);

  assert.deepEqual(
    rows.map((r) => r.externalId),
    ['5', '4', '3'],
    '窗口起点及更新的提交收下，更旧的（含窗口前 1 秒那条）排除',
  );
  assert.deepEqual(requestedFroms, [1], '窗口在第 1 页内结束 → 不该再请求第 2 页');
  assert.equal(opts.truncated, undefined, '窗口到头不是截断：不能报「窗口内仍有未覆盖」');
});

test('windowSince: 整页都在窗口外时同样立即收尾，不空扫页数预算', async () => {
  let calls = 0;
  const adapter = createCodeforcesAdapter(async () => {
    calls += 1;
    return cfRes({ status: 'OK', result: [sub(9, -10), sub(8, -20)] });
  });
  const opts: FetchOptions = { windowSince: WINDOW_START_ISO, maxSubmissions: 300 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 0);
  assert.equal(calls, 1, '首行就早于窗口 → 立刻停');
  assert.equal(opts.truncated, undefined);
});

test('windowSince: 窗口内触及单次上限仍如实截断（真截断与窗口到头必须区分开）', async () => {
  // 窗口内一页 1000 条塞满上限预算 → 这是真的没拉完，必须回传 truncated
  const full = Array.from({ length: 1000 }, (_, i) => sub(10_000 + i, 100_000 - i));
  const adapter = createCodeforcesAdapter(async () => cfRes({ status: 'OK', result: full }));
  const opts: FetchOptions = { windowSince: WINDOW_START_ISO, maxSubmissions: 500 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 500);
  assert.equal(opts.truncated, true, '窗口模式下触及上限 = 真的还有窗口内记录没拉到');
});

test('windowSince: 未注入时行为不变（常规增量/全量不做时间截断）', async () => {
  // 旧提交在常规同步里必须照常收下：牛客等平台存在「提交时间早、却晚出现在列表」的场景，
  // 只有 days 窗口模式才允许按时间砍。
  const adapter = createCodeforcesAdapter(async () =>
    cfRes({ status: 'OK', result: [sub(2, -86_400), sub(1, -172_800)] }),
  );
  const rows = await adapter.fetchUserSubmissions('u', {});
  assert.deepEqual(rows.map((r) => r.externalId), ['2', '1']);
});

test('windowSince: 分页仍从 from=1 起（CF 的 from 是条目索引，不是时间戳）', async () => {
  // 防回归：不能把 windowSince 当成 UNIX 秒塞进 from —— CF API 会以
  // `from: Field should be no more than 1000000000` 直接失败（实测）。
  const urls: string[] = [];
  const adapter = createCodeforcesAdapter(async (input) => {
    urls.push(String(input));
    return cfRes({ status: 'OK', result: [sub(1, 60)] });
  });
  await adapter.fetchUserSubmissions('u', { windowSince: WINDOW_START_ISO });
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get('from'), '1');
  assert.equal(url.searchParams.get('count'), '1000');
  assert.equal(url.searchParams.get('handle'), 'u');
  assert.ok(!url.searchParams.has('since'), 'CF user.status 没有 since 参数');
});

test('sync 层 days 窗口 + CF 适配器：窗口走到头不报「窗口内仍有未覆盖的记录」（谎报回归）', async () => {
  /**
   * 端到端：days 模式下同步层把 windowSince 注入适配器，窗口内记录拉完后适配器不置
   * truncated → 同步层给出「已同步最近 N 天」，而不是「已达单次上限 … 窗口内仍有未覆盖的记录」。
   * 修复前适配器忽略 windowSince：窗口外的旧提交照收，且预算耗尽后被判截断，用户被告知
   * 窗口内还有没拉到的记录（实际早已拉完）——既多打请求又说假话。
   */
  const db = createDb(':memory:');
  try {
    const requestedFroms: string[] = [];
    register(createCodeforcesAdapter(async (input) => {
      requestedFroms.push(new URL(String(input)).searchParams.get('from') ?? '');
      const recent = Math.floor(Date.now() / 1000) - 3_600; // 1 小时前：窗口内
      const old = Math.floor(Date.now() / 1000) - 90 * 86_400; // 90 天前：窗口外
      return new Response(JSON.stringify({
        status: 'OK',
        result: [
          { ...sub(2, 0), creationTimeSeconds: recent },
          { ...sub(1, 0), creationTimeSeconds: old },
        ],
      }), { status: 200 });
    }));

    const result = await syncPlatform(db, 'codeforces', 'tourist', { days: 7, triggeredBy: 'days' });
    assert.equal(result.imported, 1, '只导入窗口内的那条');
    assert.equal(result.truncated, undefined, '窗口走到头不是截断');
    assert.doesNotMatch(result.note ?? '', /未覆盖/, '不得谎报窗口内仍有未覆盖的记录');
    assert.match(result.note ?? '', /已同步最近 7 天/);
    assert.deepEqual(requestedFroms, ['1'], '窗口在首页内结束 → 不再请求第 2 页');
  } finally {
    db.close();
  }
});

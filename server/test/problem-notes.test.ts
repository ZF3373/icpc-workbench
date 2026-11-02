import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadsRoutes } from '../src/routes/uploads.ts';
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { checkinsRoutes } from '../src/routes/checkins.ts';
import { notesRoutes } from '../src/routes/notes.ts';
import { plansRoutes } from '../src/routes/plans.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import { mergeProblemRow } from '../src/import/problemMerge.ts';

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withServer(fn: (db: Db, call: Call) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/checkins', checkinsRoutes(db));
  app.use('/api/notes', notesRoutes(db));
  app.use('/api/plans', plansRoutes(db, () => ({}) as never));
  app.use('/api/problems', problemsRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call: Call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(db, call);
  } finally {
    srv.close();
    db.close();
  }
}

function seedTask(db: Db, title = 'T', problem = true): { taskId: number; problemId: number | null; planId: number } {
  const planId = Number(
    db.prepare("INSERT INTO plans (user_id, title, start_date, end_date) VALUES (1, ?, '2026-01-01', '2026-01-02')").run(title).lastInsertRowid,
  );
  const problemId = problem
    ? Number(db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', ?, ?, '[]')").run(`K${planId}`, title).lastInsertRowid)
    : null;
  const taskId = Number(
    db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind, problem_id) VALUES (?, '2026-01-01', ?, 'practice', ?)").run(planId, title, problemId).lastInsertRowid,
  );
  return { taskId, problemId, planId };
}

const count = (db: Db, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('打卡必须带笔记：没有笔记不写入打卡，有笔记时打卡与笔记一起落库', async () => {
  await withServer(async (db, call) => {
    const { taskId, problemId } = seedTask(db);
    for (const note of [undefined, {}, { content: '   ' }]) {
      assert.equal((await call('POST', '/api/checkins', { taskId, note })).status, 400);
    }
    assert.equal(count(db, 'checkins'), 0);
    assert.equal(count(db, 'problem_notes'), 0);

    const ok = await call('POST', '/api/checkins', { taskId, note: { content: '枚举右端点', labels: ['思路', ' 思路 ', '踩坑'] } });
    assert.equal(ok.status, 200);
    assert.equal(count(db, 'checkins'), 1);

    const { body } = await call('GET', `/api/notes?taskId=${taskId}`);
    assert.equal(body.items.length, 1);
    assert.deepEqual(body.items[0].labels, ['思路', '踩坑']);
    assert.equal(body.items[0].problemId, problemId);
    assert.equal(body.items[0].taskTitle, 'T');

    const again = await call('POST', '/api/checkins', { taskId, note: { content: '重复提交' } });
    assert.equal(again.status, 409);
    assert.equal(count(db, 'problem_notes'), 1, '重复打卡不产生多余笔记');
  });
});

test('打卡后不可取消', async () => {
  await withServer(async (db, call) => {
    const { taskId } = seedTask(db);
    await call('POST', '/api/checkins', { taskId, note: { content: 'x' } });
    assert.equal((await call('DELETE', `/api/checkins/${taskId}`)).status, 405);
    assert.equal(count(db, 'checkins'), 1);
  });
});

test('一题可写多条笔记；再写一条与题目页共用同一列表；可编辑', async () => {
  await withServer(async (db, call) => {
    const { taskId, problemId } = seedTask(db);
    await call('POST', '/api/checkins', { taskId, note: { content: '打卡笔记' } });
    const second = await call('POST', '/api/notes', { taskId, content: '再写一条', labels: ['复盘'] });
    assert.equal(second.status, 200);
    const third = await call('POST', '/api/notes', { problemId, content: '题目页写的' });
    assert.equal(third.body.taskId, null);

    assert.equal((await call('GET', `/api/notes?taskId=${taskId}`)).body.items.length, 2);
    const list = await call('GET', `/api/notes?problemId=${problemId}`);
    assert.deepEqual(list.body.items.map((n: { content: string }) => n.content), ['题目页写的', '再写一条', '打卡笔记']);

    const edited = await call('PATCH', `/api/notes/${second.body.id}`, { labels: ['复盘', '易错'] });
    assert.equal(edited.body.content, '再写一条', '只改标注不动正文');
    assert.deepEqual(edited.body.labels, ['复盘', '易错']);
    assert.equal((await call('PATCH', `/api/notes/${second.body.id}`, { content: ' ' })).status, 400);

    const page = await call('GET', '/api/problems/page?pageSize=50&bank=1');
    const row = page.body.items.find((p: { id: number }) => p.id === problemId);
    assert.equal(row.noteCount, 3);
  });
});

test('打卡任务的最后一条笔记不能删，其余可删', async () => {
  await withServer(async (db, call) => {
    const { taskId } = seedTask(db);
    await call('POST', '/api/checkins', { taskId, note: { content: 'a' } });
    const extra = await call('POST', '/api/notes', { taskId, content: 'b' });
    const [{ id: firstId }] = (await call('GET', `/api/notes?taskId=${taskId}`)).body.items.slice(-1);
    assert.equal((await call('DELETE', `/api/notes/${extra.body.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/notes/${firstId}`)).status, 409);
    assert.equal(count(db, 'problem_notes'), 1);
  });
});

test('专题等无题目任务也能打卡写笔记；删任务时这类笔记一起删，有题目的笔记留在题目上', async () => {
  await withServer(async (db, call) => {
    const noProblem = seedTask(db, '专题', false);
    assert.equal((await call('POST', '/api/checkins', { taskId: noProblem.taskId, note: { content: '专题笔记' } })).status, 200);
    const withProblem = seedTask(db, '练习');
    await call('POST', '/api/checkins', { taskId: withProblem.taskId, note: { content: '题目笔记' } });

    assert.equal((await call('DELETE', `/api/plans/${noProblem.planId}`)).status, 200);
    assert.equal(count(db, 'problem_notes'), 1, '级联删任务时触发器要生效');

    assert.equal((await call('DELETE', `/api/plans/${withProblem.planId}`)).status, 200);
    const { body } = await call('GET', `/api/notes?problemId=${withProblem.problemId}`);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].taskId, null);
  });
});

test('删题：题目笔记随题删除，打卡笔记留在任务上；题目合并时笔记跟随保留行', async () => {
  await withServer(async (db, call) => {
    const { taskId, problemId } = seedTask(db);
    await call('POST', '/api/checkins', { taskId, note: { content: '打卡笔记' } });
    await call('POST', '/api/notes', { problemId, content: '题目笔记' });
    assert.equal((await call('DELETE', `/api/problems/${problemId}`)).status, 200);
    const items = (await call('GET', `/api/notes?taskId=${taskId}`)).body.items;
    assert.deepEqual(items.map((n: { content: string }) => n.content), ['打卡笔记']);
    assert.equal(count(db, 'problem_notes'), 1);

    const from = Number(db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', 'T1', 'x', '[]')").run().lastInsertRowid);
    const to = Number(db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', 'P1', 'x', '[]')").run().lastInsertRowid);
    await call('POST', '/api/notes', { problemId: from, content: '合并前' });
    db.exec('BEGIN');
    mergeProblemRow(db, { platform: 'luogu', fromId: from, fromKey: 'T1', toId: to, toKey: 'P1' });
    db.exec('COMMIT');
    assert.equal((await call('GET', `/api/notes?problemId=${to}`)).body.items[0].content, '合并前');
  });
});

test('题库拉取进度：进行中可查、同平台并发被拒、结束后清除', async () => {
  const db = createDb(':memory:');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const fakeFetch = (async () => {
    await gate;
    return new Response(JSON.stringify({ status: 'OK', result: { problems: [], problemStatistics: [] } }), { status: 200 });
  }) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(db, fakeFetch));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/problems`;
  const start = () => fetch(`${base}/bank`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'codeforces' }) });
  try {
    const pending = start();
    let runs: Array<{ platform: string }> = [];
    for (let i = 0; i < 50 && runs.length === 0; i += 1) {
      runs = ((await (await fetch(`${base}/bank/runs`)).json()) as { runs: typeof runs }).runs;
    }
    assert.deepEqual(runs.map((r) => r.platform), ['codeforces']);
    assert.equal((await start()).status, 409);
    release();
    await pending;
    assert.deepEqual(((await (await fetch(`${base}/bank/runs`)).json()) as { runs: unknown[] }).runs, []);
  } finally {
    release();
    srv.close();
    db.close();
  }
});

test('笔记条目：多个代码/图片/附件框按用户顺序保存，空框略去，没有默认 Markdown 框也行', async () => {
  await withServer(async (db, call) => {
    const { taskId } = seedTask(db);
    const blocks = [
      { type: 'code', language: 'cpp', code: 'int main() {}' },
      { type: 'markdown', text: '   ' },
      { type: 'image', url: '/api/uploads/a-1.png', name: 'a.png', caption: '图' },
      { type: 'code', language: 'python', code: 'print(1)\n```\nx' },
      { type: 'attachment', url: '/api/uploads/files/abc-0123456789ab/a%20b.pdf', name: 'a b.pdf', size: 12 },
      { type: 'image', url: '', name: '', caption: '' },
    ];
    assert.equal((await call('POST', '/api/checkins', { taskId, note: { blocks } })).status, 200);
    const [note] = (await call('GET', `/api/notes?taskId=${taskId}`)).body.items;
    assert.deepEqual(note.blocks.map((b: { type: string }) => b.type), ['code', 'image', 'code', 'attachment']);
    assert.match(note.content, /````python\nprint\(1\)\n```\nx\n````/, '代码含反引号时围栏要更长');

    const many = Array.from({ length: 300 }, (_, i) => ({ type: 'code', language: 'cpp', code: `// ${i}` }));
    const edited = await call('PATCH', `/api/notes/${note.id}`, { blocks: many });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.blocks.length, 300, '条目数量不设限');
  });
});

test('笔记条目：全空不算笔记；外部地址和未知类型被拒；纯文本调用方与旧笔记视为一个 Markdown 框', async () => {
  await withServer(async (db, call) => {
    const { taskId, problemId } = seedTask(db);
    const post = (blocks: unknown) => call('POST', '/api/notes', { problemId, blocks });
    assert.equal((await post([])).status, 400);
    assert.equal((await post([{ type: 'code', language: 'cpp', code: ' ' }])).status, 400);
    assert.equal((await post([{ type: 'image', url: 'javascript:alert(1)', name: 'x', caption: '' }])).status, 400);
    assert.equal((await post([{ type: 'image', url: 'https://evil.test/a.png', name: 'x', caption: '' }])).status, 400);
    assert.equal((await post([{ type: 'attachment', url: '/api/uploads/files/../../x/y', name: 'x', size: 1 }])).status, 400);
    assert.equal((await post([{ type: 'video', url: 'x' }])).status, 400);

    await call('POST', '/api/checkins', { taskId, note: { content: '挂件写的' } });
    db.prepare("INSERT INTO problem_notes (user_id, problem_id, content) VALUES (1, ?, '旧笔记')").run(problemId);
    const items = (await call('GET', `/api/notes?problemId=${problemId}`)).body.items;
    assert.deepEqual(items.map((n: { blocks: unknown }) => n.blocks), [
      [{ type: 'markdown', text: '旧笔记' }],
      [{ type: 'markdown', text: '挂件写的' }],
    ]);
  });
});

test('早期建的 problem_notes 表启动时补上 blocks 列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-migrate-'));
  const file = path.join(dir, 'a.db');
  try {
    let db = createDb(file);
    db.exec('ALTER TABLE problem_notes DROP COLUMN blocks');
    db.close();
    db = createDb(file);
    const cols = db.prepare('PRAGMA table_info(problem_notes)').all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === 'blocks'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('附件：任意类型可传，下载强制 attachment，HTML 不会同源渲染；路径穿越与超限被拒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-upload-'));
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', uploadsRoutes({ uploadsDir: dir, db }));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/uploads`;
  const up = (name: string, body: BodyInit, type = 'application/octet-stream') =>
    fetch(`${base}/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body });
  try {
    const res = await up('../../恶意 <x>.html', '<script>alert(1)</script>');
    assert.equal(res.status, 200);
    const info = (await res.json()) as { url: string; name: string; size: number };
    assert.equal(info.name, '恶意 <x>.html', '路径部分被去掉');
    assert.equal(info.size, 25);
    const got = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}${info.url}`);
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await got.text(), '<script>alert(1)</script>');

    assert.equal((await up('empty.txt', '')).status, 400);
    assert.equal((await fetch(`${base}/files/..%2F..%2Fsecret/x`)).status, 404);
    assert.equal((await fetch(`${base}/files/nope-000000000000/x`)).status, 404);
    const id = info.url.split('/')[4];
    assert.equal((await fetch(`${base}/files/${id}`)).status, 404, '不带文件名的路径不走静态服务');
    assert.equal((await up('big.bin', new Uint8Array(50 * 1024 * 1024 + 1))).status, 413);
  } finally {
    srv.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { widgetRoutes } from '../src/routes/widget.ts';

test('GET /widget serves the single-page widget with correct content type', async () => {
  const app = express();
  app.use('/widget', widgetRoutes());
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/widget`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /api\/checkins\/date/); // 轮询当天任务
    assert.match(html, /api\/checkins\/streak/); // 连续打卡徽标
    assert.match(html, /打卡/);
    assert.match(html, /__TAURI_INTERNALS__/);
    assert.match(html, /data-tauri-drag-region/);
  } finally {
    srv.close();
  }
});

test('GET /widget/ (trailing slash) also serves the page', async () => {
  const app = express();
  app.use('/widget', widgetRoutes());
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/widget/`);
    assert.equal(res.status, 200);
  } finally {
    srv.close();
  }
});

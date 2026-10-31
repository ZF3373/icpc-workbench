import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { appearanceRoutes } from '../src/routes/appearance.ts';
import { listenForTest } from './test-listen.ts';

test('background asset copy, settings persistence, byte ranges, validation and reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-appearance-'));
  const app = express(); app.use(express.json()); app.use('/api/appearance', appearanceRoutes(dir));
  const server = await listenForTest(app);
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/appearance`;
  try {
    const initial = await (await fetch(base)).json();
    assert.equal(initial.opacity, .6); assert.equal(initial.file, null);
    const uploaded = await (await fetch(base + '/assets?name=test.mp4', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: '0123456789' })).json();
    assert.equal(uploaded.kind, 'video');
    assert.ok(fs.existsSync(path.join(dir, 'backgrounds', uploaded.file)));
    assert.equal((await (await fetch(base)).json()).file, null, 'candidate is not committed before media validation');
    const save = (body: object) => fetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await save({...uploaded, opacity: .75})).status, 200);
    assert.equal((await (await fetch(base)).json()).opacity, .75);
    const range = await fetch(base + '/assets/' + uploaded.file, {headers:{range:'bytes=2-5'}});
    assert.equal(range.status, 206); assert.equal(await range.text(), '2345');
    assert.equal((await save({opacity: 2})).status, 400);
    assert.equal((await save({file: '../icpc.db'})).status, 400);
    assert.equal((await fetch(base + '/assets/' + uploaded.file, {method:'DELETE'})).status, 409);
    assert.equal((await fetch(base + '/assets?name=bad.html', {method:'POST',body:'bad'})).status, 415);
    await save({file:null,opacity:.6});
    assert.equal((await (await fetch(base)).json()).file, null);
    assert.equal(fs.existsSync(path.join(dir,'backgrounds',uploaded.file)), false);
    const next = await (await fetch(base + '/assets?name=image.png', {method:'POST', headers:{'content-type':'application/octet-stream'},body:'test'})).json();
    assert.equal(next.kind,'image');
    assert.equal((await fetch(base+'/assets/'+next.file,{method:'DELETE'})).status,200);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); fs.rmSync(dir,{recursive:true,force:true}); }
});

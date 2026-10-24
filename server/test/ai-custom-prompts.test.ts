import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { listenForTest } from './test-listen.ts';
import { createDb } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

test('custom prompts persist, merge with training context on every request, and stay out of visible turns', async () => {
  const db = createDb(':memory:');
  const captured: Array<Array<{ role: string; content: unknown }>> = [];
  const app = express();
  app.use(express.json());
  app.use('/settings', settingsRoutes(db, DEFAULT_CONFIG));
  app.use('/ai', aiRoutes(db, () => ({ enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' }), {
    fetchContests: async () => ({ contests: [], failures: {} }),
    createProvider: () => ({
      enabled: true,
      chat: async () => 'ok',
      chatStream: async function* (messages) {
        captured.push(structuredClone(messages));
        yield 'ok';
      },
    }),
  }));
  const server = await listenForTest(app);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const save = (prompts: unknown) => fetch(`${base}/settings/ai/custom-prompts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompts }),
  });
  const send = async () => {
    const response = await fetch(`${base}/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '帮我训练' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /CUSTOM_ONE|CUSTOM_TWO/);
  };
  try {
    assert.deepEqual(await (await fetch(`${base}/settings/ai/custom-prompts`)).json(), []);
    await send();
    const originalSystem = captured[0][0].content as string;
    const prompts = [{ title: '讲解', content: 'CUSTOM_ONE' }, { title: '风格', content: 'CUSTOM_TWO' }];
    assert.equal((await save(prompts)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/settings/ai/custom-prompts`)).json(), prompts);
    for (const invalid of [null, {}, [{ title: '', content: 'x' }], [{ title: 'x', content: ' ' }],
      [{ title: 'x', content: 1 }], [{ title: 'x', content: 'x'.repeat(20001) }],
      Array.from({ length: 51 }, () => prompts[0])]) {
      assert.equal((await save(invalid)).status, 400);
    }
    await send();
    const system = captured[1][0].content as string;
    assert.ok(system.startsWith(originalSystem));
    assert.ok(system.indexOf('CUSTOM_ONE') < system.indexOf('CUSTOM_TWO'));
    assert.deepEqual(captured[1].slice(1), [{ role: 'user', content: '帮我训练' }]);
    assert.equal((await save([{ title: '新内容', content: 'CUSTOM_EDITED' }])).status, 200);
    await send();
    assert.match(captured[2][0].content as string, /CUSTOM_EDITED/);
    assert.doesNotMatch(captured[2][0].content as string, /CUSTOM_ONE|CUSTOM_TWO/);
    assert.equal((await save([])).status, 200);
    await send();
    assert.equal(captured[3][0].content, originalSystem);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

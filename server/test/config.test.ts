import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  aiConfigFromDb,
  loadConfig,
  saveAiConfig,
} from '../src/config.ts';
import { createDb, type Db } from '../src/db/index.ts';

function tmpConfig(obj: unknown): string {
  const p = path.join(
    os.tmpdir(),
    `icpc-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('loadConfig falls back to defaults when file missing', () => {
  const p = path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const cfg = loadConfig(p);
  assert.equal(cfg.port, 3001);
  assert.equal(cfg.ai.enabled, false);
  assert.ok(cfg.dbPath.length > 0);
});

test('loadConfig parses file and resolves relative dbPath to absolute', () => {
  const p = tmpConfig({ port: 4000, dbPath: 'data/test.db' });
  try {
    const cfg = loadConfig(p);
    assert.equal(cfg.port, 4000);
    assert.ok(path.isAbsolute(cfg.dbPath));
  } finally {
    fs.unlinkSync(p);
  }
});

test('loadConfig rejects invalid port', () => {
  const p = tmpConfig({ port: 'abc' });
  try {
    assert.throws(() => loadConfig(p), /port/);
  } finally {
    fs.unlinkSync(p);
  }
});

test('loadConfig rejects ai.enabled without apiKey', () => {
  const p = tmpConfig({ ai: { enabled: true, apiKey: '' } });
  try {
    assert.throws(() => loadConfig(p), /apiKey/);
  } finally {
    fs.unlinkSync(p);
  }
});

test('aiConfigFromDb overrides file config via settings table', () => {
  delete process.env.AI_API_KEY;
  const db: Db = createDb(':memory:');
  const cfg = {
    ...DEFAULT_CONFIG,
    ai: { ...DEFAULT_CONFIG.ai, baseURL: 'https://file.example/v1', model: 'm1' },
  };
  try {
    saveAiConfig(db, cfg, {
      enabled: true,
      baseURL: 'https://db.example/v1',
      model: 'm2',
      apiKey: 'k-db',
    });
    const ai = aiConfigFromDb(db, cfg);
    assert.equal(ai.enabled, true);
    assert.equal(ai.baseURL, 'https://db.example/v1');
    assert.equal(ai.model, 'm2');
    assert.equal(ai.apiKey, 'k-db');
  } finally {
    db.close();
  }
});

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('launchWidget 默认 true', () => {
  assert.equal(loadConfig(writeTempConfig('{}')).launchWidget, true);
});

test('launchWidget=false 被读取', () => {
  assert.equal(loadConfig(writeTempConfig('{"launchWidget": false}')).launchWidget, false);
});

test('launchWidget 非布尔值回退默认 true', () => {
  assert.equal(loadConfig(writeTempConfig('{"launchWidget": "yes"}')).launchWidget, true);
});

test('DEFAULT_CONFIG.launchWidget 为 true', () => {
  assert.equal(DEFAULT_CONFIG.launchWidget, true);
});

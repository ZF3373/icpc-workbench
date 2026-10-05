import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  activeProviderIdOf,
  aiConfigFromDb,
  loadConfig,
  readAiProviders,
  saveAiConfig,
  saveAiProviders,
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

// ---------- 多模型提供商（readAiProviders / saveAiProviders） ----------

test('readAiProviders 把旧版单提供商配置迁移为 default 提供商（不写库，兼容零操作）', () => {
  delete process.env.AI_API_KEY;
  const db: Db = createDb(':memory:');
  try {
    saveAiConfig(db, DEFAULT_CONFIG, {
      baseURL: 'https://legacy.example/v1',
      apiKey: 'k-legacy',
      model: 'legacy-model',
      maxTokens: 123456,
      contextWindow: 234567,
    });
    const providers = readAiProviders(db, DEFAULT_CONFIG);
    assert.deepEqual(providers, [{
      id: 'default',
      name: '默认提供商',
      baseURL: 'https://legacy.example/v1',
      apiKey: 'k-legacy',
      model: 'legacy-model',
      // 迁移要带上已调过的全局档位：否则升级后参数会「跳回」内置默认
      maxTokens: 123456,
      contextWindow: 234567,
    }]);
    assert.equal(activeProviderIdOf(db, providers), 'default');
    // aiConfigFromDb 聚合口径与迁移结果一致（AI 请求路径无缝切换到提供商来源）
    const ai = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(ai.baseURL, 'https://legacy.example/v1');
    assert.equal(ai.apiKey, 'k-legacy');
    assert.equal(ai.model, 'legacy-model');
    assert.equal(ai.maxTokens, 123456);
    assert.equal(ai.contextWindow, 234567);
  } finally {
    db.close();
  }
});

test('saveAiProviders 整表覆盖保存，aiConfigFromDb 按 activeProvider 解析（含切换）', () => {
  delete process.env.AI_API_KEY;
  const db: Db = createDb(':memory:');
  try {
    const stored = saveAiProviders(
      db,
      [
        { id: 'p1', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'k1', model: 'deepseek-chat' },
        { id: 'p2', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'k2', model: 'gpt-4o-mini' },
      ],
      'p2',
    );
    assert.equal(stored.length, 2);
    assert.equal(activeProviderIdOf(db, readAiProviders(db, DEFAULT_CONFIG)), 'p2');
    const ai = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(ai.baseURL, 'https://api.openai.com/v1');
    assert.equal(ai.apiKey, 'k2');
    assert.equal(ai.model, 'gpt-4o-mini');

    // 切回 p1：解析随之切换
    saveAiProviders(db, stored, 'p1');
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).apiKey, 'k1');
  } finally {
    db.close();
  }
});

test('saveAiProviders 活跃 id 失效回退第一个；坏条目被净化；空列表拒绝', () => {
  delete process.env.AI_API_KEY;
  const db: Db = createDb(':memory:');
  try {
    saveAiProviders(
      db,
      [
        // 坏 baseURL / 缺 name 的条目被丢掉；id 重复去重
        { id: 'bad', name: '', baseURL: 'https://x.example/v1', apiKey: '', model: '' },
        { id: 'bad2', name: '无协议', baseURL: 'api.example.com/v1', apiKey: '', model: '' },
        { id: 'ok', name: '可用', baseURL: 'https://ok.example/v1', apiKey: 'k', model: 'm' },
        { id: 'ok', name: '重复', baseURL: 'https://dup.example/v1', apiKey: '', model: '' },
      ] as never,
      'no-such-id',
    );
    const providers = readAiProviders(db, DEFAULT_CONFIG);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.id, 'ok');
    // 活跃 id 指向已删除的提供商 → 回退第一个
    assert.equal(activeProviderIdOf(db, providers), 'ok');

    assert.throws(() => saveAiProviders(db, [], ''));
    assert.throws(() => saveAiProviders(db, [{ id: 'x', name: 'n', baseURL: 'ftp://x', apiKey: '', model: '' } as never], 'x'));
  } finally {
    db.close();
  }
});

test('最大输出/上下文长度按提供商覆盖解析：活跃项优先，未填回退全局', () => {
  delete process.env.AI_API_KEY;
  const db: Db = createDb(':memory:');
  try {
    saveAiProviders(
      db,
      [
        // 非法值（0/负数/字符串）被净化丢弃
        { id: 'p1', name: 'A', baseURL: 'https://a.example/v1', apiKey: '', model: 'ma', maxTokens: 8192, contextWindow: 131072 },
        { id: 'p2', name: 'B', baseURL: 'https://b.example/v1', apiKey: '', model: 'mb', maxTokens: 0, contextWindow: -1 },
      ] as never,
      'p1',
    );
    const ai1 = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(ai1.maxTokens, 8192);
    assert.equal(ai1.contextWindow, 131072);

    // 切到未填档位的 p2 → 回退全局链（DEFAULT_CONFIG：384K / 1000K）
    const stored = readAiProviders(db, DEFAULT_CONFIG);
    saveAiProviders(db, stored, 'p2');
    const ai2 = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(ai2.maxTokens, DEFAULT_CONFIG.ai.maxTokens);
    assert.equal(ai2.contextWindow, DEFAULT_CONFIG.ai.contextWindow);
    // 非法值未落库
    assert.equal(readAiProviders(db, DEFAULT_CONFIG).find((p) => p.id === 'p2')?.maxTokens, undefined);
  } finally {
    db.close();
  }
});

test('模型目录条目参数优先于提供商级档位；目录被净化去重', () => {
  delete process.env.AI_API_KEY;
  const db: Db = createDb(':memory:');
  try {
    saveAiProviders(
      db,
      [
        {
          id: 'p1',
          name: 'A',
          baseURL: 'https://a.example/v1',
          apiKey: '',
          model: 'model-b',
          maxTokens: 8192,
          contextWindow: 131072,
          models: [
            { id: 'model-a', maxTokens: 65536, contextWindow: 204800 },
            { id: 'model-b' }, // 命中当前模型但无参数 → 回退提供商级
            { id: 'model-a', maxTokens: 1 }, // 重复 id 去重
            { id: '', maxTokens: 5 }, // 空 id 丢弃
            { id: 'model-c', maxTokens: -5 }, // 非法参数丢弃（条目保留）
          ],
        },
      ] as never,
      'p1',
    );
    // 当前 model-b：条目无参数 → 提供商级
    const ai = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(ai.maxTokens, 8192);
    assert.equal(ai.contextWindow, 131072);

    // 切到 model-a：条目参数优先于提供商级
    const stored = readAiProviders(db, DEFAULT_CONFIG);
    saveAiProviders(db, stored, 'p1');
    const p1 = readAiProviders(db, DEFAULT_CONFIG).find((p) => p.id === 'p1')!;
    // 目录净化：model-a 去重保留首条、空 id 丢弃、model-c 保留但剔除非法参数
    assert.deepEqual(
      p1.models?.map((m) => [m.id, m.maxTokens, m.contextWindow]),
      [['model-a', 65536, 204800], ['model-b', undefined, undefined], ['model-c', undefined, undefined]],
    );
    saveAiProviders(db, [{ ...p1, model: 'model-a' }], 'p1');
    const aiA = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(aiA.maxTokens, 65536);
    assert.equal(aiA.contextWindow, 204800);
  } finally {
    db.close();
  }
});

test('readAiProviders 不把 env 密钥合成进提供商；保存时更不落库（回归）', () => {
  // 旧行为：迁移合成时把 process.env.AI_API_KEY 塞进 default 的 apiKey，POST /ai 的
  // 「保持已存密钥」兜底又把它原样写进 settings.ai.providers（并进入每日备份）——
  // 只想用环境变量托管密钥的用户，密钥被复制进 DB，取消 env 后 DB 副本仍生效。
  const savedEnv = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'env-secret-key-1234';
  const db: Db = createDb(':memory:');
  try {
    const providers = readAiProviders(db, DEFAULT_CONFIG);
    assert.equal(providers[0]!.apiKey, '', 'env 不进读取路径（库里本来就没有密钥）');
    assert.equal(providers[0]!.id, 'default');
    // 运行时仍以 env 为最高优先（读取侧不合成、请求侧照旧生效）
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).apiKey, 'env-secret-key-1234');

    // 复刻 POST /ai：缺省 apiKey → 用 prev（读取侧）兜底 → 落库
    saveAiProviders(
      db,
      [{
        id: 'default',
        name: '默认提供商',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: providers[0]!.apiKey,
        model: 'deepseek-chat',
      }],
      'default',
    );
    const raw = (db.prepare("SELECT value FROM settings WHERE key = 'ai.providers'").get() as { value: string }).value;
    assert.doesNotMatch(raw, /env-secret/, 'env 密钥绝不落库');
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).apiKey, 'env-secret-key-1234', 'env 依旧运行时生效');
  } finally {
    db.close();
    if (savedEnv === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedEnv;
  }
});

test('saveAiProviders：缺省 activeId 保持已存活跃项，失效才回退首项', () => {
  const db: Db = createDb(':memory:');
  try {
    const list = [
      { id: 'p1', name: 'A', baseURL: 'https://a.example/v1', apiKey: 'k1', model: 'ma' },
      { id: 'p2', name: 'B', baseURL: 'https://b.example/v1', apiKey: 'k2', model: 'mb' },
    ];
    saveAiProviders(db, list, 'p2');
    // 不传 activeId（旧客户端/脚本）→ 不该被静默切回首项
    saveAiProviders(db, list);
    assert.equal(activeProviderIdOf(db, readAiProviders(db, DEFAULT_CONFIG)), 'p2');
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).apiKey, 'k2');
    // 指向已删除的 id → 回退首项
    saveAiProviders(db, list, 'gone');
    assert.equal(activeProviderIdOf(db, readAiProviders(db, DEFAULT_CONFIG)), 'p1');
  } finally {
    db.close();
  }
});

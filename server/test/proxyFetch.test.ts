/**
 * proxyFetch（OpenAI 系请求的代理装配）单元测试。
 *
 * 代理行为用**本地假代理服务器**端到端验证：undici v7 的 ProxyAgent 对 http/https
 * 目标统一走 CONNECT 隧道（实测），假代理完成 CONNECT 握手后对隧道内的 HTTP 请求
 * 回「via-proxy」——据此断言请求确实经过了代理而不是直连目标。不走外网。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { clearProxyAgentsForTest, proxyFetch, resolveProxyUrl } from '../src/ai/proxyFetch.ts';

/** 起一个假代理：完成 CONNECT 握手，对隧道内请求回固定响应；返回 { port, close } */
async function listenFakeProxy(): Promise<{ port: number; close: () => void; authoritySeen: () => string }> {
  let authority = '';
  const srv = http.createServer(() => {
    // v7 ProxyAgent 对所有目标都走 CONNECT（request 事件只在「未走代理的直连」时命中——
    // 真到这里说明代理没生效，由断言 via-proxy 失败暴露）
  });
  srv.on('connect', (req, socket, head) => {
    authority = req.url ?? '';
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const respond = (): void => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvia-proxy');
      socket.end();
    };
    if (head && head.length > 0) respond();
    else socket.once('data', respond);
    socket.on('error', () => {});
  });
  srv.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => {
      srv.closeAllConnections();
      srv.close();
    },
    authoritySeen: () => authority,
  };
}

describe('resolveProxyUrl（显式值 → 环境变量回退）', () => {
  it('显式值优先，且 trim 空白；空串/纯空白不算显式', () => {
    const prev = { ...process.env };
    process.env.HTTPS_PROXY = 'http://env-proxy:1';
    try {
      assert.equal(resolveProxyUrl('  http://explicit:7890  '), 'http://explicit:7890');
      assert.equal(resolveProxyUrl('   '), 'http://env-proxy:1', '纯空白 = 无显式值，回退环境变量');
    } finally {
      process.env = prev;
    }
  });

  it('无显式值时按 HTTPS_PROXY → HTTP_PROXY → ALL_PROXY（大小写都认）回退', () => {
    const prev = { ...process.env };
    try {
      for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
      assert.equal(resolveProxyUrl(), undefined, '全都没有 = 直连');
      process.env.HTTP_PROXY = 'http://upper-http:2';
      assert.equal(resolveProxyUrl(), 'http://upper-http:2');
      process.env.https_proxy = 'http://lower-https:3';
      assert.equal(resolveProxyUrl(), 'http://lower-https:3', '小写 HTTPS_PROXY 优先于大写 HTTP_PROXY');
      for (const k of ['HTTPS_PROXY', 'https_proxy']) delete process.env[k];
      process.env.all_proxy = 'http://all:4';
      assert.equal(resolveProxyUrl(), 'http://upper-http:2', 'HTTP_PROXY 优先于 ALL_PROXY');
      delete process.env.HTTP_PROXY;
      delete process.env.http_proxy;
      assert.equal(resolveProxyUrl(), 'http://all:4');
    } finally {
      process.env = prev;
    }
  });
});

describe('proxyFetch（代理装配）', () => {
  it('测试注入的 fetchFn 优先于代理（桩不被真实代理改变行为）', () => {
    const stub = (async () => new Response('stub')) as typeof fetch;
    assert.equal(proxyFetch('http://127.0.0.1:1', stub), stub);
    assert.equal(proxyFetch(undefined, stub), stub);
  });

  it('无代理且无注入 = 全局 fetch 本体（零行为变化）', () => {
    assert.equal(proxyFetch(undefined), fetch);
  });

  it('配置代理后请求确实经代理发出（本地假代理端到端，不走外网）', async () => {
    clearProxyAgentsForTest();
    const proxy = await listenFakeProxy();
    try {
      const doFetch = proxyFetch(`http://127.0.0.1:${proxy.port}`);
      const res = await doFetch('http://example.invalid/ping?x=1');
      assert.equal(await res.text(), 'via-proxy', '响应必须来自代理而不是目标直连');
      assert.match(proxy.authoritySeen(), /example\.invalid(?::80)?/, '代理收到的 CONNECT authority 应为目标地址');
    } finally {
      proxy.close();
      clearProxyAgentsForTest();
    }
  });

  it('同一代理地址复用连接（多次请求都成功）', async () => {
    clearProxyAgentsForTest();
    const proxy = await listenFakeProxy();
    try {
      const doFetch = proxyFetch(`http://127.0.0.1:${proxy.port}`);
      for (let i = 0; i < 3; i++) {
        const res = await doFetch('http://example.invalid/ping');
        assert.equal(await res.text(), 'via-proxy');
      }
    } finally {
      proxy.close();
      clearProxyAgentsForTest();
    }
  });
});

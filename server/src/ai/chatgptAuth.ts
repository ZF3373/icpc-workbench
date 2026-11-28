/**
 * Sign in with ChatGPT（SIWC）开源接入流程（issue 67 原始诉求）。
 *
 * 官方契约（developers.openai.com/siwc/token-sharing-open-source，与 LinguaGacha /
 * shelley / openchatx-mcp 三个独立开源实现交叉验证一致）：
 * - 动态客户端：authorize 以 client_id=`dynamic_agent_client` 发起，OpenAI 签发
 *   专属 client_id 并经回调 query 返回；后续 token/刷新/撤销都用签发的 id。
 * - OAuth PKCE + OIDC：`https://auth.openai.com/api/accounts/authorize`，
 *   redirect_uri 是 127.0.0.1 回环临时端口，state 归属校验 + nonce 防重放，
 *   code_verifier 只存在于服务端内存。
 * - scope：`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`；
 *   token 响应必须带 plan scope，否则套餐额度未被授权。
 * - token：access_token ~1h，refresh_token ~30d **轮换**（一次一用，必须立即落库），
 *   刷新 terminal 错误（invalid_grant / refresh_token_* 等）= 必须重新登录。
 * - 推理：`POST https://api.openai.com/v1/responses`，Bearer access_token；
 *   套餐模型目录 `GET /v1/models`（`{models:[{slug,display_name,visibility}]}`，
 *   取 visibility==='list' 的 slug）。
 * - 凭据存储：settings 表，AES-256-GCM 加密（密钥在 dataDir 独立文件，不进 DB 备份）——
 *   token 不能沿用 apiKey 的明文级别（issue67 复核结论）。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { SettingLookup } from '../db/settings.ts';

const DEFAULT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const CALLBACK_PATH = '/auth/callback';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** 授权回调等待上限：用户在浏览器里操作的最长宽限 */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** access_token 到期前的刷新余量 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** 刷新 terminal 错误：refresh_token 已作废，只能重新登录（官方错误码口径） */
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/** 一份已登录的 ChatGPT 凭据（轮换语义：refreshToken 每次刷新都换新） */
export interface ChatgptCredential {
  /** OpenAI 签发的动态 client_id（回调带回；刷新/撤销都携带它） */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** access_token 过期时间（毫秒，本机时钟） */
  expiresAt: number;
  scope: string;
  /** OIDC sub（账号稳定标识） */
  accountId: string;
  email: string;
  /** 会话标识：登录时新生成、刷新保持不变 */
  sessionId: string;
}

/** 测试注入：fake 授权服务器与 fetch（真实使用为空 = 官方端点 + 全局 fetch） */
export interface ChatgptAuthDeps {
  fetchFn?: typeof fetch;
  /** 覆盖 issuer 源（authorize/token/metadata 端点全部随之指向 fake 服务器） */
  issuerOrigin?: string;
  /** 覆盖 resource（默认 https://api.openai.com/v1） */
  resource?: string;
}

let authDeps: ChatgptAuthDeps = {};
/** 仅测试使用：把授权端点/fetch 指向 fake 服务器；传 null 恢复官方配置 */
export function setChatgptAuthDepsForTest(deps: ChatgptAuthDeps | null): void {
  authDeps = deps ?? {};
}

const authFetch = (): typeof fetch => authDeps.fetchFn ?? fetch;
const issuerOrigin = (): string => authDeps.issuerOrigin ?? DEFAULT_ISSUER;
const resource = (): string => authDeps.resource ?? CHATGPT_RESOURCE;

// ---------- 凭据加解密（AES-256-GCM，密钥文件在 dataDir，不进 DB/备份） ----------

const AUTH_SETTINGS_KEY = 'ai.chatgptAuth';
const HOST_ID_SETTINGS_KEY = 'ai.chatgptHostId';
const KEY_FILE_NAME = 'ai-chatgpt-auth.key';

function authKeyFile(cfg: AppConfig): string {
  return path.join(cfg.dataDir, KEY_FILE_NAME);
}

/** 读取（首次自动创建）凭据加密密钥：独立于 DB 的本机文件，备份里只有密文 */
function loadOrCreateAuthKey(cfg: AppConfig): Buffer {
  const file = authKeyFile(cfg);
  try {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) return raw.subarray(0, 32);
  } catch {
    // 首次使用：生成新密钥
  }
  const key = randomBytes(32);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

function decryptJson<T>(payload: string, key: Buffer): T | null {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    // GCM 的 auth tag 必须经 setAuthTag 传入（createDecipheriv 第 4 参是 options 对象，
    // 不是 tag——直接塞 Buffer 会让 final() 抛认证错，解密恒为 null）
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  } catch {
    return null; // 密钥丢失/数据损坏：按未登录处理，让用户重新登录
  }
}

// ---------- 凭据存取（settings 表，密文落库） ----------

function settingsGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function settingsUpsert(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function settingsDelete(db: Db, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/**
 * 读取当前登录的 ChatGPT 凭据（密文解密）；未登录/解密失败返回 null。
 * `read` 为请求内 settings 快照时直接复用（GET /settings 有「整表一次查询」的
 * 性能不变量，逐 key prepare 会被 settings-snapshot 测试拦下）。
 */
export function readChatgptCredential(db: Db, cfg: AppConfig, read?: SettingLookup): ChatgptCredential | null {
  const raw = read ? read(AUTH_SETTINGS_KEY) : settingsGet(db, AUTH_SETTINGS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { enc?: string };
    if (typeof parsed.enc !== 'string') return null;
    return decryptJson<ChatgptCredential>(parsed.enc, loadOrCreateAuthKey(cfg));
  } catch {
    return null;
  }
}

/** 保存凭据（整体 AES-256-GCM 加密后落库；原文不进 DB 与备份） */
export function saveChatgptCredential(db: Db, cfg: AppConfig, cred: ChatgptCredential): void {
  const enc = encryptJson(cred, loadOrCreateAuthKey(cfg));
  settingsUpsert(db, AUTH_SETTINGS_KEY, JSON.stringify({ v: 1, enc }));
}

/** 清除凭据（登出/刷新 terminal 失效时） */
export function clearChatgptCredential(db: Db, cfg: AppConfig): void {
  settingsDelete(db, AUTH_SETTINGS_KEY);
}

/** 每安装稳定的主机标识（ext_agent_host_id）：同一安装重复登录复用已签发 client 的信任 */
export function ensureChatgptHostId(db: Db): string {
  const existing = settingsGet(db, HOST_ID_SETTINGS_KEY);
  if (existing) return existing;
  const hostId = randomUUID();
  settingsUpsert(db, HOST_ID_SETTINGS_KEY, hostId);
  return hostId;
}

// ---------- token 接口（官方契约：form-urlencoded，resource 必带） ----------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

interface TokenRequestResult {
  cred: Omit<ChatgptCredential, 'clientId' | 'accountId' | 'email' | 'sessionId'>;
  idToken: string;
}

/** token 接口的机器可读错误（HTTP 状态 + provider 错误码） */
export class ChatgptAuthError extends Error {
  readonly status: number;
  readonly code: string;
  /** terminal = refresh_token 已作废，必须重新登录 */
  readonly terminal: boolean;

  constructor(status: number, code: string, message: string) {
    super(`ChatGPT 登录接口错误（HTTP ${status}${code ? ` ${code}` : ''}）：${message}`);
    this.name = 'ChatgptAuthError';
    this.status = status;
    this.code = code;
    this.terminal = TERMINAL_REFRESH_ERRORS.has(code);
  }
}

async function requestToken(form: URLSearchParams, signal?: AbortSignal): Promise<TokenRequestResult> {
  const res = await authFetch()(`${issuerOrigin()}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = '';
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      code = String(parsed.error ?? '');
      message = String(parsed.error_description ?? parsed.error ?? message);
    } catch {
      // 非 JSON 错误体：保留原文
    }
    throw new ChatgptAuthError(res.status, code, message);
  }
  const data = (await res.json()) as TokenResponse;
  if (
    typeof data.access_token !== 'string' || data.access_token === '' ||
    typeof data.refresh_token !== 'string' || data.refresh_token === '' ||
    typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
    typeof data.scope !== 'string' || !data.scope.split(/\s+/).includes(PLAN_SCOPE)
  ) {
    // scope 缺 plan 权限 = 用户未授予套餐使用（或官方契约变化），明确报错而不是存一份废凭据
    const gotPlan = typeof data.scope === 'string' && data.scope.split(/\s+/).includes(PLAN_SCOPE);
    throw new Error(
      gotPlan
        ? 'ChatGPT 登录接口返回不完整'
        : 'ChatGPT 登录未授予套餐使用权限（chatgpt.tokens.use.direct），请在授权页勾选同意后重试',
    );
  }
  if (typeof data.id_token !== 'string' || data.id_token === '') {
    throw new Error('ChatGPT 登录接口未返回身份令牌（id_token）');
  }
  return {
    cred: {
      accessToken: data.access_token!,
      refreshToken: data.refresh_token!,
      expiresAt: Date.now() + data.expires_in! * 1000,
      scope: data.scope!,
    },
    idToken: data.id_token!,
  };
}

// ---------- ID token 验证（RS256 + JWKS，node:crypto 实现，零新依赖） ----------

function b64urlDecodeToBuffer(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface IdTokenClaims {
  sub: string;
  email: string;
}

interface Discovery {
  jwksUri: string;
  revocationEndpoint: string;
}

let discoveryCache: { origin: string; value: Discovery } | null = null;

/** OIDC 发现文档：jwks/撤销端点受同源守卫（发现的端点不能改写凭据发送边界） */
async function fetchDiscovery(signal?: AbortSignal): Promise<Discovery> {
  const origin = issuerOrigin();
  if (discoveryCache?.origin === origin) return discoveryCache.value;
  const res = await authFetch()(  `${origin}/.well-known/openid-configuration`, { signal });
  if (!res.ok) throw new Error(`获取 ChatGPT 认证元数据失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { issuer?: string; jwks_uri?: string; revocation_endpoint?: string };
  if (data.issuer !== origin) throw new Error('ChatGPT 认证元数据签发者不匹配');
  const sameOrigin = (u: string): string => {
    if (!u || new URL(u).origin !== origin) throw new Error('ChatGPT 认证端点发现结果超出官方授权源');
    return u;
  };
  const value: Discovery = {
    jwksUri: sameOrigin(String(data.jwks_uri ?? '')),
    revocationEndpoint: sameOrigin(String(data.revocation_endpoint ?? '')),
  };
  discoveryCache = { origin, value };
  return value;
}

interface TokenVerifyOptions {
  audience: string;
  nonce?: string;
  signal?: AbortSignal;
}

/**
 * 验证 id_token：RS256 签名（JWKS）+ iss/aud/exp/sub（登录场景额外验 nonce 防重放）。
 * 官方流程要求验证身份令牌；JWKS 端点必须与 issuer 同源。
 */
async function verifyIdToken(idToken: string, opts: TokenVerifyOptions): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT 身份令牌格式不合法');
  const header = JSON.parse(b64urlDecodeToBuffer(parts[0]!).toString('utf8')) as { alg?: string; kid?: string };
  const claims = JSON.parse(b64urlDecodeToBuffer(parts[1]!).toString('utf8')) as Record<string, unknown>;
  if (header.alg !== 'RS256') throw new Error('ChatGPT 身份令牌签名算法异常');
  if (claims.iss !== issuerOrigin()) throw new Error('ChatGPT 身份令牌签发者不匹配');
  const aud = claims.aud;
  if (aud !== opts.audience && !(Array.isArray(aud) && (aud as string[]).includes(opts.audience))) {
    throw new Error('ChatGPT 身份令牌受众不匹配');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) throw new Error('ChatGPT 身份令牌已过期');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('ChatGPT 身份令牌缺少账号标识');
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) {
    throw new Error('ChatGPT 身份令牌 nonce 不匹配（可能的授权重放）');
  }

  const metadata = await fetchDiscovery(opts.signal);
  const jwks = await authFetch()(metadata.jwksUri, { signal: opts.signal });
  if (!jwks.ok) throw new Error(`获取 ChatGPT 公钥失败（HTTP ${jwks.status}）`);
  const jwksBody = (await jwks.json()) as { keys?: Array<Record<string, unknown>> };
  const jwk = jwksBody.keys?.find((k) => k.kid === header.kid || (!header.kid && k.kty === 'RSA'));
  if (!jwk) throw new Error('ChatGPT 公钥集合中没有匹配的密钥');
  const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
  const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, b64urlDecodeToBuffer(parts[2]!));
  if (!ok) throw new Error('ChatGPT 身份令牌签名验证失败');
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : claims.sub,
  };
}

// ---------- 登录（PKCE + 回环回调 + 动态客户端签发） ----------

export interface ChatgptLoginSnapshot {
  loginId: string;
  status: 'pending' | 'ok' | 'failed' | 'expired';
  email?: string;
  message?: string;
}

interface LoginSession {
  snapshot: ChatgptLoginSnapshot;
  createdAt: number;
}

const loginSessions = new Map<string, LoginSession>();

function pruneLoginSessions(): void {
  const now = Date.now();
  for (const [id, s] of loginSessions) {
    if (now - s.createdAt > LOGIN_TIMEOUT_MS * 2) loginSessions.delete(id);
  }
}

export interface StartChatgptLoginOptions {
  appName: string;
  hostId: string;
  /** 登录成功后的落库动作（由路由层注入，避免本模块反向依赖 config.ts） */
  onSuccess: (cred: ChatgptCredential, planModels: string[]) => Promise<void>;
}

/**
 * 发起一次登录：起回环回调服务器（临时端口）→ 返回授权 URL（前端用系统浏览器打开）。
 * 用 pollChatgptLogin(loginId) 轮询结果；成功前凭据不落库。
 */
export async function startChatgptLogin(opts: StartChatgptLoginOptions): Promise<{ loginId: string; authorizeUrl: string }> {
  pruneLoginSessions();
  // state 归属校验、nonce 防重放、verifier 只留在内存参与 code 交换
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const loginId = `l_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const session: LoginSession = { snapshot: { loginId, status: 'pending' }, createdAt: Date.now() };
  loginSessions.set(loginId, session);

  let accepted = false;
  let redirectUri = '';
  // ⚠ server 必须在 executor 之前创建：executor 里挂 onRequest 引用 server，
  // 「先 new Promise 后建 server」的顺序是 TDZ——executor 抛 ReferenceError 会让
  // callbackPromise 立即拒绝、finally 里的 close 再炸一次，回调服务器从未监听。
  const server = createServer();
  const callbackPromise = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!accepted) reject(new Error('登录超时（5 分钟内未完成浏览器授权）'));
    }, LOGIN_TIMEOUT_MS);
    const finish = (res: ServerResponse, status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (accepted || url.pathname !== CALLBACK_PATH || url.searchParams.get('state') !== state) {
        finish(res, 400, 'Invalid authorization callback.');
        return;
      }
      accepted = true;
      clearTimeout(timeout);
      const errParam = url.searchParams.get('error');
      if (errParam) {
        finish(res, 200, '登录已取消或失败，可关闭本窗口并回到工作台查看结果。');
        reject(new Error(
          errParam === 'access_denied'
            ? '已取消 ChatGPT 授权'
            : `授权失败：${url.searchParams.get('error_description') ?? errParam}`,
        ));
        return;
      }
      const code = url.searchParams.get('code');
      const clientId = url.searchParams.get('client_id');
      if (!code || !clientId || clientId === DYNAMIC_CLIENT_ID) {
        // 官方动态注册在回调里带回签发的 client_id；拿不到说明流程异常
        finish(res, 400, 'Authorization failed. Return to the app.');
        reject(new Error('授权回调缺少 code 或签发的 client_id'));
        return;
      }
      finish(res, 200, '授权完成！回到 ICPC Workbench 查看登录结果，本窗口可以关闭。');
      resolve({ code, clientId });
    };
    server.on('request', onRequest);
  });
  // 生命周期（同理必须在 callbackPromise 创建之后挂，见上方 TDZ 注释）
  callbackPromise.catch(() => {}).finally(() => {
    server.close();
    server.closeAllConnections();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => reject(new Error(`登录回调服务器启动失败：${(e as Error).message}`)));
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (e) {
    loginSessions.delete(loginId);
    throw e;
  }
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    server.close();
    loginSessions.delete(loginId);
    throw new Error('登录回调服务器端口分配失败');
  }
  redirectUri = `http://127.0.0.1:${addr.port}${CALLBACK_PATH}`;
  const authorizeUrl = new URL(`${issuerOrigin()}/api/accounts/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: opts.appName,
    ext_agent_host_id: opts.hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    resource: resource(),
    scope: SCOPES,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString();

  // 完成链：code 交换 → 身份验证 → 拉套餐模型 → 落库回调；任何失败都转为 failed 快照
  void (async (): Promise<void> => {
    try {
      const { code, clientId } = await callbackPromise;
      const { cred, idToken } = await requestToken(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: resource(),
        }),
      );
      const identity = await verifyIdToken(idToken, { audience: clientId, nonce });
      const full: ChatgptCredential = {
        clientId,
        ...cred,
        accountId: identity.sub,
        email: identity.email,
        sessionId: randomUUID(),
      };
      const models = await listChatgptPlanModels(full.accessToken);
      await opts.onSuccess(full, models);
      session.snapshot = { loginId, status: 'ok', email: full.email };
    } catch (e) {
      session.snapshot = { loginId, status: 'failed', message: (e as Error).message };
    } finally {
      accepted = true; // 关闭后的迟到回调一律 400
      server.close();
      server.closeAllConnections();
      // 会话快照**保留**（靠 pruneLoginSessions 按 TTL 清理）：完成链往往在首次轮询前
      // 就跑完，删除会让前端轮到 'expired' 而永远看不到 ok/failed 的终态
    }
  })();

  return { loginId, authorizeUrl: authorizeUrl.toString() };
}

/** 轮询一次登录会话状态 */
export function pollChatgptLogin(loginId: string): ChatgptLoginSnapshot {
  const s = loginSessions.get(loginId);
  if (!s) {
    // 已完成/超时清理：按过期处理（前端引导重新发起）
    return { loginId, status: 'expired', message: '登录会话已结束，请重新发起' };
  }
  return { ...s.snapshot };
}

// ---------- 刷新（轮换）与撤销 ----------

export type ChatgptCredentialRefresher = (stale: ChatgptCredential) => Promise<ChatgptCredential>;

let credentialRefresher: ChatgptCredentialRefresher | null = null;
let refreshChain: Promise<unknown> = Promise.resolve();

/** 接线刷新器（由 config.ts 在 aiConfigFromDb 里用 db+cfg 闭包完成，幂等） */
export function setChatgptCredentialRefresher(fn: ChatgptCredentialRefresher): void {
  credentialRefresher = fn;
}

/**
 * 取得可用的 access token：未到期原样返回；临期/强制则刷新。
 * 刷新全局串行化（refresh_token 轮换语义下并发刷新会互相作废——后到者会在
 * refresher 里先查 DB 最新凭据，发现已被轮换就直接复用，不会重复消费）。
 */
export async function ensureFreshChatgptCredential(
  cred: ChatgptCredential,
  opts: { force?: boolean } = {},
): Promise<ChatgptCredential> {
  if (!opts.force && Date.now() < cred.expiresAt - REFRESH_MARGIN_MS) return cred;
  if (!credentialRefresher) throw new Error('ChatGPT 凭据刷新器未就绪，请重启工作台后重试');
  const run = refreshChain.then(
    () => credentialRefresher!(cred),
    () => credentialRefresher!(cred),
  );
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 刷新凭据（网络 + 官方契约）；terminal 失败抛 ChatgptAuthError（terminal=true） */
export async function refreshChatgptCredential(cred: ChatgptCredential): Promise<ChatgptCredential> {
  const { cred: fields, idToken } = await requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cred.clientId,
      refresh_token: cred.refreshToken,
      resource: resource(),
    }),
  );
  // 刷新响应同样带 id_token（同一身份）：无 nonce 绑定，验签名/iss/aud/exp
  await verifyIdToken(idToken, { audience: cred.clientId });
  return { ...cred, ...fields };
}

/** 撤销会话（登出）：best-effort，失败不阻断本地清理 */
export async function revokeChatgptCredential(cred: ChatgptCredential): Promise<void> {
  const metadata = await fetchDiscovery();
  await authFetch()(metadata.revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: cred.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: cred.clientId,
    }),
  });
}

// ---------- 套餐模型目录 ----------

/** GET /v1/models（Bearer）：ChatGPT 套餐可用模型（visibility==='list' 的 slug） */
export async function listChatgptPlanModels(accessToken: string, signal?: AbortSignal): Promise<string[]> {
  const res = await authFetch()(`${resource()}/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`获取 ChatGPT 套餐模型失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { models?: Array<{ slug?: string; visibility?: string }> };
  const out: string[] = [];
  for (const m of data.models ?? []) {
    if (m.visibility && m.visibility !== 'list') continue;
    if (typeof m.slug === 'string' && m.slug && !out.includes(m.slug)) out.push(m.slug);
  }
  return out;
}

// ---------- 测试辅助（RSA keypair 用于 fake JWKS） ----------

export interface TestSigningKey {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  publicJwk: Record<string, unknown>;
}

/** 仅测试使用：生成一对 RS256 密钥（fake 授权服务器签发 id_token 用） */
export function generateTestSigningKey(): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { privateKey, publicJwk: { ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' } };
}

/** 仅测试使用：用私钥签一个 RS256 JWT（header/payload 由调用方给） */
export function signTestJwt(
  privateKey: TestSigningKey['privateKey'],
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const enc = (o: Record<string, unknown>): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = cryptoSign('sha256', Buffer.from(data), privateKey);
  return `${data}.${sig.toString('base64url')}`;
}

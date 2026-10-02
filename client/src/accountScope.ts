/**
 * 账号作用域（多账号统计视角）：统计族接口的 `platform` + `account` 入参拼装、
 * localStorage 持久化与脏值归一（纯逻辑，无 React/DOM，供单测直接覆盖）。
 *
 * 为什么必须成对：handle 只在平台内唯一（platform_accounts 的键是
 * user_id + platform + handle），只带 account 会把洛谷/牛客撞车的数字 uid 合并，
 * 服务端对这种入参直接 400，所以这里也不允许产生它。
 */
import { useCallback, useEffect, useState } from 'react';
import type { PlatformId } from '../../shared/src/index.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

export interface AccountScope {
  platform?: PlatformId;
  account?: string;
}

/** GET /api/stats/accounts 的回参（库内有提交记录的账号） */
export interface AccountRow {
  platform: PlatformId;
  account: string;
  attempts: number;
  ac: number;
  solved: number;
  lastSubmittedAt: string;
}

const STORAGE_KEY = 'icpc-account-scope-v1';

const VALID_PLATFORMS = new Set<string>(PLATFORMS.map((p) => p.id));

/**
 * 把任意输入（localStorage 脏值 / 接口回参）归一为合法作用域。
 * account 缺 platform 时整体回退「全部账号」——半截作用域比没有作用域更危险。
 */
export function normalizeScope(raw: unknown): AccountScope {
  if (!raw || typeof raw !== 'object') return {};
  const { platform, account } = raw as { platform?: unknown; account?: unknown };
  if (typeof platform !== 'string' || !VALID_PLATFORMS.has(platform)) return {};
  if (typeof account !== 'string' || account === '') return {};
  return { platform: platform as PlatformId, account };
}

/** 空作用域（全部账号） */
export const ALL_ACCOUNTS: AccountScope = {};

export function isAllAccounts(scope: AccountScope): boolean {
  return !scope.platform || !scope.account;
}

/** 给请求 URL 追加作用域参数；全部账号时原样返回 */
export function withScope(url: string, scope: AccountScope): string {
  if (isAllAccounts(scope)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}platform=${encodeURIComponent(scope.platform!)}&account=${encodeURIComponent(scope.account!)}`;
}

/**
 * 切换器是否值得占位置：只有 1 个账号时，「全部账号」与该账号的差别只剩手动导入行，
 * 切了没可比对象；0 个账号（还没同步过）更不必显示。
 */
export function pickerVisible(rows: Array<{ platform: string; account: string }>): boolean {
  return rows.length >= 2;
}

export function readScope(): AccountScope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ALL_ACCOUNTS;
    return normalizeScope(JSON.parse(raw));
  } catch {
    // 隐私模式或无 localStorage
    return ALL_ACCOUNTS;
  }
}

export function writeScope(scope: AccountScope): void {
  try {
    if (isAllAccounts(scope)) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
  } catch {
    // 写不进去只影响下次进来的默认值，不打扰用户
  }
}

/** 页面级账号视角：初值取 localStorage，变更即持久化，切页/刷新保持 */
export function useAccountScope(): [AccountScope, (scope: AccountScope) => void] {
  const [scope, setScope] = useState<AccountScope>(() => readScope());
  // 多标签页：另一页改了视角，本页跟着重新拉数（否则两页显示不同口径却看不出原因）
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setScope(e.newValue ? normalizeScope(JSON.parse(e.newValue)) : ALL_ACCOUNTS);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // useCallback：切换器把它放在 effect 依赖里，身份每帧变就会每帧重跑
  const update = useCallback((next: AccountScope) => {
    setScope(next);
    writeScope(next);
  }, []);
  return [scope, update];
}

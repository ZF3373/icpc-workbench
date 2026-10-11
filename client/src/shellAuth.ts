/**
 * 桌面壳凭据桥（桌面壳 ⇄ 核心）：设置页侧的封装。
 *
 * 桌面壳用内嵌 WebView 让用户像在普通浏览器里一样输账号密码登录 Cookie 类平台
 * （QOJ/洛谷/代码源/LeetCode/计蒜客/AtCoder），登录完成后 Cookie 自动推回设置；
 * QOJ 额外由壳每 20 分钟静默续签 cf_clearance（约 30 分钟过期）。
 * 前端不直接与壳通信（远程页面的 Tauri IPC 被 ACL 拒绝，见壳 src/shell_auth.rs 头注），
 * 全部经由核心的 /api/settings/shell-auth/* 中转：
 *
 *   1. GET  /status        → shell 是否在线（在线才显示一键按钮）+ 最近一条状态
 *   2. POST /request       → 请求动作（login + platform [+ handle] / pull），返回 id
 *   3. GET  /status 轮询   → 按 id 匹配壳回报的结果
 */

import { get, post } from './api'

export type ShellAuthKind = 'heartbeat' | 'login' | 'pull' | 'keepalive'

/** 壳回报的一条状态（与 server/src/routes/shellAuth.ts 的 ShellAuthStatus 同构） */
export interface ShellAuthStatus {
  kind: ShellAuthKind
  /** 前端动作关联 id（login/pull 有；heartbeat/keepalive 无） */
  id?: number
  ok: boolean
  pushed?: boolean
  message?: string
  /** 壳发送时刻（Unix 秒） */
  at: number
}

export interface ShellAuthStatusView {
  /** 桌面壳是否在线（60s 心跳、3 分钟内有效）；false = 网页版，降级为手动粘贴引导 */
  shell: boolean
  last?: ShellAuthStatus | null
}

export function fetchShellAuthStatus(): Promise<ShellAuthStatusView> {
  return get<ShellAuthStatusView>('/api/settings/shell-auth/status')
}

/**
 * 请求壳执行动作，返回关联 id（壳 3s 内轮询取走；壳离线时无人消费，靠轮询超时兜底）。
 * - login：platform 必填；带 handle = 结果只写该账号的凭据槽位（多账号定向抓取）
 * - pull：仅 QOJ（唯一短时效凭据平台）
 */
export function requestShellAuth(action: 'login' | 'pull', platform: string, handle?: string): Promise<number> {
  return post<{ ok: boolean; id: number }>('/api/settings/shell-auth/request', {
    action,
    platform,
    ...(handle ? { handle } : {}),
  }).then((r) => r.id)
}

/**
 * 按 id 轮询壳的执行结果，直到匹配 / 超时 / 壳离线。
 * 返回 null = 超时未得到结果；壳中途离线也按 null 处理（message 提示检查桌面壳）。
 */
export async function waitShellAuthResult(id: number, timeoutMs: number): Promise<ShellAuthStatus | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const view = await fetchShellAuthStatus()
      if (!view.shell) return null // 壳离线：不会再有结果
      if (view.last && view.last.id === id && view.last.kind !== 'heartbeat') return view.last
    } catch {
      /* 核心瞬时不可达（重启/备份中）：继续轮询直到超时 */
    }
  }
  return null
}

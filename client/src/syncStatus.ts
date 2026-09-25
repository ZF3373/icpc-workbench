/**
 * 同步结果文案（纯函数）：数据概览「同步状态」卡与「上次同步结果」抽屉共用。
 *
 * 数据来源都是既有接口，本次没有新增后端字段：
 * - `GET /api/sync/status` → 每平台最近一次同步（状态/时间/摘要）+ 健康徽章；
 * - `GET /api/sync/runs?limit=N` → 同步历史（同步中心数据，此前前端完全没用）。
 */
import type { PlatformId, PlatformSyncStatus, SyncRun } from '../../shared/src/index.ts'
import { platformName } from './ui.ts'

/** `GET /api/sync/status` 的平台条目（与 routes/sync.ts 的响应结构一致） */
export interface SyncPlatformStatusView {
  platform: PlatformId
  platformName: string
  /** 兼容字段：第一个启用账号的 handle（多账号平台完整列表见 accounts） */
  handle: string
  enabled: boolean
  lastSyncAt: string | null
  status: PlatformSyncStatus
  latestRun: SyncRun | null
  autoContinue: { platform: PlatformId; handle: string; round: number; maxRounds: number; nextAt: string; running: boolean } | null
  /** 多账号（v0.8）：该平台全部绑定账号；旧版服务端无此字段（undefined） */
  accounts?: Array<{ handle: string; enabled: boolean; lastSyncAt: string | null }>
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 2 天前（无法解析时原样回显，不显示 Invalid Date） */
export function relativeTimeText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '从未'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diff = now - t
  if (diff < 0) return '刚刚'
  const s = Math.floor(diff / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 中间省略的绝对时间（同步历史列用；同一分钟内只显示时分） */
export function absoluteTimeText(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 健康徽章文案（与 server 的 error_code 归类对应） */
export function healthText(status: PlatformSyncStatus | string): string {
  switch (status) {
    case 'healthy':
      return '健康'
    case 'auth_expired':
      return '鉴权失效 / 风控'
    case 'rate_limited':
      return '被限流'
    case 'schema_changed':
      return '页面结构变化'
    case 'manual_required':
      return '需手动导入'
    case 'degraded':
      return '异常'
    default:
      return '从未同步'
  }
}

/** 健康徽章配色（antd Tag color） */
export function healthColor(status: PlatformSyncStatus | string): string {
  switch (status) {
    case 'healthy':
      return 'success'
    case 'never':
      return 'default'
    case 'manual_required':
      return 'warning'
    default:
      return 'error'
  }
}

/** 触发方式文案 */
export function triggeredByText(t: string): string {
  switch (t) {
    case 'manual':
      return '手动'
    case 'all':
      return '一键同步'
    case 'days':
      return '窗口补拉'
    case 'retry':
      return '重试'
    case 'auto':
      return '后台续拉'
    default:
      return t
  }
}

/** 单平台在「上次同步结果」里的一行摘要（不含平台名，供列表行拼接） */
export function platformRunLine(s: SyncPlatformStatusView, now: number = Date.now()): string {
  const run = s.latestRun
  if (!run) return '从未同步'
  const when = relativeTimeText(run.startedAt, now)
  const base = `${when} · ${triggeredByText(run.triggeredBy)}`
  if (run.status === 'failed') {
    return `${base} · 失败：${run.errorMessage ?? healthText(s.status)}`
  }
  const added = run.imported > 0 ? `新增 ${run.imported} 条` : '无新提交'
  const skipped = run.skipped > 0 ? ` · 去重 ${run.skipped}` : ''
  const waited = run.waitedMs > 0 ? ` · 限速等待 ${Math.round(run.waitedMs / 1000)}s` : ''
  return `${base} · ${added}${skipped}${waited}`
}

/**
 * 上一次同步的整体摘要（状态卡标题行；空闲时显示）：
 * 「上次同步：3 分钟前 · 成功 7/8 个平台 · 新增 42 条」
 * 同一批 `sync/all` 的各平台 started_at 略有先后，所以按"最近一次 startedAt"当作这批的时间。
 */
export function lastSyncSummary(
  statuses: readonly SyncPlatformStatusView[],
  now: number = Date.now(),
): string {
  const runs = statuses.map((s) => s.latestRun).filter((r): r is SyncRun => r !== null)
  if (runs.length === 0) return '尚无同步记录：绑定平台账号后点「同步数据」开始'
  const latest = runs.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
  const ok = runs.filter((r) => r.status === 'ok').length
  const failed = runs.length - ok
  const imported = runs.reduce((n, r) => n + r.imported, 0)
  const added = imported > 0 ? ` · 新增 ${imported} 条` : ' · 无新提交'
  const failPart = failed > 0 ? `，失败 ${failed} 个` : ''
  return `上次同步：${relativeTimeText(latest.startedAt, now)} · 成功 ${ok}/${runs.length} 个平台${failPart}${added}`
}

/** 「从未同步 / 未绑定」判定：状态卡据此提示绑账号而不是报错 */
export function hasAnyAccount(statuses: readonly SyncPlatformStatusView[]): boolean {
  return statuses.length > 0
}

/** 平台名（供抽屉/卡片列直接调用，避免各处重复 import） */
export const platformLabel = platformName

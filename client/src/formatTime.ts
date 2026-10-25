/**
 * 时间格式化的全站口径：各页面别再各写一份 toLocaleString / 手拼字符串。
 * 历史教训同 Mastery 的 pct()——"各写一份"曾让同一概念在不同页面拼出不同格式。
 *
 * 同步状态的 relativeTimeText（syncStatus.ts）刻意不迁进来：它带「从未」业务兜底与
 * 测试覆盖，语义与本文件的纯格式化不同。新的展示代码一律用这里的函数。
 */

/** 相对时间：聊天会话列表用（超过一周退化为 M/D，否则一列全是「30 天前」认不出来） */
export function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 完整日期时间（含年）：赛事开始时间、备份时间等。值不可解析时返回 fallback */
export function fmtDateTime(value: string | number | Date, fallback = '—'): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return fallback
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 短日期时间（不含年）：当年内的次要展示。值不可解析时返回 fallback */
export function fmtDateTimeShort(value: string | number | Date, fallback = '—'): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return fallback
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** HH:MM（24 小时制）：排期/轮询类「下一次在几点」的展示。不可解析时原样回显 */
export function fmtClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

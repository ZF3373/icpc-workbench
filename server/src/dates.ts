/**
 * 「日」口径的唯一入口：进程本地时区的 YYYY-MM-DD。
 *
 * 背景：计划/打卡/复习的日期字段与客户端月视图（dayjs 本地日）都以**本地日**为界，
 * 此前服务端多处用 `new Date().toISOString().slice(0, 10)`（UTC 日界）取「今天」——
 * UTC+8 的本地 00:00–07:59 之间会拿到"昨天"：连续打卡少算一天、复习「今日到期」错位、
 * 凌晨生成的计划起始日是昨天。桌面应用服务端与用户同机同区，直接用本地时区即可。
 */

/** 任意时刻 → 本地时区的 YYYY-MM-DD */
export function localDayOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 现在 → 本地时区的 YYYY-MM-DD（替代 toISOString().slice(0, 10) 取「今天」的全部用法） */
export function localToday(): string {
  return localDayOf(new Date());
}

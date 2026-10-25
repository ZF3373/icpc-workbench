/**
 * localStorage 读写统一入口：JSON 序列化 + 隐私模式/配额异常静默降级。
 *
 * 约定：
 * - readJson 返回 null = 无记录或存储不可用，调用方自行决定默认值。
 *   需要「无记录」与「空数组」语义有别的地方（如数据概览的同步勾选）别把 null 折叠成默认。
 * - 布尔小旗（'1'/'0'）用 readFlag/writeFlag，与 JSON 存布尔二选一即可，别混用两种格式。
 * - 读到后的结构校验/归一化仍由调用方负责——这里的 T 只是「存的时候是什么类型」的约定。
 */

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式 / 配额超限：忽略，偏好仅本次会话生效
  }
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // 忽略，仅本次会话生效
  }
}

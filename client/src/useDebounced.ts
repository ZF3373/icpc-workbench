import { useEffect, useState } from 'react'

/**
 * 防抖值：输入框搜索类场景不要每敲一个字符就打一次服务端 / 重算一遍。
 * 返回值在 value 停止变化 delay 毫秒后才跟上。
 */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

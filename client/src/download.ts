import { message } from 'antd'

/**
 * 统一的「导出文件」入口：fetch 文本 → 弹原生保存对话框让用户选位置。
 *
 * 优先用 File System Access API（showSaveFilePicker）：Chromium / WebView2 支持，
 * 会弹出系统「另存为」对话框，可自由选择保存位置与文件名；
 * 不支持的浏览器（Firefox / Safari）降级为浏览器默认下载到下载目录。
 *
 * 桌面端（Tauri + WebView2）同样走 showSaveFilePicker —— 既有原生保存对话框，
 * 又免去安装 Tauri dialog 插件 + 远程页面 ACL 配置的复杂度。
 */

// 局部类型，避免依赖 lib.dom 是否包含 File System Access API
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
}
interface WritableStream {
  write: (data: string) => Promise<void>
  close: () => Promise<void>
}
interface FileHandle {
  createWritable: () => Promise<WritableStream>
}
type ShowSaveFilePicker = (opts: SaveFilePickerOptions) => Promise<FileHandle>

function getPicker(): ShowSaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
}

/** 优先走原生保存对话框；返回 false 表示当前环境不支持，需降级 */
async function saveViaPicker(filename: string, text: string, mime: string): Promise<boolean> {
  const picker = getPicker()
  if (!picker) return false
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  const handle = await picker({
    suggestedName: filename,
    types: ext ? [{ description: '文档', accept: { [mime.split(';')[0]]: [ext] } }] : undefined,
  })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  return true
}

/** 降级路径：Blob + 触发浏览器默认下载 */
function saveViaBlob(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export interface SaveUrlOptions {
  /** 下载内容来源 URL（同源 fetch） */
  url: string
  /** 建议文件名（含扩展名） */
  filename: string
  /** MIME 类型，默认 text/markdown */
  mime?: string
  /** 成功提示文案；传 false 则不提示 */
  successText?: string | false
}

/** 从 URL 取文本并以「可选位置」方式保存 */
export async function saveUrlAsFile({
  url,
  filename,
  mime = 'text/markdown;charset=utf-8',
  successText = '已导出',
}: SaveUrlOptions): Promise<void> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`导出失败（${res.status}）`)
    const text = await res.text()
    try {
      const saved = await saveViaPicker(filename, text, mime)
      if (!saved) saveViaBlob(filename, text, mime)
    } catch (e) {
      // 用户在保存对话框点「取消」→ AbortError，静默提示并退出，不当作错误
      if ((e as Error)?.name === 'AbortError') {
        message.info('已取消导出')
        return
      }
      throw e
    }
    if (successText !== false) message.success(successText)
  } catch (e) {
    message.error((e as Error).message)
  }
}

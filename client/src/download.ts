// 局部类型，避免依赖 lib.dom 是否包含 File System Access API
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
}
interface WritableStream {
  write: (data: string | Blob) => Promise<void>
  close: () => Promise<void>
}
interface FileHandle {
  createWritable: () => Promise<WritableStream>
}
type ShowSaveFilePicker = (opts: SaveFilePickerOptions) => Promise<FileHandle>

/** antd message 实例的最小接口，由调用方（组件内 App.useApp().message）注入 */
interface MessageLike {
  info: (text: string) => void
  success: (text: string) => void
  error: (text: string) => void
}

function getPicker(): ShowSaveFilePicker | undefined {
  return (window as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
}

/** 优先走原生保存对话框；返回 false 表示当前环境不支持，需降级 */
async function saveViaPicker(
  filename: string,
  data: string | Blob,
  mime: string,
): Promise<boolean> {
  const picker = getPicker()
  if (!picker) return false
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  const handle = await picker({
    suggestedName: filename,
    types: ext ? [{ description: '文档', accept: { [mime.split(';')[0]]: [ext] } }] : undefined,
  })
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
  return true
}

/** 降级路径：Blob + 触发浏览器默认下载 */
function saveViaBlob(filename: string, data: string | Blob, mime: string): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime })
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
  /** antd message 实例（由组件内 App.useApp().message 注入）；不传则无提示 */
  message?: MessageLike
  /** true 时按二进制读取并保存（PDF 等），默认按文本读取 */
  binary?: boolean
}

/** 从 URL 取文本并以「可选位置」方式保存 */
export async function saveUrlAsFile({
  url,
  filename,
  mime = 'text/markdown;charset=utf-8',
  successText = '已导出',
  message,
  binary = false,
}: SaveUrlOptions): Promise<void> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`导出失败（${res.status}）`)
    const data: string | Blob = binary ? await res.blob() : await res.text()
    try {
      const saved = await saveViaPicker(filename, data, mime)
      if (!saved) saveViaBlob(filename, data, mime)
    } catch (e) {
      // 用户在保存对话框点「取消」→ AbortError，静默提示并退出，不当作错误
      if ((e as Error)?.name === 'AbortError') {
        message?.info('已取消导出')
        return
      }
      // WebView2 / 内嵌 iframe 等平台 showSaveFilePicker 存在但 createWritable 被拒
      // （NotSupportedError）→ 不报错，降级为 Blob 下载
      saveViaBlob(filename, data, mime)
    }
    if (successText !== false) message?.success(successText)
  } catch (e) {
    message?.error((e as Error).message)
  }
}

/** 将前端生成的纯文本以「可选位置」方式保存 */
export async function saveTextAsFile({
  filename,
  content,
  mime = 'text/plain;charset=utf-8',
  successText = '已导出',
  message,
}: {
  filename: string
  content: string
  mime?: string
  successText?: string | false
  message?: MessageLike
}): Promise<void> {
  try {
    try {
      const saved = await saveViaPicker(filename, content, mime)
      if (!saved) saveViaBlob(filename, content, mime)
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        message?.info('已取消导出')
        return
      }
      saveViaBlob(filename, content, mime)
    }
    if (successText !== false) message?.success(successText)
  } catch (e) {
    message?.error((e as Error).message)
  }
}

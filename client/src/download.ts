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

/** antd message 实例的最小接口，由调用方（组件内 App.useApp().message）注入 */
interface MessageLike {
  info: (text: string) => void
  success: (text: string) => void
  error: (text: string) => void
}

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
  /** antd message 实例（由组件内 App.useApp().message 注入）；不传则无提示 */
  message?: MessageLike
}

/** 从 URL 取文本并以「可选位置」方式保存 */
export async function saveUrlAsFile({
  url,
  filename,
  mime = 'text/markdown;charset=utf-8',
  successText = '已导出',
  message,
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
        message?.info('已取消导出')
        return
      }
      throw e
    }
    if (successText !== false) message?.success(successText)
  } catch (e) {
    message?.error((e as Error).message)
  }
}

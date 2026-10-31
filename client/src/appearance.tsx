import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { get, patch, del } from './api'

import { AppearanceContext as Context, type BackgroundSettings } from './appearanceCore'

const DEFAULT: BackgroundSettings = { file: null, kind: null, name: '', opacity: .6, available: false }
const assetUrl = (file: string) => `/api/appearance/assets/${encodeURIComponent(file)}`

/**
 * 图片平均亮度（0–1），用于决定压在背景上的文字用浅色还是深色。
 *
 * 为什么在浏览器端量而不是服务端：服务端要自己解 PNG/JPEG —— 而 JPEG 必须完整走
 * Huffman + 反量化才能拿到真实像素（只解 DC 不做 AC 跳过会直接错位，实测首块读出
 * -1021 这种不可能的值）。浏览器本来就要解码这张图来显示，用 canvas 缩到 1×1
 * 取像素等于零成本且绝对准确；视频/取不到像素时返回 null，走中性叠加层。
 */
function measureLuminance(url: string): Promise<number | null> {
  return new Promise(resolve => {
    const node = new Image()
    let settled = false
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 15000)
    node.addEventListener('load', () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 1; canvas.height = 1
        const context = canvas.getContext('2d')
        if (!context) return finish(null)
        context.drawImage(node, 0, 0, 1, 1)
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data
        const channel = (v: number) => {
          const c = v / 255
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
        }
        finish(0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b))
      } catch {
        // 跨域/画布污染等：退回中性叠加层，不阻塞背景显示
        finish(null)
      }
    }, { once: true })
    node.addEventListener('error', () => finish(null), { once: true })
    node.src = url
  })
}

function validateMedia(url: string, kind: 'image' | 'video'): Promise<void> {
  return new Promise((resolve, reject) => {
    const node = document.createElement(kind === 'video' ? 'video' : 'img')
    let settled = false
    const event = kind === 'video' ? 'loadeddata' : 'load'
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer); node.removeAttribute('src'); if (node instanceof HTMLVideoElement) node.load()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('背景文件读取超时，请换一个文件')), 20000)
    node.addEventListener(event, () => finish(), { once: true })
    node.addEventListener('error', () => finish(new Error(kind === 'video' ? '无法解码此视频，请使用 H.264 MP4 或 WebM 视频' : '无法读取此图片，请选择有效图片')), { once: true })
    if (node instanceof HTMLVideoElement) { node.muted = true; node.preload = 'auto' }
    node.src = url
  })
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULT)
  const [opacity, setOpacity] = useState(.6)
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState('')
  const [failed, setFailed] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  const revision = useRef(0)
  const busyRef = useRef(true)
  const active = settings.available && !failed && opacity > 0
  useEffect(() => {
    let disposed = false
    get<BackgroundSettings>('/api/appearance').then(value => {
      if (disposed) return
      setSettings(value); setOpacity(value.opacity)
      if (value.file && !value.available) setStatus('保存的背景文件已丢失，请重新导入或恢复默认。')
    }).catch(error => { if (!disposed) setStatus(`背景未加载：${error.message}`) })
      .finally(() => { if (!disposed) { setBusy(false); busyRef.current = false } })
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    const root = document.documentElement
    root.dataset.background = active ? 'active' : 'none'
    root.style.setProperty('--background-opacity', String(opacity))
    root.style.setProperty('--background-surface-opacity', `${100 - opacity * 58}%`)
    root.style.setProperty('--background-control-opacity', `${100 - opacity * 30}%`)
  }, [active, opacity])
  /**
   * 背景图亮度 → 压在图上那层文字用浅色还是深色。
   *
   * 原实现无条件写死 `color: #ecedef`（亮色主题下），压在亮图上实测只有 1.07:1，
   * 几乎不可读；暗色主题压在白图上同理。这里按图片实际亮度选择：
   * - 亮图（≥0.55）→ 深色文字 + 白色描边，暗图 → 浅色文字 + 黑色描边
   * - 视频 / 量不出亮度 → 保持中性：同时给出上下两层描边，两种底色都还能读
   */
  useEffect(() => {
    const root = document.documentElement
    if (!active || settings.kind !== 'image' || !settings.file) {
      delete root.dataset.backgroundTone
      return
    }
    let disposed = false
    measureLuminance(assetUrl(settings.file)).then(value => {
      if (disposed) return
      if (value === null) delete root.dataset.backgroundTone
      else root.dataset.backgroundTone = value >= 0.55 ? 'light' : 'dark'
    })
    return () => { disposed = true }
  }, [active, settings.kind, settings.file])
  useEffect(() => {
    if (settings.kind !== 'video') return
    let disposed = false
    const sync = async () => {
      let visible = !document.hidden && active
      const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<boolean> } } }).__TAURI__
      if (visible && tauri?.core?.invoke) {
        try { visible = await tauri.core.invoke('background_visible') } catch { /* browser fallback */ }
      }
      if (disposed) return
      const node = video.current
      if (!node) return
      if (!visible) node.pause()
      else void node.play().catch(() => { if (!disposed) setStatus('视频暂时无法播放，请换用 H.264 MP4 或 WebM。') })
    }
    const interval = setInterval(() => void sync(), 750)
    const currentVideo = video.current
    document.addEventListener('visibilitychange', sync)
    void sync()
    return () => { disposed = true; clearInterval(interval); document.removeEventListener('visibilitychange', sync); currentVideo?.pause() }
  }, [active, settings.kind, settings.file])
  const previewOpacity = (value: number) => { revision.current++; setOpacity(value) }
  const saveOpacity = async (value: number) => {
    const currentRevision = revision.current
    const job = tail.current.then(async () => {
      try {
        const saved = await patch<BackgroundSettings>('/api/appearance', { opacity: value })
        setSettings(saved)
        if (revision.current === currentRevision) setStatus('背景设置已保存。')
      } catch (error) { if (revision.current === currentRevision) { setOpacity(settings.opacity); setStatus(`保存失败：${(error as Error).message}`) } }
    })
    tail.current = job
    await job
  }
  const importFile = async (file: File) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setStatus('正在检查背景文件…')
    let candidate: { file: string; kind: 'image' | 'video'; name: string } | undefined
    try {
      await tail.current
      if (file.size > 1024 ** 3) throw new Error('背景文件不能超过 1 GiB')
      const response = await fetch(`/api/appearance/assets?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
      if (!response.ok) throw new Error((await response.json()).error ?? '导入失败')
      candidate = await response.json()
      if (!candidate) throw new Error('背景导入失败')
      await validateMedia(assetUrl(candidate.file), candidate.kind)
      const saved = await patch<BackgroundSettings>('/api/appearance', { ...candidate, opacity })
      setSettings(saved); setFailed(false); setStatus('背景已保存；可以拖动滑块调整显示强度。')
      candidate = undefined
    } catch (error) {
      if (candidate) await del(`/api/appearance/assets/${candidate.file}`).catch(() => {})
      setStatus(`导入失败：${(error as Error).message}`)
    } finally { busyRef.current = false; setBusy(false) }
  }
  const reset = async () => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      await tail.current
      const saved = await patch<BackgroundSettings>('/api/appearance', { file: null, opacity: .6 })
      setSettings(saved); setOpacity(.6); setFailed(false); setStatus('已恢复默认背景。')
    } catch (error) { setStatus(`恢复失败：${(error as Error).message}`) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const fail = () => { setFailed(true); setStatus('背景文件无法继续显示，已回退到默认背景，请重新导入。') }
  const value = { settings, busy, status, opacity, previewOpacity, saveOpacity, importFile, reset }
  return <Context.Provider value={value}>
    {createPortal(<div className="fantasy-background" aria-hidden="true"><div className="fantasy-background-media">
      {settings.file && settings.available && !failed && (settings.kind === 'video'
        ? <video key={settings.file} ref={video} src={assetUrl(settings.file)} muted loop playsInline disablePictureInPicture preload="auto" onError={fail} />
        : <img key={settings.file} src={assetUrl(settings.file)} alt="" onError={fail} />)}
    </div></div>, document.body)}
    {children}
  </Context.Provider>
}

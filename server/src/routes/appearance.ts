import { Router, static as serveStatic } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
const VIDEOS = ['mp4', 'webm', 'm4v', 'mov'];
const ASSET = new RegExp(`^[a-f0-9-]{36}\\.(?:${[...IMAGES, ...VIDEOS].join('|')})$`, 'i');
const DEFAULT = { file: null as string | null, kind: null as 'image' | 'video' | null, name: '', opacity: .6 };

export function appearanceRoutes(dataDir: string): Router {
  const r = Router();
  const directory = path.join(dataDir, 'backgrounds');
  const settingsPath = path.join(dataDir, 'appearance.json');
  const read = () => {
    let stored: Partial<typeof DEFAULT> = {};
    try { stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* default on first launch */ }
    const settings = { ...DEFAULT, ...stored };
    settings.file = typeof settings.file === 'string' && ASSET.test(settings.file) ? settings.file : null;
    settings.kind = settings.file ? (VIDEOS.includes(path.extname(settings.file).slice(1)) ? 'video' : 'image') : null;
    settings.opacity = Number.isFinite(settings.opacity) ? Math.max(0, Math.min(1, settings.opacity)) : .6;
    return { ...settings, available: !!settings.file && fs.existsSync(path.join(directory, settings.file)) };
  };
  r.get('/', (_req, res) => res.json(read()));
  r.patch('/', (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: '背景设置无效' });
    if ('opacity' in input && (typeof input.opacity !== 'number' || !Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 1)) {
      return res.status(400).json({ error: '背景显示强度须在 0–100% 之间' });
    }
    if ('file' in input && input.file !== null && (typeof input.file !== 'string' || !ASSET.test(input.file) || !fs.existsSync(path.join(directory, input.file)))) {
      return res.status(400).json({ error: '背景文件无效或已丢失，请重新导入' });
    }
    const previous = read();
    const file = 'file' in input ? input.file as string | null : previous.file;
    const next = { file, name: file ? (typeof input.name === 'string' ? path.basename(input.name).slice(0, 240) : previous.name) : '',
      kind: file ? (VIDEOS.includes(path.extname(file).slice(1)) ? 'video' : 'image') : null,
      opacity: input.opacity ?? previous.opacity };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(settingsPath + '.tmp', JSON.stringify(next));
      fs.renameSync(settingsPath + '.tmp', settingsPath);
      res.json(read());
      // Only the replaced application-owned asset is removed, after settings commit.
      if (previous.file && previous.file !== file) fs.rmSync(path.join(directory, previous.file), { force: true });
    } catch (error) { console.error('[appearance]', error); if (!res.headersSent) res.status(500).json({ error: '背景设置保存失败' }); }
  });
  r.post('/assets', async (req, res) => {
    const name = typeof req.query.name === 'string' ? path.basename(req.query.name).slice(0, 240) : '';
    const extension = path.extname(name).slice(1).toLowerCase();
    if (![...IMAGES, ...VIDEOS].includes(extension)) return res.status(415).json({ error: '请选择支持的图片或视频格式' });
    const file = `${randomUUID()}.${extension}`;
    const destination = path.join(directory, file);
    let size = 0;
    try {
      fs.mkdirSync(directory, { recursive: true });
      await pipeline(req, new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length;
        done(size > 1024 ** 3 ? new Error('背景文件不能超过 1 GiB') : null, chunk);
      } }), fs.createWriteStream(destination, { flags: 'wx' }));
      if (!size) throw new Error('背景文件为空');
      res.json({ file, name, kind: VIDEOS.includes(extension) ? 'video' : 'image' });
    } catch (error) {
      fs.rmSync(destination, { force: true });
      if (!res.headersSent && !res.destroyed) res.status(400).json({ error: error instanceof Error ? error.message : '背景导入失败' });
    }
  });
  r.delete('/assets/:file', (req, res) => {
    const file = req.params.file;
    if (!ASSET.test(file)) return res.status(400).json({ error: '背景文件无效' });
    if (read().file === file) return res.status(409).json({ error: '不能删除正在使用的背景' });
    fs.rmSync(path.join(directory, file), { force: true });
    res.json({ ok: true });
  });
  r.use('/assets', (req, res, next) => {
    if (!ASSET.test(req.path.slice(1))) return res.sendStatus(404);
    next();
  }, serveStatic(directory, { immutable: true, maxAge: '30d', fallthrough: false }));
  return r;
}

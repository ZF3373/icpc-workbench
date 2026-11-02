import { Router, raw, static as expressStatic } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 笔记图片上传与静态服务（复习笔记 / 学习笔记等 Markdown 编辑器共用）：
 *
 * - 客户端以图片原始字节流直传（Content-Type 为图片自身类型），沿用 ai.ts 的
 *   「不引入 multer」约定；express.json() 只拦 application/json，不会碰 image/*。
 * - 文件名完全由服务端生成（时间戳 + 随机 hex），绝不使用客户端提供的名字，
 *   从根上排除路径穿越与同名覆盖；扩展名由 Content-Type 白名单映射。
 * - 文件落 <dataDir>/uploads/，与 SQLite 同目录：便携版整目录拷走即带走数据。
 *   GET 由内置 express.static 服务（不存在时 fallthrough 到 POST 路由 404），
 *   返回的 URL（/api/uploads/xxx）即入库的 Markdown 引用，相对路径可过前端
 *   Markdown 渲染的安全协议过滤。
 * - route-parity 测试要求 index.ts 与 sea.ts 注册同一组 /api 前缀：本模块把
 *   静态服务与上传路由封装在同一个 Router 里，两个入口各挂一行即可。
 * - 备份目前只覆盖数据库，uploads 目录（含笔记附件）不在每日备份内 —— 图片属于可再生的
 *   附属资源（截图可重贴），数据库里的 Markdown 引用最多显示为空图，不阻塞主流程。
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** 附件 id 由服务端生成；下载路由只认这个形态，从根上排除路径穿越 */
const ATTACHMENT_ID = /^[a-z0-9]+-[a-f0-9]{12}$/;

/** 文件名只用于展示和下载时的建议名：去掉路径与控制字符，空名兜底 */
export function safeAttachmentName(raw: unknown): string {
  const base = String(raw ?? '').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '附件' : cleaned;
}

/** Content-Type → 扩展名白名单：只收四种网页图片格式，其余一律 415 */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function uploadsRoutes({ uploadsDir }: { uploadsDir: string }): Router {
  const r = Router();

  // 附件内容不可信（可能是 HTML/SVG）：必须先于静态服务匹配，一律按下载返回，绝不在本站同源渲染
  r.get('/files/:id/:name', (req, res) => {
    const { id, name } = req.params;
    if (!ATTACHMENT_ID.test(id)) return res.status(404).json({ error: '附件不存在' });
    const file = path.join(uploadsDir, 'files', id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '附件不存在' });
    res.download(file, safeAttachmentName(name), {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' },
    });
  });
  // POST /api/uploads/files?name=原文件名 → 笔记附件（任意类型，字节流直传）
  r.post(
    '/files',
    (req, res, next) => {
      if (Number(req.headers['content-length'] ?? 0) > MAX_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: '附件超过 50 MiB 上限' });
      }
      next();
    },
    raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
    (req, res) => {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: '附件内容不能为空' });
      }
      const dir = path.join(uploadsDir, 'files');
      fs.mkdirSync(dir, { recursive: true });
      const id = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
      fs.writeFileSync(path.join(dir, id), buf);
      const name = safeAttachmentName(req.query.name);
      res.json({ url: `/api/uploads/files/${id}/${encodeURIComponent(name)}`, name, size: buf.length });
    },
  );

  r.use('/files', (_req, res) => {
    res.status(404).json({ error: '附件不存在' });
  });

  // 静态服务已上传的图片；express.static 对非 GET/HEAD（如上传 POST）自动 fallthrough
  r.use('/', expressStatic(uploadsDir, { maxAge: '30d', immutable: true }));

  r.post(
    '/',
    // content-length 快速拒绝超限（express.raw 的 413 会被全局 errorHandler 变成 500）
    (req, res, next) => {
      const clen = Number(req.headers['content-length'] ?? 0);
      if (clen > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: '图片超过 5 MiB 上限' });
      }
      next();
    },
    raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const ext = EXT_BY_TYPE[type];
      if (!ext) return res.status(415).json({ error: '仅支持 PNG / JPEG / GIF / WebP 图片' });
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: '请求体需为图片字节流（不可为空）' });
      }
      fs.mkdirSync(uploadsDir, { recursive: true });
      const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, name), buf);
      res.json({ url: `/api/uploads/${name}` });
    },
  );

  return r;
}

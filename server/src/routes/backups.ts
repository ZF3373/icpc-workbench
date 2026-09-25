import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { createBackup, deleteBackup, listBackups, requestRestore } from '../backup.ts';

export function backupsRoutes(db: Db): Router {
  const r = Router();

  // GET /api/backups → 恢复点列表（新→旧）
  r.get('/', (_req, res) => {
    res.json({
      backups: listBackups(db).map((b) => ({
        file: b.file,
        reason: b.reason,
        createdAtMs: b.createdAtMs,
        size: b.size,
        knowledge: b.knowledge,
      })),
    });
  });

  // POST /api/backups → 手动创建恢复点
  r.post('/', (req, res) => {
    try {
      const b = createBackup(db, 'manual');
      res.json({ ok: true, file: b.file, size: b.size });
    } catch (e) {
      res.status(500).json({ error: `备份创建失败: ${(e as Error).message}` });
    }
  });

  // POST /api/backups/:name/restore → 请求恢复（写标记，重启应用后生效）
  r.post('/:name/restore', asyncHandler(async (req, res) => {
    try {
      const marker = requestRestore(db, String(req.params.name));
      res.json({ ok: true, needRestart: true, ...marker, message: '已登记恢复请求：重启应用后，数据库将回滚到该恢复点。' });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }));

  // DELETE /api/backups/:name → 删除单个恢复点（连带其知识点伴生快照）。
  // 已登记为待恢复目标的备份会被拒绝（避免重启后的恢复静默落空）。
  r.delete('/:name', (req, res) => {
    try {
      deleteBackup(db, String(req.params.name));
      res.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      res.status(msg.includes('不存在') ? 404 : 400).json({ error: msg });
    }
  });

  return r;
}

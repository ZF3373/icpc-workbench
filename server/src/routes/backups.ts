import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { asyncHandler } from '../asyncHandler.ts';
import {
  backupFilePath,
  createBackup,
  deleteBackup,
  listBackups,
  readPendingRestore,
  requestRestore,
} from '../backup.ts';
import { isDockerRuntime } from '../runtime-env.ts';

export interface BackupsRoutesOptions {
  /** 是否 Docker 环境：决定前端恢复引导文案，以及是否暴露「重启容器」端点 */
  isDocker?: boolean;
  /** 重启端点的延时（毫秒）：给响应留出写回时间后再退出进程（测试注入 0） */
  restartDelayMs?: number;
  /**
   * 进程退出钩子：默认关库 + process.exit(0)（容器 restart 策略会拉起新进程）。
   * 测试注入以断言「确实要求退出」而不真的结束测试进程。
   */
  shutdown?: () => void;
}

export function backupsRoutes(db: Db, opts: BackupsRoutesOptions = {}): Router {
  const r = Router();
  // 默认按运行时探测；双入口（index.ts / sea.ts）都不传 opts，测试可显式覆盖
  const docker = opts.isDocker ?? isDockerRuntime();
  const restartDelayMs = opts.restartDelayMs ?? 300;
  const shutdown =
    opts.shutdown ??
    (() => {
      // 先 close 数据库连接，让 WAL 正常收尾，避免下次启动读到未 checkpoint 的残留。
      // 关闭失败不阻塞退出——容器会强制结束进程。
      try {
        db.close();
      } catch {
        // 连接可能已被关闭
      }
      process.exit(0);
    });

  // GET /api/backups → 恢复点列表（新→旧）+ 待恢复标记 + 部署形态
  r.get('/', (_req, res) => {
    const pending = readPendingRestore(db);
    res.json({
      backups: listBackups(db).map((b) => ({
        file: b.file,
        reason: b.reason,
        createdAtMs: b.createdAtMs,
        size: b.size,
        knowledge: b.knowledge,
      })),
      // 待恢复目标（restore-pending.json 已登记、等待重启生效）；无标记时为 null。
      // 前端据此给对应条目打「重启后恢复」标记，并在改选其他备份时提示会覆盖它。
      pendingRestore: pending,
      // 部署形态：docker=true 时恢复完成后应引导「重启容器」而非「重启应用」
      docker,
      // 「重启容器」端点是否可用（仅在 Docker 环境暴露，桌面版没有这层语义）
      canRestart: docker,
    });
  });

  // POST /api/backups → 手动创建恢复点
  r.post('/', (_req, res) => {
    try {
      const b = createBackup(db, 'manual');
      res.json({ ok: true, file: b.file, size: b.size });
    } catch (e) {
      res.status(500).json({ error: `备份创建失败: ${(e as Error).message}` });
    }
  });

  // GET /api/backups/:name/download → 下载恢复点文件（异地容灾：备份不再只能留在容器卷里）
  // 文件名经 FILE_RE 白名单校验（无路径分隔符，防目录穿越）；res.download 负责
  // Content-Disposition / 流式传输 / 断点下载。
  r.get('/:name/download', (req, res) => {
    const name = String(req.params.name);
    let filePath: string;
    try {
      filePath = backupFilePath(db, name);
    } catch (e) {
      const msg = (e as Error).message;
      return res.status(msg.includes('不存在') ? 404 : 400).json({ error: msg });
    }
    res.download(filePath, name, (err) => {
      // 客户端中途取消下载很常见（err 为 ECONNABORTED/EPIPE），无需打扰日志；
      // 其余错误在响应头已发出时已无法改状态码，交给全局错误中间件会重复响应，
      // 这里只记录。
      if (!err) return;
      if (!res.headersSent) {
        res.status(500).json({ error: `备份下载失败: ${err.message}` });
      } else {
        console.error(`[backup] 下载备份 ${name} 中断: ${err.message}`);
      }
    });
  });

  // POST /api/backups/:name/restore → 请求恢复（写标记，重启应用后生效）
  r.post('/:name/restore', asyncHandler(async (req, res) => {
    try {
      const marker = requestRestore(db, String(req.params.name));
      res.json({
        ok: true,
        needRestart: true,
        ...marker,
        docker,
        canRestart: docker,
        message: '已登记恢复请求：重启应用后，数据库将回滚到该恢复点。',
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  }));

  // POST /api/backups/restart → 让进程退出，由容器 restart 策略（compose 的
  // restart: unless-stopped）重新拉起并在启动时应用待恢复标记。
  // 仅在 Docker 环境暴露：桌面版退出进程 = 用户的应用直接消失，没有自动拉起语义。
  r.post('/restart', (req, res) => {
    if (!docker) {
      return res.status(403).json({ error: '重启端点仅在 Docker 环境可用；桌面版请手动重启应用' });
    }
    const pending = readPendingRestore(db);
    if (!pending) {
      return res.status(400).json({ error: '没有待恢复的备份，无需重启' });
    }
    res.json({ ok: true, restarting: true, file: pending.file });
    // 响应写完后退出：容器 restart 策略拉起新进程，createDb 之前由 applyPendingRestore 完成回滚。
    res.on('finish', () => {
      setTimeout(() => {
        console.log(`[backup] 收到重启请求：进程退出以应用恢复点 ${pending.file}`);
        shutdown();
      }, restartDelayMs);
    });
  });

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

import fs from 'node:fs';
import path from 'node:path';
import type { WebDavSyncConflict, WebDavSyncStatus } from '../../../shared/src/webdavSync.ts';
import { createBackup, readPendingRestore } from '../backup.ts';
import type { Db } from '../db/index.ts';
import {
  applySnapshot, captureSnapshot, digest, finishPendingAnnotations, manifestBlocks, parseManifest,
  readSyncSetting, writeAtomic, writeSyncSetting,
} from './snapshot.ts';
import { DataSyncError, normalizeWebDavUrl, WebDav, type WebDavCredentials } from './webdav.ts';

type Config = WebDavCredentials & { enabled: boolean; intervalMinutes: number };
type Result = Pick<WebDavSyncStatus, 'state' | 'message' | 'transferredBlocks' | 'conflict'>;
export type Resolution = WebDavSyncConflict & { keep: 'local' | 'remote' };
const DEFAULT_CONFIG: Config = { url: '', username: '', password: '', enabled: false, intervalMinutes: 5 };
const BASE_KEY = 'webdavSync.base';
const INITIAL_RESULT: Result = { state: 'idle', message: '', transferredBlocks: 0, conflict: null };

export function syncErrorMessage(error: unknown): string {
  if (error instanceof DataSyncError) return error.message;
  console.error('[webdav-sync]', error);
  return 'WebDAV 同步失败，请检查本地数据目录和服务端日志';
}

async function transfer<T>(entries: T[], run: (entry: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < entries.length; start += 6) {
    const results = await Promise.allSettled(entries.slice(start, start + 6).map(run));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

export class WebDavSync {
  private readonly configFile: string;
  private config = DEFAULT_CONFIG;
  private result = INITIAL_RESULT;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(private readonly db: Db, private readonly dataDir: string) {
    this.configFile = path.join(dataDir, 'webdav-sync.json');
    try {
      this.config = this.parseConfig(JSON.parse(fs.readFileSync(this.configFile, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.result = { ...INITIAL_RESULT, state: 'error', message: '无法加载 WebDAV 同步配置，请重新保存设置' };
      }
    }
  }

  private parseConfig(input: unknown): Config {
    const { url, username, password, enabled, intervalMinutes } = (input ?? {}) as Partial<Config>;
    if (typeof url !== 'string' || url.length > 4096 || typeof username !== 'string' || username.length > 512 || username.includes(':') ||
      (password !== undefined && (typeof password !== 'string' || password.length > 2048))) {
      throw new DataSyncError('请输入有效的 WebDAV 地址、账号和密码');
    }
    if (typeof enabled !== 'boolean' || typeof intervalMinutes !== 'number' || !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      throw new DataSyncError('同步间隔须为 1 至 1440 分钟的整数');
    }
    const normalized = url.trim() ? normalizeWebDavUrl(url) : '';
    if (enabled && !normalized) throw new DataSyncError('启用自动同步前请填写 WebDAV 目录地址');
    const sameAccount = normalized === this.config.url && username === this.config.username;
    return {
      url: normalized, username, enabled, intervalMinutes,
      password: password ?? (sameAccount ? this.config.password : ''),
    };
  }

  private connectionKey() {
    return digest(JSON.stringify([this.config.url, this.config.username]));
  }

  private getBase(): { id: string; at: string } | undefined {
    const raw = readSyncSetting(this.db, BASE_KEY);
    if (!raw) return undefined;
    const base = JSON.parse(raw) as { endpoint: string; id: string; at: string };
    return base.endpoint === this.connectionKey() ? base : undefined;
  }

  status(): WebDavSyncStatus {
    const { url, username, enabled, intervalMinutes, password } = this.config;
    return {
      settings: { url, username, enabled, intervalMinutes, hasPassword: Boolean(password) },
      lastSuccessAt: this.getBase()?.at ?? null,
      ...this.result,
    };
  }

  configure(input: unknown): WebDavSyncStatus {
    if (this.running) throw new DataSyncError('同步正在运行，请稍后保存设置');
    const config = this.parseConfig(input);
    writeAtomic(this.configFile, JSON.stringify(config));
    this.config = config;
    this.result = INITIAL_RESULT;
    this.schedule(0);
    return this.status();
  }

  async testConnection(input: unknown): Promise<void> {
    const config = this.parseConfig(input);
    if (!config.url) throw new DataSyncError('请先填写 WebDAV 目录地址');
    await new WebDav(config).testConnection();
  }

  start(): void {
    this.schedule(0);
  }

  resetBaseline(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(BASE_KEY);
  }

  recoverAnnotations(): boolean {
    try {
      finishPendingAnnotations(this.db, this.dataDir);
      return true;
    } catch (error) {
      this.result = { ...INITIAL_RESULT, state: 'error', message: syncErrorMessage(error) };
      return false;
    }
  }

  private schedule(delay = this.config.intervalMinutes * 60_000): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.config.enabled) {
      this.timer = setTimeout(() => void this.run(), delay);
      this.timer.unref();
    }
  }

  async run(resolution?: Resolution): Promise<WebDavSyncStatus> {
    if (this.running) return this.status();
    clearTimeout(this.timer);
    this.running = true;
    this.result = { ...INITIAL_RESULT, state: 'syncing' };
    try {
      this.result = await this.synchronize(resolution);
    } catch (error) {
      this.result = { ...INITIAL_RESULT, state: 'error', message: syncErrorMessage(error) };
    } finally {
      this.running = false;
      this.schedule();
    }
    return this.status();
  }

  private async synchronize(resolution?: Resolution): Promise<Result> {
    if (!this.config.url) throw new DataSyncError('请先保存 WebDAV 目录地址');
    if (readPendingRestore(this.db)) throw new DataSyncError('有等待重启的备份恢复，恢复完成后可继续同步');
    finishPendingAnnotations(this.db, this.dataDir);
    const dav = new WebDav(this.config);
    const remoteFile = await dav.getManifest();
    const local = captureSnapshot(this.db, this.dataDir);
    const remote = remoteFile && parseManifest(remoteFile.body, local.manifest);
    const localJson = JSON.stringify(local.manifest);
    const localId = digest(localJson);
    const remoteId = remote && digest(JSON.stringify(remote));
    const base = this.getBase()?.id;
    const saveBase = (id: string) => writeSyncSetting(this.db, BASE_KEY, JSON.stringify({
      endpoint: this.connectionKey(), id, at: new Date().toISOString(),
    }));
    if (localId === remoteId) {
      saveBase(localId);
      return { ...INITIAL_RESULT, state: 'unchanged', message: '两端数据已一致' };
    }

    const conflict = { local: localId, remote: remoteId };
    if (resolution && (resolution.local !== localId || resolution.remote !== remoteId)) {
      return { ...INITIAL_RESULT, state: 'conflict', message: '同步数据已有变化，请确认后重新选择', conflict };
    }
    if (resolution?.keep === 'local' || (!resolution && ((!remote && !base) || (remoteId !== null && remoteId === base)))) {
      if (!remote) await dav.createDirectory();
      const existing = remote ? manifestBlocks(remote) : new Map();
      const uploads = [...local.blocks].filter(([hash]) => !existing.has(hash));
      await transfer(uploads, ([hash, data]) => dav.putBlock(hash, data));
      await dav.putManifest(Buffer.from(localJson), remoteFile?.etag);
      saveBase(localId);
      return { ...INITIAL_RESULT, state: 'uploaded', message: '已将本地变更同步到 WebDAV', transferredBlocks: uploads.length };
    }

    if (remote && remoteId && (resolution?.keep === 'remote' || (!resolution && localId === base))) {
      const downloads = [...manifestBlocks(remote)].filter(([hash]) => !local.blocks.has(hash));
      await transfer(downloads, async ([hash, bytes]) => {
        const body = await dav.getBlock(hash, bytes);
        if (body.length !== bytes || digest(body) !== hash) throw new DataSyncError('WebDAV 数据块校验失败，已保留本地数据');
        local.blocks.set(hash, body);
      });
      if ((await dav.getManifest())?.etag !== remoteFile.etag) throw new DataSyncError('远端在同步期间已更新，请重新同步');
      if (readPendingRestore(this.db)) throw new DataSyncError('有等待重启的备份恢复，恢复完成后可继续同步');
      const current = captureSnapshot(this.db, this.dataDir);
      const currentId = digest(JSON.stringify(current.manifest));
      if (currentId !== localId) {
        return {
          ...INITIAL_RESULT, state: 'conflict', message: '下载期间本地数据已变化，请选择要保留的版本',
          conflict: { local: currentId, remote: remoteId },
        };
      }
      createBackup(this.db, 'pre-webdav-sync', undefined, this.dataDir);
      applySnapshot(this.db, this.dataDir, local.manifest, remote, local.blocks, () => saveBase(remoteId));
      return { ...INITIAL_RESULT, state: 'downloaded', message: '已将 WebDAV 变更同步到本地', transferredBlocks: downloads.length };
    }

    return {
      ...INITIAL_RESULT, state: 'conflict', conflict,
      message: !remote ? '找不到此前同步的远端数据，请检查目录或选择用本地数据重新建立' :
        base ? '本地与远端都有改动，请选择要保留的版本' : '此目录已有数据，请选择首次同步要保留的版本',
    };
  }
}

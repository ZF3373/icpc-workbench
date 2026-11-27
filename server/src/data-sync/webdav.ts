export interface WebDavCredentials {
  url: string;
  username: string;
  password: string;
}

export class DataSyncError extends Error {}

export const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export function normalizeWebDavUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DataSyncError('请输入有效的 WebDAV 目录地址');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DataSyncError('WebDAV 地址须为 HTTP 或 HTTPS 目录，账号和密码请单独填写');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return url.href;
}

async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new DataSyncError('WebDAV 文件超出同步大小限制');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof DataSyncError) throw error;
    throw new DataSyncError('读取 WebDAV 数据失败，请检查网络连接');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

function check(response: Response, operation: string): never {
  discard(response);
  if (response.status === 401 || response.status === 403) {
    throw new DataSyncError(`WebDAV ${operation}失败（HTTP ${response.status}），请检查账号、应用密码和目录权限`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new DataSyncError('WebDAV 地址发生重定向，请填写最终的目录地址');
  }
  throw new DataSyncError(`WebDAV ${operation}失败（HTTP ${response.status}）`);
}

export class WebDav {
  private readonly base: URL;
  private readonly directory: URL;
  private readonly authorization: string | undefined;

  constructor(credentials: WebDavCredentials) {
    this.base = new URL(credentials.url);
    this.directory = new URL('icpc-workbench-sync-v1/', this.base);
    this.authorization = credentials.username || credentials.password
      ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
      : undefined;
  }

  private async request(url: URL, method: string, headers: Record<string, string> = {}, body?: Buffer) {
    try {
      return await fetch(url, {
        method,
        headers: this.authorization ? { ...headers, Authorization: this.authorization } : headers,
        body: body && new Uint8Array(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new DataSyncError('连接 WebDAV 失败，请检查地址、证书和网络连接');
    }
  }

  async testConnection(): Promise<void> {
    const response = await this.request(this.base, 'PROPFIND', { Depth: '0' });
    if (response.status !== 207) check(response, '检测目录');
    discard(response);
    await this.getManifest();
  }

  async createDirectory(): Promise<void> {
    const response = await this.request(this.directory, 'MKCOL');
    if (response.status !== 201 && response.status !== 405) check(response, '创建同步目录');
    discard(response);
  }

  async getManifest(): Promise<{ etag: string; body: Buffer } | null> {
    const response = await this.request(new URL('manifest.json', this.directory), 'GET', {
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-cache',
    });
    if (response.status === 404) {
      discard(response);
      return null;
    }
    if (response.status !== 200) check(response, '读取同步清单');
    const etag = response.headers.get('etag');
    if (!etag || !/^"[^"\r\n]*"$/.test(etag)) {
      discard(response);
      throw new DataSyncError('WebDAV 服务器须为同步清单提供可用于条件写入的强 ETag');
    }
    return { etag, body: await readBody(response, MAX_MANIFEST_BYTES) };
  }

  async putManifest(body: Buffer, etag?: string): Promise<void> {
    if (body.length > MAX_MANIFEST_BYTES) throw new DataSyncError('同步清单超出大小限制');
    const condition: Record<string, string> = etag ? { 'If-Match': etag } : { 'If-None-Match': '*' };
    const response = await this.request(new URL('manifest.json', this.directory), 'PUT', {
      ...condition,
      'Content-Type': 'application/json',
    }, body);
    if (response.status === 412) {
      discard(response);
      throw new DataSyncError('远端在同步期间已更新，请重新同步');
    }
    if (!response.ok) check(response, '写入同步清单');
    discard(response);
  }

  async getBlock(hash: string, bytes: number): Promise<Buffer> {
    const response = await this.request(new URL(`block-${hash}.bin`, this.directory), 'GET');
    if (response.status !== 200) check(response, '下载数据块');
    return readBody(response, bytes);
  }

  async putBlock(hash: string, body: Buffer): Promise<void> {
    const response = await this.request(new URL(`block-${hash}.bin`, this.directory), 'PUT', {
      'If-None-Match': '*',
      'Content-Type': 'application/octet-stream',
    }, body);
    if (response.status !== 412 && !response.ok) check(response, '上传数据块');
    discard(response);
  }
}

import type { Server } from 'node:http';
import type { Express } from 'express';

/**
 * 测试专用「空闲端口启动」：undici 的 fetch 会拒绝一组「坏端口」（fetch failed: bad port），
 * 本机 TCP 动态端口范围若覆盖这些端口（Windows 上 winnat/Hyper-V 可能把动态范围挪到
 * 1024–15000，其中含 5060/6000/10080 等十几个坏端口），listen(0) 偶发分到就会让该用例
 * 必挂（flake 与具体用例无关、随端口轮转成簇出现）。这里逐次重试直到拿到干净端口。
 */
const BAD_PORTS = new Set<number>([
  0, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512,
  513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

export async function listenForTest(app: Express): Promise<Server> {
  for (;;) {
    const srv = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      srv.once('listening', () => resolve());
      srv.once('error', reject);
    });
    const port = (srv.address() as { port: number }).port;
    if (!BAD_PORTS.has(port)) return srv;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

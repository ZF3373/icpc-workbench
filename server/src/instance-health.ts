import path from 'node:path';

/**
 * 判定 /api/health 响应是否来自本程序的 SEA 实例（icpc-core.exe）。
 *
 * 必须校验 sea === true：同机可能有开发模式 dev server（sea:false）占着
 * 3001..3020 端口，若只看 ok + platforms，重复启动/端口发现会被它劫持
 * （窗口指向 dev server、或误判"已在运行"而退出）。
 */
export function looksLikeOurInstance(health: unknown): boolean {
  if (typeof health !== 'object' || health === null) return false;
  const h = health as { ok?: unknown; platforms?: unknown; sea?: unknown };
  return h.ok === true && Array.isArray(h.platforms) && h.sea === true;
}

/**
 * 端口上跑的是不是**这一份安装**的本程序实例（issue #66）。
 *
 * 为什么需要比 looksLikeOurInstance 更严：它只回答「是不是本程序」，而同一台机器上
 * 完全可能同时存在两个安装（D 盘便携版 + C 盘安装版、或桌面版 + 手动双击的 icpc-core），
 * 它们各自的 data/ 目录**不同**。只看 sea===true 会把别的安装认成「我已经在运行」，
 * 于是本安装的核心静默退出、页面却指向另一份数据 —— 用户看到的就是「数据没了」。
 *
 * 判据：health 里回报的 dataDir（服务端已按真实解析结果下发）必须与本进程算出的
 * 数据目录一致。老版本服务端不下发 dataDir 时退化为「只认 sea===true」（兼容旧核心）。
 */
export function looksLikeSameInstall(health: unknown, dataDir: string): boolean {
  if (!looksLikeOurInstance(health)) return false;
  const reported = (health as { dataDir?: unknown }).dataDir;
  if (typeof reported !== 'string' || reported === '') return true;
  return path.resolve(reported) === path.resolve(dataDir);
}

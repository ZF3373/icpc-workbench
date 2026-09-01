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

import fs from 'node:fs';

/**
 * 是否运行在 Docker 容器内。
 *
 * 恢复点是「写标记 + 重启生效」，重启在不同部署形态下含义不同：Docker 用户要
 * `docker restart`（或让进程退出由 restart 策略拉起），桌面版要重开应用。前端据此
 * 切换引导文案，服务端据此决定是否暴露「重启容器」端点。
 *
 * 判定（任一成立即可）：
 * - 镜像里显式设置的 ICPC_DOCKER=1（Dockerfile 的 ENV，最可靠，也便于测试）；
 * - 容器运行时自带的 /.dockerenv（自建镜像漏设 ENV 时的兜底，Linux 容器必有）。
 * 桌面版 SEA exe 与 tsx 开发模式两者都不满足 → false。
 */
export function isDockerRuntime(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (env.ICPC_DOCKER === '1') return true;
  try {
    return exists('/.dockerenv');
  } catch {
    return false;
  }
}

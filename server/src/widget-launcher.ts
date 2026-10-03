import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import type { AppConfig } from './config.ts';

/**
 * SEA 启动后自动拉起同目录 widget.exe（桌面挂件）。
 * - dev 模式不拉起（开发者自行 cargo tauri dev）
 * - launchWidget=false 或同目录无 widget.exe：静默跳过
 * - detached 拉起：挂件不随主程序退出；widget.exe 自带 single-instance，重复拉起无害
 * 返回 spawn 是否成功（用于日志，不阻断启动）。
 */
export function tryLaunchWidget(config: AppConfig, port: number): boolean {
  if (!isSea()) return false;
  if (config.launchWidget === false) return false;
  const exe = path.join(path.dirname(process.execPath), 'widget.exe');
  if (!existsSync(exe)) return false;
  try {
    const child = spawn(exe, [`--port=${port}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // spawn 的异步失败（widget.exe 损坏/无执行权限/目录变化）以 'error' 事件发出而非同步 throw，
    // 不挂监听会成为 unhandled 'error' 打崩进程（SEA 分支被 fatal 接管整应用退出）。
    // 挂件拉不起来只应降级为静默跳过，不阻断主程序。
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

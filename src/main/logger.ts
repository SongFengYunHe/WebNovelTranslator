/**
 * 通过 electron-log 统一记录日志。
 *
 * 写入 <userData>/logs/main.log，便于用户在我们出错时发送诊断文件。应用中的每条
 * 错误路径都应经过这里（E3 部分：「All errors logged to file via electron-log」）。
 */
import log from 'electron-log/main';
import { app } from 'electron';

log.initialize();

// 附加 PID 后缀，使崩溃重启后的覆盖可被区分。
log.transports.file.fileName = 'main.log';
log.transports.file.maxSize = 5 * 1024 * 1024; // 上限 5 MB

log.info(`[logger] initialized (pid ${process.pid})`);

export interface LogExitInfo {
  exitCode?: number;
  reason: string;
}

/**
 * 记录应用退出的原因（E2 部分：「Log process exit status」）。由主进程的退出流程
 * 调用。`reason` 是简短标签；`exitCode` 是进程将要退出的数字码（已知时）。
 */
export function logExit(info: LogExitInfo): void {
  if (info.exitCode === undefined) {
    log.info(`[exit] ${info.reason}`);
  } else {
    log.info(`[exit] ${info.reason} (code=${info.exitCode})`);
  }
}

export default log;

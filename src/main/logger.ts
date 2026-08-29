/**
 * Centralized logging via electron-log.
 *
 * Writes to <userData>/logs/main.log so the user can send us a diagnostic file
 * when something goes wrong. Every error path in the app should route through
 * here (Part E3: "All errors logged to file via electron-log").
 */
import log from 'electron-log/main';
import { app } from 'electron';

log.initialize();

// Attach a PID suffix so crash-on-restart overwrites are distinguishable.
log.transports.file.fileName = 'main.log';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB cap

log.info(`[logger] initialized (pid ${process.pid})`);

export interface LogExitInfo {
  exitCode?: number;
  reason: string;
}

/**
 * Record why the app is exiting (Part E2: "Log process exit status"). Called
 * from the main process' shutdown path. `reason` is a short label; `exitCode`
 * is the numeric code the process will exit with, when known.
 */
export function logExit(info: LogExitInfo): void {
  if (info.exitCode === undefined) {
    log.info(`[exit] ${info.reason}`);
  } else {
    log.info(`[exit] ${info.reason} (code=${info.exitCode})`);
  }
}

export default log;

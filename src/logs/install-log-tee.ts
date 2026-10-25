import { ConsoleLogger, Logger, type LoggerService } from '@nestjs/common';
import { RingBuffer } from '../support/ring-buffer.js';
import { LogTee, isLogTee } from './log-tee.js';
import type { LogRecord } from './model.js';

/**
 * `Logger.staticInstanceRef` is protected: it is the logger `Logger.overrideLogger` (and so
 * `app.useLogger` and the `logger` option of `NestFactory.create`) stores, and the one every
 * `new Logger(context)` writes to. A Nest detail stable since v7, read by index access.
 */
function activeLogger(): LoggerService | undefined {
  return (Logger as unknown as { staticInstanceRef?: LoggerService }).staticInstanceRef;
}

/**
 * A plain `new Logger()` set as the app logger makes every `Logger` print through its own
 * `ConsoleLogger`; wrapping it would loop back into the tee. Compared with the `Logger` class this
 * package overrides, which is the same copy by construction.
 */
function isPlainNestLogger(logger: LoggerService): boolean {
  return Object.getPrototypeOf(logger)?.constructor === Logger;
}

/**
 * Installs the tee over the app's active logger, once per process: if the active logger already
 * is a tee, that one is returned, so every instance shares its buffer. If the app replaced the
 * logger since (another app in the same process, a later `useLogger`), a new tee with a new buffer
 * wraps the replacement.
 */
export function installLogTee(bufferSize: number): LogTee {
  const active = activeLogger();
  if (isLogTee(active)) return active;

  const inner = active && isPlainNestLogger(active) ? new ConsoleLogger() : active;
  const tee = new LogTee(inner, new RingBuffer<LogRecord>(bufferSize));
  Logger.overrideLogger(tee);
  return tee;
}

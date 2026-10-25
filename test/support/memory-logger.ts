import type { LoggerService } from '@nestjs/common';

export type LoggerMethod = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

export interface LoggerCall {
  method: LoggerMethod;
  args: unknown[];
}

/**
 * A `LoggerService` that keeps every call exactly as it arrived (method and arguments) and prints
 * nothing, so a test can prove the tee forwards untouched.
 */
export class MemoryLogger implements LoggerService {
  readonly calls: LoggerCall[] = [];
  log(...args: unknown[]) {
    this.calls.push({ method: 'log', args });
  }
  error(...args: unknown[]) {
    this.calls.push({ method: 'error', args });
  }
  warn(...args: unknown[]) {
    this.calls.push({ method: 'warn', args });
  }
  debug(...args: unknown[]) {
    this.calls.push({ method: 'debug', args });
  }
  verbose(...args: unknown[]) {
    this.calls.push({ method: 'verbose', args });
  }
  fatal(...args: unknown[]) {
    this.calls.push({ method: 'fatal', args });
  }
}

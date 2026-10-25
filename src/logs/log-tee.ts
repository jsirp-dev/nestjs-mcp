import type { LoggerService, LogLevel as NestLogLevel } from '@nestjs/common';
import { RingBuffer } from '../support/ring-buffer.js';
import { currentOrigin, pushLog } from './log-origin.js';
import { LOG_LEVELS, type LogLevel, type LogRecord } from './model.js';

const MESSAGE_CAP = 2000;

/** Marks a tee across copies of this package: `instanceof` would not see another copy's class. */
const LOG_TEE = Symbol.for('@jsirp/nestjs-mcp/log-tee');

/** What a logger may expose beyond `LoggerService`; `ConsoleLogger` has it. */
interface LevelAwareLogger extends LoggerService {
  isLevelEnabled?(level: NestLogLevel): boolean;
}

/** Whether a value is a tee installed by this package (any copy of it). */
export function isLogTee(value: unknown): value is LogTee {
  return typeof value === 'object' && value !== null && LOG_TEE in value;
}

function isStackFormat(value: unknown): value is string | undefined {
  if (typeof value !== 'string' && value !== undefined) return false;
  return /^(.)+\n\s+at .+:\d+:\d+/.test(value ?? '');
}

/** Strings as they are; anything else as JSON (or `String`), capped at 2000 characters. */
export function serialise(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    // Circular or otherwise unserialisable.
  }
  return (text ?? String(value)).slice(0, MESSAGE_CAP);
}

/**
 * Splits Nest's `(message, ...optionalParams)` the way `ConsoleLogger` does: a trailing string is
 * the context and, in `error`, the string before it (or a lone stack-shaped second argument) is the
 * stack.
 */
export function splitLogCall(
  level: LogLevel,
  args: unknown[],
): Pick<LogRecord, 'context' | 'message' | 'stack'> {
  let context: string | null = null;
  let stack: string | undefined;
  let messages = args;

  if (level === 'error' && args.length === 2) {
    messages = [args[0]];
    if (isStackFormat(args[1])) stack = args[1];
    else if (typeof args[1] === 'string') context = args[1];
    else messages = args;
  } else {
    const last = args[args.length - 1];
    if (args.length > 1 && typeof last === 'string') {
      context = last;
      messages = args.slice(0, -1);
    }
    if (level === 'error' && messages.length > 1) {
      const candidate = messages[messages.length - 1];
      if (typeof candidate === 'string' || candidate === undefined) {
        stack = candidate;
        messages = messages.slice(0, -1);
      }
    }
  }
  const [first] = messages;
  if (level === 'error' && stack === undefined && first instanceof Error) stack = first.stack;

  const record: Pick<LogRecord, 'context' | 'message' | 'stack'> = {
    context,
    message: messages.map(serialise).join('\n'),
  };
  if (stack !== undefined) record.stack = stack;
  return record;
}

/**
 * The transparent tee: every call is forwarded to the app's own logger exactly as it arrived, and
 * copied to the ring buffer. Nothing is masked, filtered or altered. A level the inner logger
 * reports as disabled (`isLevelEnabled`) is forwarded but not copied, so the buffer mirrors what
 * the logger keeps. With no inner logger (the app passed `logger: false`) it only copies.
 */
export class LogTee implements LoggerService {
  readonly [LOG_TEE] = true;

  constructor(
    readonly inner: LevelAwareLogger | undefined,
    readonly buffer: RingBuffer<LogRecord>,
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.record('log', message, params);
    this.inner?.log(message, ...params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.record('error', message, params);
    this.inner?.error(message, ...params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.record('warn', message, params);
    this.inner?.warn(message, ...params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.record('debug', message, params);
    this.inner?.debug?.(message, ...params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.record('verbose', message, params);
    this.inner?.verbose?.(message, ...params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.record('fatal', message, params);
    this.inner?.fatal?.(message, ...params);
  }

  setLogLevels(levels: NestLogLevel[]): void {
    this.inner?.setLogLevels?.(levels);
  }

  /** The levels the inner logger has on, when it can say (`isLevelEnabled`); otherwise `null`. */
  levels(): LogLevel[] | null {
    const inner = this.inner;
    if (typeof inner?.isLevelEnabled !== 'function') return null;
    return LOG_LEVELS.filter((level) => inner.isLevelEnabled!(level));
  }

  private record(level: LogLevel, message: unknown, params: unknown[]): void {
    try {
      if (this.inner?.isLevelEnabled?.(level) === false) return;
      const record: LogRecord = {
        source: 'nest',
        timestamp: new Date().toISOString(),
        level,
        ...splitLogCall(level, [message, ...params]),
      };
      pushLog(this.buffer, record, currentOrigin());
    } catch {
      // Copying must never break the app's logging.
    }
  }
}

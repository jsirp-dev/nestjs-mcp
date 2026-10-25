import { serialise } from './log-tee.js';
import type { LogLevel, LogRecord } from './model.js';

/**
 * One line of the host's logger, as the sink maps it before it enters the buffer: what
 * `logs.normalize` returns and what the built-in mapping produces. Every field is optional and
 * loosely typed; the sink coerces it.
 */
export interface LogSinkEntry {
  /** A Nest level, a pino/bunyan number (10–60) or a level name (`info`, `warning`, `trace`…). */
  level?: string | number;
  /** Strings as they are; anything else as JSON, capped at 2000 characters. */
  message?: unknown;
  context?: string | null;
  /** Epoch milliseconds, an ISO string or a `Date`; the time the sink received it otherwise. */
  timestamp?: string | number | Date;
  stack?: string;
}

/**
 * Maps a record of another format: a JSON line already parsed, a plain-text line as a string, or
 * what the host passed to `record()`. Return `undefined` to let the built-in mapping handle it.
 */
export type LogNormalizer = (record: unknown) => LogSinkEntry | undefined;

const LEVEL_NAMES: Record<string, LogLevel> = {
  trace: 'verbose',
  silly: 'verbose',
  verbose: 'verbose',
  debug: 'debug',
  info: 'log',
  log: 'log',
  http: 'log',
  notice: 'log',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'fatal',
  crit: 'fatal',
  critical: 'fatal',
  alert: 'fatal',
  emerg: 'fatal',
  emergency: 'fatal',
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * A level of any of the formats the sink reads as Nest's: pino and bunyan numbers by their bands
 * (10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal), names case-insensitively and without
 * colour codes. Anything else is `log`.
 */
export function normalizeLogLevel(level: unknown): LogLevel {
  if (typeof level === 'number' && Number.isFinite(level)) {
    if (level < 20) return 'verbose';
    if (level < 30) return 'debug';
    if (level < 40) return 'log';
    if (level < 50) return 'warn';
    if (level < 60) return 'error';
    return 'fatal';
  }
  if (typeof level === 'string') return LEVEL_NAMES[level.replace(ANSI, '').toLowerCase()] ?? 'log';
  return 'log';
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

/**
 * The built-in mapping. Objects are read as pino, bunyan or winston records (`level`, `msg` or
 * `message`, `time` or `timestamp`, `context` or `name`, the stack of `err`); a string is a
 * plain-text line at `log`.
 */
export function builtInLogEntry(record: unknown): LogSinkEntry {
  if (typeof record === 'string') return { level: 'log', message: record };
  const object = asObject(record);
  if (!object) return { message: record };
  const error = asObject(object.err) ?? asObject(object.error);
  const entry: LogSinkEntry = {
    level: object.level as LogSinkEntry['level'],
    message: object.msg ?? object.message ?? error?.message,
    context: firstString(object.context, object.name) ?? null,
    timestamp: (object.time ?? object.timestamp) as LogSinkEntry['timestamp'],
  };
  const stack = firstString(object.stack, error?.stack);
  if (stack !== undefined) entry.stack = stack;
  return entry;
}

function isoTimestamp(value: unknown): string | undefined {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The entry as the buffer keeps it, `source: 'sink'`. */
export function toSinkRecord(entry: LogSinkEntry, receivedAt: string): LogRecord {
  const record: LogRecord = {
    source: 'sink',
    timestamp: isoTimestamp(entry.timestamp) ?? receivedAt,
    level: normalizeLogLevel(entry.level),
    context: typeof entry.context === 'string' && entry.context !== '' ? entry.context : null,
    message: entry.message === undefined || entry.message === null ? '' : serialise(entry.message),
  };
  if (typeof entry.stack === 'string') record.stack = entry.stack;
  return record;
}

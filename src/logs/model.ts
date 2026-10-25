/** Nest's log levels, least to most severe (the order of `LOG_LEVELS` in `@nestjs/common`). */
export const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Where an entry came from: Nest's `Logger` (the tee) or the host's own logger (the sink). */
export type LogSource = 'nest' | 'sink';

export const LOG_SOURCES: readonly LogSource[] = ['nest', 'sink'];

/**
 * One call that went through Nest's `Logger`, as the tee copied it, or one line of the host's
 * logger, as the sink read it.
 */
export interface LogRecord {
  source: LogSource;
  /** ISO 8601: when the tee received it; for the sink, the line's own time when it has one. */
  timestamp: string;
  level: LogLevel;
  /**
   * The trailing string parameter, as `ConsoleLogger` reads it; for the sink, the record's
   * `context` (or `name`). `null` when there is none.
   */
  context: string | null;
  /** Strings as they are; anything else as JSON, capped at 2000 characters. */
  message: string;
  /**
   * From the tee, `error` only: the multi-line string before the context, or the stack of an
   * `Error`. From the sink, the record's `stack` or `err.stack`, at any level.
   */
  stack?: string;
  /**
   * The id of the request traced when the entry was captured (the correlation header's value or
   * the generated id `requests_list` shows); absent outside a request.
   */
  requestId?: string;
}

/** What `logs_tail` answers per entry. */
export type LogEntry = { seq: number } & LogRecord;

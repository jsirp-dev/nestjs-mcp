/** Nest's log levels, least to most severe (the order of `LOG_LEVELS` in `@nestjs/common`). */
export const LOG_LEVELS = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** One call that went through Nest's `Logger`, as the tee copied it. */
export interface LogRecord {
  /** ISO 8601, when the tee received it. */
  timestamp: string;
  level: LogLevel;
  /** The trailing string parameter, as `ConsoleLogger` reads it; `null` when there is none. */
  context: string | null;
  /** Strings as they are; anything else as JSON, capped at 2000 characters. */
  message: string;
  /** `error` only: the multi-line string before the context, or the stack of an `Error`. */
  stack?: string;
}

/** What `logs_tail` answers per entry. */
export type LogEntry = { seq: number } & LogRecord;

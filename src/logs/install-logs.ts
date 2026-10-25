import type { ResolvedNestMcpOptions } from '../nest-mcp.options.js';
import { RingBuffer } from '../support/ring-buffer.js';
import { installLogTee } from './install-log-tee.js';
import {
  connectLogSink,
  disconnectLogSink,
  logSinkStats,
  type LogSink,
  type LogSinkStats,
} from './log-sink.js';
import type { LogTee } from './log-tee.js';
import type { LogLevel, LogRecord } from './model.js';

/** What the `logs` tools read: one buffer, filled by the tee, the sink or both. */
export interface LogsInspector {
  readonly capture: ResolvedNestMcpOptions['logs']['capture'];
  readonly buffer: RingBuffer<LogRecord>;
  /** The levels Nest's logger has on, when the tee is installed and the logger can say. */
  levels(): LogLevel[] | null;
  /** The sink's counters, when this instance reads one. */
  sink(): LogSinkStats | null;
  /** Stops feeding the buffer from the sink; the tee stays, as it is process-wide. */
  uninstall(): void;
}

/**
 * Installs what `logs.capture` asks for: the process-wide tee over Nest's `Logger` (shared, see
 * `installLogTee`) and the host's sink, connected to the tee's buffer so both share one `seq`, or
 * to a buffer of its own with `capture: 'sink'`. A sink another instance already connected keeps
 * its buffer, so every instance of the app reads the same.
 */
export function installLogs(options: ResolvedNestMcpOptions['logs']): LogsInspector {
  const tee: LogTee | undefined =
    options.capture === 'sink' ? undefined : installLogTee(options.bufferSize);
  const sink: LogSink | undefined = options.capture === 'nest' ? undefined : options.sink;
  const buffer = sink
    ? connectLogSink(sink, {
        buffer: tee?.buffer,
        size: options.bufferSize,
        normalize: options.normalize,
      })
    : (tee?.buffer ?? new RingBuffer<LogRecord>(options.bufferSize));

  return {
    capture: options.capture,
    buffer,
    levels: () => tee?.levels() ?? null,
    sink: () => (sink ? logSinkStats(sink) : null),
    uninstall: () => {
      if (sink) disconnectLogSink(sink, buffer);
    },
  };
}

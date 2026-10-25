import { Writable } from 'node:stream';
import { RingBuffer } from '../support/ring-buffer.js';
import type { LogRecord } from './model.js';
import {
  builtInLogEntry,
  toSinkRecord,
  type LogNormalizer,
  type LogSinkEntry,
} from './normalize.js';

/** What the sink holds before an instance connects it; the oldest goes first beyond this. */
const PENDING_CAP = 1000;

/** Marks a sink and its internals across copies of this package: `instanceof` would not see them. */
const LOG_SINK = Symbol.for('@jsirp/nestjs-mcp/log-sink');
const CONNECT = Symbol.for('@jsirp/nestjs-mcp/log-sink.connect');
const DISCONNECT = Symbol.for('@jsirp/nestjs-mcp/log-sink.disconnect');
const STATS = Symbol.for('@jsirp/nestjs-mcp/log-sink.stats');

/** What `logs_levels` reports about the sink. */
export interface LogSinkStats {
  /** Whether an instance is reading it now. */
  connected: boolean;
  /** Lines and records it received, connected or not. */
  received: number;
  /** Failures it swallowed (a throwing `logs.normalize`, an unreadable chunk…). */
  errors: number;
  /** The message of the latest of them. */
  lastError?: string;
}

/** Where an instance connects the sink. */
export interface LogSinkTarget {
  /** The buffer to feed (the tee's); without one, the sink's current one or a new one. */
  buffer: RingBuffer<LogRecord> | undefined;
  /** The size of a new buffer. */
  size: number;
  normalize: LogNormalizer | undefined;
}

interface Connection {
  buffer: RingBuffer<LogRecord>;
  normalize: LogNormalizer | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the host attaches to its own logger so `logs_tail` sees that logger's lines: a writable
 * (one entry per line: pino and bunyan JSON, or plain text) plus `record(entry)` for loggers that
 * hand over objects, such as a winston transport. It only reads: the logger's other outputs get
 * exactly what they got before. It never throws into the logger and never emits `error`; what
 * fails is swallowed and counted.
 */
export class LogSink extends Writable {
  readonly [LOG_SINK] = true;
  private connection: Connection | undefined;
  private pending: Array<{ record: unknown; receivedAt: string }> = [];
  private readonly stats: LogSinkStats = { connected: false, received: 0, errors: 0 };

  constructor() {
    super({ decodeStrings: false });
    // An `error` without a listener would crash the process; the sink never fails its logger.
    this.on('error', (error) => this.fail(error));
  }

  /**
   * One record of the host's logger, as an object (`{ level, message, context }`) or a line, read
   * like a line written to the stream.
   */
  record(entry: unknown): void {
    try {
      this.receive(entry);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Reads the chunk at once, whatever the stream's state: no buffering, no backpressure, and a
   * write after `end` (a piped source that finished) is read like any other, never an `error`.
   */
  override write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== '') this.receive(line);
      }
    } catch (error) {
      this.fail(error);
    }
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') {
      try {
        done();
      } catch (error) {
        this.fail(error);
      }
    }
    return true;
  }

  override _write(chunk: unknown, encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.write(chunk, encoding);
    done();
  }

  [CONNECT](target: LogSinkTarget): RingBuffer<LogRecord> {
    const current = this.connection;
    if (current && (target.buffer === undefined || target.buffer === current.buffer)) {
      return current.buffer;
    }
    const buffer = target.buffer ?? new RingBuffer<LogRecord>(target.size);
    this.connection = { buffer, normalize: target.normalize };
    const pending = this.pending;
    this.pending = [];
    for (const { record, receivedAt } of pending) this.deliver(record, receivedAt);
    return buffer;
  }

  [DISCONNECT](buffer: RingBuffer<LogRecord>): void {
    if (this.connection?.buffer === buffer) this.connection = undefined;
  }

  [STATS](): LogSinkStats {
    return { ...this.stats, connected: this.connection !== undefined };
  }

  private receive(record: unknown): void {
    this.stats.received += 1;
    const receivedAt = new Date().toISOString();
    if (this.connection) {
      this.deliver(record, receivedAt);
      return;
    }
    this.pending.push({ record, receivedAt });
    if (this.pending.length > PENDING_CAP) this.pending.shift();
  }

  /** Lines are parsed here, not on arrival, so a sink nobody connected costs little. */
  private deliver(received: unknown, receivedAt: string): void {
    const connection = this.connection!;
    const record = typeof received === 'string' ? parseLine(received) : received;
    let entry: LogSinkEntry | undefined;
    if (connection.normalize) {
      try {
        entry = connection.normalize(record);
      } catch (error) {
        this.fail(error);
      }
    }
    try {
      connection.buffer.push(toSinkRecord(entry ?? builtInLogEntry(record), receivedAt));
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.stats.errors += 1;
    try {
      this.stats.lastError = errorMessage(error);
    } catch {
      this.stats.lastError = 'unreadable error';
    }
  }
}

/** A JSON object line parsed; anything else, the line as it is. */
function parseLine(line: string): unknown {
  if (!line.trimStart().startsWith('{')) return line;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? parsed : line;
  } catch {
    return line;
  }
}

/**
 * Creates the sink the host adds to its logger's outputs (pino `multistream`, a winston transport
 * that calls `record`…) and passes as `logs.sink`. Create it before the logger: what arrives before
 * the inspector connects it is held (up to 1000 entries) and delivered then.
 */
export function createLogSink(): LogSink {
  return new LogSink();
}

/** Whether a value is a sink created by this package (any copy of it). */
export function isLogSink(value: unknown): value is LogSink {
  return typeof value === 'object' && value !== null && LOG_SINK in value;
}

/** Connects the sink to a buffer and answers the one it feeds. */
export function connectLogSink(sink: LogSink, target: LogSinkTarget): RingBuffer<LogRecord> {
  return sink[CONNECT](target);
}

/** Stops feeding `buffer`, if the sink was; what arrives later is held again. */
export function disconnectLogSink(sink: LogSink, buffer: RingBuffer<LogRecord>): void {
  sink[DISCONNECT](buffer);
}

export function logSinkStats(sink: LogSink): LogSinkStats {
  return sink[STATS]();
}
